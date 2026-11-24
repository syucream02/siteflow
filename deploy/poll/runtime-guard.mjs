import { exactFields, need, isTime } from './contract.mjs';
import { checkCandidate } from './check.mjs';
import { readReleaseArchive } from './archive.mjs';
import { validateWorkflowPolicy } from './workflow-policy.mjs';
import { validatePersistentModel } from './persistent-state.mjs';
import { sameSlot, validateNextSlot } from './switch-plan.mjs';
import { assessLinuxStorage } from './linux-storage.mjs';

// 既存の検証を再利用するが、呼び出し元の応答/観測は本物と証明できない。
// 合格時も executionAllowed:false。authorized/token/実コマンドを返す入口はない。
export async function assessRuntimeGuard(input, now) {
  try {
    exactFields(input, ['stage', 'githubData', 'workflow', 'storage', 'state', 'host'], 'INVALID_GUARD_INPUT');
    // await中に呼び出し元が配列・バイト列を書き換える競合を避ける。
    const d = structuredClone(input);
    need(isTime(now) && ['before_consume', 'before_create', 'before_switch', 'before_commit'].includes(d.stage), 'INVALID_GUARD_STAGE');
    const result = checkCandidate(d.githubData, now), record = d.githubData.record;
    validateWorkflowPolicy(d.githubData.responses.workflow, record.sha, d.workflow.files, d.workflow.policy);
    const artifacts = d.githubData.responses.artifacts.artifacts;
    const artifact = artifacts.find(a => String(a.id) === result.artifactId);
    const parsed = await readReleaseArchive(d.githubData.archiveBytes, artifact);
    need(JSON.stringify(parsed.record) === JSON.stringify(record), 'ZIP_JSON_RECORD_MISMATCH');
    assessLinuxStorage(d.storage.policy, d.storage.observation);
    const state = validatePersistentModel(d.state), h = d.host;
    exactFields(h, ['observedAt', 'permissionValue', 'mainSha', 'paused', 'incident', 'residualLock', 'lock', 'dockerHealthy', 'nginxHealthy', 'mysqlHealthy', 'rollback', 'image'], 'INVALID_HOST_OBSERVATION');
    exactFields(h.lock, ['held', 'releaseId', 'workspaceId', 'revision'], 'INVALID_LOCK_OBSERVATION');
    need(isTime(h.observedAt) && h.observedAt <= now && now - h.observedAt <= 5 && h.permissionValue === 'true' && h.mainSha === record.sha &&
      h.paused === false && h.incident === false && h.residualLock === false && state.phase !== 'incident' &&
      h.dockerHealthy === true && h.nginxHealthy === true && h.mysqlHealthy === true && h.lock.held === true &&
      h.lock.releaseId === result.releaseId && h.lock.workspaceId === state.workspaceId && h.lock.revision === state.revision, 'RUNTIME_STOP_OR_UNKNOWN');
    const beforeIds = d.githubData.input.consumedIds;
    if (d.stage === 'before_consume') {
      need(['idle', 'committed'].includes(state.phase) && !state.consumedIds.includes(result.releaseId) &&
        JSON.stringify(state.consumedIds) === JSON.stringify(beforeIds), 'RELEASE_ALREADY_USED_OR_BUSY');
    } else {
      const phases = { before_create: ['preparing'], before_switch: ['candidate_ready'], before_commit: ['verifying', 'committing'] };
      need(phases[d.stage].includes(state.phase) && state.activeReleaseId === result.releaseId &&
        JSON.stringify(state.consumedIds) === JSON.stringify([...beforeIds, result.releaseId]), 'ACTIVE_RESERVATION_MISMATCH');
    }
    exactFields(h.rollback, ['slot', 'running', 'ready', 'configHash'], 'INVALID_ROLLBACK_OBSERVATION');
    validateNextSlot(h.rollback.slot);
    need(sameSlot(h.rollback.slot, state.stable) && h.rollback.running === true && h.rollback.ready === true &&
      typeof h.rollback.configHash === 'string' && /^[a-f0-9]{64}$/.test(h.rollback.configHash) && !/^0+$/.test(h.rollback.configHash), 'PREVIOUS_NEXTJS_NOT_VERIFIED');
    exactFields(h.image, ['repository', 'digest', 'revision', 'schemaHash', 'schemaSourceDigest'], 'INVALID_RUNTIME_IMAGE');
    need(h.image.repository === record.imageRepository && h.image.digest === record.digest && h.image.revision === record.sha &&
      h.image.schemaHash === record.schemaHash && h.image.schemaSourceDigest === record.digest, 'RUNTIME_IMAGE_MISMATCH');
    // committedのcandidateは前回確定した版。今回IDの消費前には比較しない。
    // 消費後はconsumeがcandidateをnullへ戻し、今回の候補だけを照合する。
    if (d.stage !== 'before_consume' && state.candidate !== null) need(state.candidate.image === `${record.imageRepository}@${record.digest}`, 'SAVED_CANDIDATE_MISMATCH');
    return { status: 'mock_runtime_consistent', executionAllowed: false, stage: d.stage, releaseId: result.releaseId,
      pendingChecks: ['authenticated_fresh_github_handoff', 'actual_linux_observations_and_lock_ownership', 'recheck_permission_before_each_side_effect', 'stop_switch_and_cutover_race', 'durable_commit_reconciliation'] };
  } catch {
    // API本文、設定本文、秘密値、元の例外は返さない。
    return { status: 'rejected', executionAllowed: false, reason: 'RUNTIME_GUARD_REJECTED' };
  }
}
