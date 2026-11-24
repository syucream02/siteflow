import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as contract from '../deploy/poll/contract.mjs';
import * as stateApi from '../deploy/poll/state.mjs';

// すべて架空のローカルデータ。API応答・署名・本人承認の証明ではない。
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const MIGRATION = `sha256:${'c'.repeat(64)}`;
const SCHEMA = 'd'.repeat(64);
const NOW = 120;
function record() {
  return { schemaVersion: 1, repository: contract.REPOSITORY, workflow: contract.WORKFLOW,
    sha: SHA, runId: '101', attempt: '1', imageRepository: contract.IMAGE_REPOSITORY,
    digest: DIGEST, migrationDigest: MIGRATION, schemaHash: SCHEMA, approved: true };
}
function input() {
  return { repository: contract.REPOSITORY, branch: 'main', mainSha: SHA,
    runId: '101', attempt: '1', artifactId: '202', artifactCreatedAt: 100,
    permissionUpdatedAt: 90, expiresAt: 200, releaseEnabled: 'true', consumedIds: [],
    image: { repository: contract.IMAGE_REPOSITORY, digest: DIGEST, revision: SHA },
    migration: { repository: contract.IMAGE_REPOSITORY, digest: MIGRATION, revision: SHA },
    schemaHash: SCHEMA, migrationRequired: false };
}
const initial = () => ({ kind: 'nextjs', container: 'siteflow-next-candidate', port: 3001,
  image: `sha256:${'e'.repeat(64)}` });
const candidate = (port = 3101) => ({ kind: 'nextjs', container: `siteflow-test-${port}`, port,
  image: `${contract.IMAGE_REPOSITORY}@${DIGEST}` });
const authorize = (r = record(), i = input()) => ({ type: 'authorize', record: r, input: i });

// 本番exportにテスト専用入口を追加しない。対象ソースを読み、隔離VM内だけで
// 非公開の純粋モデルを取得する。process/require/通信/ファイル書込はVMへ渡さない。
const stateSource = readFileSync(new URL('../deploy/poll/state.mjs', import.meta.url), 'utf8');
assert.match(stateSource, /^import \{[^\n]+\} from '\.\/contract\.mjs';\r?\n/);
const modelSource = stateSource.replace(/^import [^\n]+\r?\n/, '').replace(/^export /gm, '');
const internalModel = vm.runInNewContext(`${modelSource}\ntransitionModel;`, {
  assessRelease: contract.assessRelease, exactFields: contract.exactFields,
  isDigest: contract.isDigest, isTime: contract.isTime, need: contract.need,
  releaseIdentity: contract.releaseIdentity, structuredClone,
}, { timeout: 1000 });
const simulate = (state, event, now = NOW) => JSON.parse(JSON.stringify(internalModel(state, event, now)));
function at(status) {
  let s = stateApi.createState(initial(), 90);
  if (status === 'idle') return s;
  for (const event of [authorize(), { type: 'prepare' }, { type: 'candidate_passed', candidate: candidate() },
    { type: 'switch' }, { type: 'switched' }, { type: 'commit' }]) {
    s = simulate(s, event);
    if (s.status === status) return s;
  }
  throw new Error('UNKNOWN_FIXTURE_STATE');
}

test('正常形式でも外部検証待ちであり、実配信許可は返さない', () => {
  const r = record(), i = input(), before = structuredClone({ r, i });
  const result = contract.assessRelease(r, i, NOW);
  assert.equal(result.localChecks, 'passed');
  assert.equal(result.status, 'external_verification_required');
  assert.equal(result.executionAllowed, false);
  assert.equal(result.releaseId, 'used-101-a1');
  assert.equal(result.pendingChecks.length, 5);
  assert.deepEqual({ r, i }, before);
});

for (const key of Object.keys(record())) {
  test(`承認JSONの必須項目不足を拒否: ${key}`, () => {
    const r = record(); delete r[key];
    assert.throws(() => contract.assessRelease(r, input(), NOW), /INVALID_RECORD_FIELDS/);
  });
}
for (const key of Object.keys(input())) {
  test(`別入力の必須項目不足を拒否: ${key}`, () => {
    const i = input(); delete i[key];
    assert.throws(() => contract.assessRelease(record(), i, NOW), /INVALID_INPUT_FIELDS/);
  });
}
for (const [name, edit] of [
  ['別リポジトリ', i => { i.repository = 'other/repo'; }],
  ['main以外', i => { i.branch = 'feature'; }],
  ['main SHA不一致', i => { i.mainSha = 'f'.repeat(40); }],
  ['run不一致', i => { i.runId = '102'; }],
  ['attempt不一致', i => { i.attempt = '2'; }],
  ['数値artifact ID', i => { i.artifactId = 202; }],
  ['ゼロartifact ID', i => { i.artifactId = '0'; }],
  ['巨大artifact ID', i => { i.artifactId = '1'.repeat(21); }],
  ['digest不一致', i => { i.image.digest = MIGRATION; }],
  ['migration digest不一致', i => { i.migration.digest = DIGEST; }],
  ['revision不一致', i => { i.image.revision = 'f'.repeat(40); }],
  ['migration revision不一致', i => { i.migration.revision = 'f'.repeat(40); }],
  ['別イメージrepo', i => { i.image.repository = 'other/image'; }],
  ['schema不一致', i => { i.schemaHash = 'f'.repeat(64); }],
  ['期限切れ', i => { i.expiresAt = NOW; }],
  ['未来のartifact', i => { i.artifactCreatedAt = NOW + 1; }],
  ['1時間を超える許可', i => { i.expiresAt = 3701; }],
  ['許可変更より古い承認', i => { i.permissionUpdatedAt = 100; }],
  ['時刻の文字列', i => { i.expiresAt = '200'; }],
  ['配信禁止', i => { i.releaseEnabled = 'false'; }],
  ['boolean許可', i => { i.releaseEnabled = true; }],
  ['消費済み', i => { i.consumedIds = ['used-101-a1']; }],
  ['不明な消費ID', i => { i.consumedIds = ['unknown']; }],
  ['重複消費記録', i => { i.consumedIds = ['used-102-a1', 'used-102-a1']; }],
  ['migration必要', i => { i.migrationRequired = true; }],
  ['migration未確認', i => { i.migrationRequired = null; }],
  ['verified boolean追加', i => { i.verified = true; }],
  ['外部検証済み文字列追加', i => { i.externalVerification = 'verified'; }],
  ['未知のimage項目', i => { i.image.command = 'anything'; }],
]) {
  test(`形式・整合性の異常を拒否: ${name}`, () => {
    const i = input(); edit(i);
    assert.throws(() => contract.assessRelease(record(), i, NOW));
  });
}
test('許可期限の直前は形式合格、期限ちょうどは拒否', () => {
  assert.equal(contract.assessRelease(record(), input(), 199).executionAllowed, false);
  assert.throws(() => contract.assessRelease(record(), input(), 200), /APPROVAL_EXPIRED/);
  const i = input(); i.expiresAt = 3700;
  assert.equal(contract.assessRelease(record(), i, NOW).localChecks, 'passed');
});
for (const now of [undefined, NaN, Infinity, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
  test(`不正な注入時刻を拒否: ${String(now)}`, () => {
    assert.throws(() => contract.assessRelease(record(), input(), now), /INVALID_NOW/);
  });
}
test('JSONにない項目・未知のschemaVersion・型・ゼロSHAを拒否', () => {
  for (const change of [{ extra: true }, { schemaVersion: 2 }, { approved: false },
    { sha: '0'.repeat(40) }, { runId: 101 }, { digest: 'latest' }, { schemaHash: '0'.repeat(64) }]) {
    assert.throws(() => contract.assessRelease({ ...record(), ...change }, input(), NOW));
  }
});
test('getter・symbol・配列・独自prototypeを拒否し、getterを実行しない', () => {
  let called = false;
  const r = record(); Object.defineProperty(r, 'sha', { enumerable: true, get() { called = true; return SHA; } });
  assert.throws(() => contract.assessRelease(r, input(), NOW));
  assert.equal(called, false);
  for (const bad of [null, [], { ...record(), [Symbol('extra')]: 1 }, Object.assign(Object.create({}), record())]) {
    assert.throws(() => contract.assessRelease(bad, input(), NOW));
  }
});
test('artifact差し替えでも同じrun/attemptの消費IDは変化しない', () => {
  const i = input(); i.artifactId = '999'; i.consumedIds = ['used-101-a1'];
  assert.throws(() => contract.assessRelease(record(), i, NOW), /ALREADY_CONSUMED/);
});

test('公開APIは未検証入力・形式合格結果・模擬active状態を拒否する', () => {
  const idle = at('idle');
  assert.throws(() => stateApi.transitionState(idle, authorize(), NOW), /EXTERNAL_VERIFICATION_NOT_IMPLEMENTED/);
  assert.throws(() => stateApi.transitionState(idle,
    { type: 'authorize', verified: true, result: contract.assessRelease(record(), input(), NOW) }, NOW), /EXTERNAL_VERIFICATION_NOT_IMPLEMENTED/);
  for (const status of ['authorized', 'preparing', 'candidate_ready', 'switching', 'verifying', 'committed']) {
    assert.throws(() => stateApi.transitionState(at(status), { type: 'check' }, NOW), /EXTERNAL_VERIFICATION_NOT_IMPLEMENTED/);
  }
  assert.deepEqual(Object.keys(stateApi).sort(), ['createState', 'transitionState']);
});
test('初期3001番Next.jsを保持し、入力を変更しない', () => {
  const slot = initial(), before = structuredClone(slot);
  const s = stateApi.createState(slot, NOW);
  assert.equal(s.status, 'idle'); assert.equal(s.current.port, 3001);
  s.current.port = 3101; assert.deepEqual(slot, before);
});
test('3002番Vinextや未知ポートを初期復旧対象にできない', () => {
  for (const slot of [{ ...initial(), port: 3002 }, { ...initial(), kind: 'vinext' }, { ...initial(), port: 3000 }]) {
    assert.throws(() => stateApi.createState(slot, NOW), /NEXTJS_PORT_REQUIRED/);
  }
});
test('模擬試験: 正常遷移と確定後の直前Next.js保持', () => {
  const original = at('idle'), before = structuredClone(original);
  let s = simulate(original, authorize());
  for (const [event, expected] of [[{ type: 'prepare' }, 'preparing'],
    [{ type: 'candidate_passed', candidate: candidate() }, 'candidate_ready'],
    [{ type: 'switch' }, 'switching'], [{ type: 'switched' }, 'verifying'], [{ type: 'commit' }, 'committed']]) {
    s = simulate(s, event); assert.equal(s.status, expected); assert.equal(s.executionAllowed, false);
  }
  assert.equal(s.current.port, 3101); assert.equal(s.previous.port, 3001);
  assert.deepEqual(s.consumedIds, ['used-101-a1']); assert.deepEqual(original, before);
});
test('模擬試験: 3101から3102へ次版を配信し、3101を復旧用に保持', () => {
  let s = at('committed'); const r = record(); r.runId = '102';
  const i = input(); i.runId = '102'; i.consumedIds = [...s.consumedIds];
  s = simulate(s, authorize(r, i)); s = simulate(s, { type: 'prepare' });
  s = simulate(s, { type: 'candidate_passed', candidate: candidate(3102) });
  for (const type of ['switch', 'switched', 'commit']) s = simulate(s, { type });
  assert.equal(s.current.port, 3102); assert.equal(s.previous.port, 3101);
});
for (const [status, type] of [['idle', 'prepare'], ['authorized', 'commit'], ['preparing', 'switch'],
  ['candidate_ready', 'commit'], ['switching', 'commit'], ['verifying', 'prepare'], ['committed', 'switched']]) {
  test(`模擬試験: 不正遷移 ${status} -> ${type} を拒否`, () => {
    assert.throws(() => simulate(at(status), { type }));
  });
}
test('模擬試験: 同時authorize・消費済みID・履歴のすり替えを拒否', () => {
  assert.throws(() => simulate(at('authorized'), authorize()), /INVALID_TRANSITION/);
  const s = at('committed'), i = input(); i.consumedIds = [...s.consumedIds];
  assert.throws(() => simulate(s, authorize(record(), i)), /ALREADY_CONSUMED/);
  assert.throws(() => simulate(s, authorize()), /HISTORY_MISMATCH/);
});
test('模擬試験: 候補のdigest・ポート・名前の不一致を拒否', () => {
  for (const c of [{ ...candidate(), image: `${contract.IMAGE_REPOSITORY}@${MIGRATION}` },
    { ...candidate(), port: 3002 }, { ...candidate(), port: 3001 },
    { ...candidate(), container: initial().container }]) {
    assert.throws(() => simulate(at('preparing'), { type: 'candidate_passed', candidate: c }));
  }
});
for (const status of ['authorized', 'preparing', 'candidate_ready', 'switching', 'verifying']) {
  test(`模擬試験: ${status}で期限切れ・取消・失敗を安全側へ遷移`, () => {
    for (const [event, now] of [[{ type: 'check' }, 200], [{ type: 'revoke' }, NOW], [{ type: 'fail' }, NOW]]) {
      const s = simulate(at(status), event, now);
      const rollback = ['switching', 'verifying'].includes(status);
      assert.equal(s.status, rollback ? 'rolling_back' : 'incident');
      assert.equal(s.requiredAction, rollback ? 'rollback' : 'manual_review');
      assert.equal(s.current.port, 3001); assert.equal(s.executionAllowed, false);
    }
  });
}
test('模擬試験: 切り替え失敗は期限後でも旧Next.jsへ復旧し、事故状態を保持', () => {
  let s = simulate(at('verifying'), { type: 'fail' });
  s = simulate(s, { type: 'rollback_confirmed' }, 201);
  assert.equal(s.current.port, 3001); assert.equal(s.status, 'incident');
  assert.equal(s.reason, 'ROLLED_BACK_REVIEW_REQUIRED');
  assert.throws(() => simulate(s, authorize(), 202), /INCIDENT_REQUIRES_MANUAL_REVIEW/);
  assert.throws(() => stateApi.transitionState(s, { type: 'reset' }, 202), /INCIDENT_REQUIRES_MANUAL_REVIEW/);
});
test('模擬試験: 復旧失敗と強制終了はincidentとなり、自動再開しない', () => {
  const failed = simulate(simulate(at('switching'), { type: 'fail' }), { type: 'rollback_failed' });
  assert.equal(failed.reason, 'ROLLBACK_FAILED'); assert.equal(failed.status, 'incident');
  for (const status of ['authorized', 'preparing', 'candidate_ready', 'switching', 'verifying']) {
    const crashed = simulate(at(status), { type: 'crash' });
    assert.equal(crashed.status, 'incident'); assert.equal(crashed.reason, 'OUTCOME_UNKNOWN');
    assert.throws(() => simulate(crashed, { type: 'prepare' }), /INCIDENT_REQUIRES_MANUAL_REVIEW/);
  }
});
test('模擬試験: 復旧対象がVinextに改変された状態を拒否', () => {
  const s = simulate(at('switching'), { type: 'fail' }); s.previous.port = 3002;
  assert.throws(() => simulate(s, { type: 'rollback_confirmed' }), /NEXTJS_PORT_REQUIRED/);
});
test('模擬試験: 時刻逆行・未知イベント・migration操作を拒否', () => {
  assert.throws(() => simulate(at('preparing'), { type: 'check' }, 119), /CLOCK_MOVED_BACKWARD/);
  for (const type of ['migrate', 'db-push', 'reset', 'unknown']) {
    assert.throws(() => simulate(at('preparing'), { type }), /INVALID_TRANSITION/);
  }
  assert.throws(() => simulate(at('preparing'), { type: 'check', verified: true }), /INVALID_EVENT_FIELDS/);
});

test('模擬試験: 読み戻し状態の未知フィールド・schema・消費履歴の矛盾を拒否', () => {
  for (const edit of [s => { s.extra = true; }, s => { s.release.input.extra = true; },
    s => { s.release.input.schemaHash = 'f'.repeat(64); },
    s => { s.consumedIds = []; }, s => { s.consumedIds.push('used-999-a1'); },
    s => { s.previous = null; }]) {
    const s = at('preparing'); edit(s);
    assert.throws(() => simulate(s, { type: 'check' }));
  }
});
test('模擬試験: 期限切れでも未知イベント・追加フィールドは拒否する', () => {
  assert.throws(() => simulate(at('switching'), { type: 'migrate' }, 201), /INVALID_TRANSITION/);
  assert.throws(() => simulate(at('switching'), { type: 'check', approved: true }, 201), /INVALID_EVENT_FIELDS/);
});
test('契約・状態モジュールに通信・ファイル操作・環境変数参照がない', () => {
  for (const file of ['../deploy/poll/contract.mjs', '../deploy/poll/state.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:(fs|http|https|net|child_process)|process\.|fetch\s*\(/);
  }
});
