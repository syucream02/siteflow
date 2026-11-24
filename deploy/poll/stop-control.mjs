import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { exactFields, isTime, need } from './contract.mjs';
import { decodeStrictJson } from './transport.mjs';
import { assertLocalDirectory, readLocalFile, writeExclusiveLocal, syncLocalDirectory } from './lock.mjs';

// ローカル一時領域専用。配信lockを取得しない、追記型・解除入口なしの制御路。
// 本番のroot/ACL、電源断耐性、停止完了の証明はこのAPIでは提供しない。
const sha = value => createHash('sha256').update(value).digest('hex');
const id = /^[a-f0-9]{64}$/;
function binding(root, workspaceId) {
  need(id.test(workspaceId), 'INVALID_STOP_WORKSPACE');
  const workspace = decodeStrictJson(Buffer.from(readLocalFile(path.join(root, 'workspace.json'), 4096)));
  exactFields(workspace, ['version', 'workspaceId']);
  need(workspace.version === 1 && workspace.workspaceId === workspaceId, 'STOP_WORKSPACE_MISMATCH');
  const b = decodeStrictJson(Buffer.from(readLocalFile(path.join(root, 'stop-binding.json'), 4096)));
  exactFields(b, ['version', 'mode', 'workspaceId', 'nonce']);
  need(b.version === 1 && b.mode === 'local-test-only' && b.workspaceId === workspaceId && id.test(b.nonce), 'INVALID_STOP_BINDING');
  return b;
}
export function initializeLocalStopControl(directory, workspaceId) {
  const root = assertLocalDirectory(directory);
  need(id.test(workspaceId) && fs.readdirSync(root).every(n => ['release.lock', 'workspace.json'].includes(n)), 'STOP_INITIALIZATION_NOT_FRESH');
  // 初回の模擬状態だけclear。既存状態・停止要求の上書き/リセットには使えない。
  writeExclusiveLocal(path.join(root, 'stop-binding.json'), JSON.stringify({ version: 1, mode: 'local-test-only', workspaceId, nonce: randomBytes(32).toString('hex') }));
  syncLocalDirectory(root); binding(root, workspaceId);
}
export function openLocalStopReader(directory, workspaceId) {
  const root = assertLocalDirectory(directory), initial = binding(root, workspaceId);
  const initialText = JSON.stringify(initial);
  function read() {
    try {
      assertLocalDirectory(root);
      need(JSON.stringify(binding(root, workspaceId)) === initialText, 'STOP_BINDING_CHANGED');
      const names = () => fs.readdirSync(root).filter(n => n.startsWith('stop-request-') || n.startsWith('stop-failed-')).sort();
      const before = names(); need(before.length <= 1024, 'STOP_RECORD_LIMIT');
      const requests = [];
      for (const name of before) {
        need(/^stop-request-[a-f0-9]{64}\.json$/.test(name), 'STOP_WRITE_FAILED_OR_CORRUPT');
        const r = decodeStrictJson(Buffer.from(readLocalFile(path.join(root, name), 4096)));
        exactFields(r, ['version', 'workspaceId', 'bindingNonce', 'requestId', 'requestedAt', 'reason']);
        need(r.version === 1 && r.workspaceId === workspaceId && r.bindingNonce === initial.nonce && id.test(r.requestId) &&
          name === `stop-request-${r.requestId}.json` && isTime(r.requestedAt) && r.reason === 'operator_request', 'INVALID_STOP_REQUEST');
        requests.push(r.requestId);
      }
      need(JSON.stringify(names()) === JSON.stringify(before), 'STOP_CHANGED_DURING_READ');
      return { status: requests.length ? 'requested' : 'clear', requestIds: requests, fingerprint: sha(initialText + JSON.stringify(before)),
        executionAllowed: false, workerStopped: 'unconfirmed' };
    } catch { return { status: 'unknown', requestIds: [], executionAllowed: false, workerStopped: 'unconfirmed' }; }
  }
  return Object.freeze({ mode: 'local-test-only', executionAllowed: false, read,
    assertClear() { const latest = read(); need(latest.status === 'clear', 'STOP_REQUESTED_OR_UNKNOWN'); return latest; } });
}
export function openLocalStopRequester(directory, workspaceId, { now, fault = () => {} }) {
  const root = assertLocalDirectory(directory), initial = binding(root, workspaceId);
  need(typeof now === 'function' && typeof fault === 'function', 'INVALID_STOP_REQUESTER');
  return Object.freeze({ mode: 'local-test-only', executionAllowed: false, requestStop() {
    const requestId = randomBytes(32).toString('hex');
    try {
      need(JSON.stringify(binding(root, workspaceId)) === JSON.stringify(initial), 'STOP_BINDING_CHANGED');
      const requestedAt = now(); need(isTime(requestedAt), 'INVALID_STOP_TIME');
      const text = JSON.stringify({ version: 1, workspaceId, bindingNonce: initial.nonce, requestId, requestedAt, reason: 'operator_request' });
      fault('before_stop_write');
      writeExclusiveLocal(path.join(root, `stop-request-${requestId}.json`), text);
      fault('after_stop_write'); syncLocalDirectory(root); fault('after_stop_sync');
      need(readLocalFile(path.join(root, `stop-request-${requestId}.json`), 4096) === text, 'STOP_READBACK_FAILED');
      return { requestRecorded: true, requestId, executionAllowed: false, workerStopped: 'unconfirmed',
        durability: process.platform === 'win32' ? 'directory-fsync-unverified' : 'fsync-not-powerloss-tested' };
    } catch {
      // 不完全ファイル/失敗マーカーはreaderがunknownとして拒否。全部の保存が失敗した
      // 要求は配信側へ届いたとは保証できない。成功を返さず、別の管理経路の確認が必要。
      try { fault('before_failure_latch'); writeExclusiveLocal(path.join(root, `stop-failed-${requestId}.json`), '{}'); syncLocalDirectory(root); } catch { /* 成功を偽装しない。 */ }
      throw new Error('STOP_NOT_CONFIRMED');
    }
  } });
}
export function stopActionAtPhase(status, phase) {
  need(['clear', 'requested', 'unknown'].includes(status), 'INVALID_STOP_STATUS');
  if (status === 'clear') return { requiredAction: 'continue_model_only', executionAllowed: false };
  return { requiredAction: phase === 'committed' ? 'keep_committed_block_new' :
    ['switching', 'verifying', 'committing', 'rolling_back'].includes(phase) ? 'reconcile_or_rollback' : 'abort_before_switch', executionAllowed: false };
}
