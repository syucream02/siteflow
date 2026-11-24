import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalStateStore, inspectLocalState, validatePersistentModel, recordNginxTransition } from '../deploy/poll/persistent-state.mjs';
import { acquireLocalLock, acquireLocalConfigLock, releaseLocalLock } from '../deploy/poll/lock.mjs';
import { openLocalStopRequester, openLocalStopReader, initializeLocalStopControl, stopActionAtPhase } from '../deploy/poll/stop-control.mjs';
import { createNginxPlan, advanceNginxPlan } from '../deploy/poll/nginx-plan.mjs';
import { pathChain } from '../deploy/poll/linux-storage.mjs';
import { assessRecovery } from '../deploy/poll/recovery.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = { kind: 'nextjs', container: 'current', port: 3001, image: `sha256:${'a'.repeat(64)}` };
const candidate = { kind: 'nextjs', container: 'blue', port: 3101, image: `ghcr.io/syucream02/siteflow@sha256:${'b'.repeat(64)}` };
const bytes = Buffer.from('server {\n location / {\n  proxy_pass http://127.0.0.1:3001;\n  proxy_set_header Host $host;\n  proxy_set_header X-Forwarded-Proto $scheme;\n }\n}\n');
const steps = ['backup_saved', 'staged_validated', 'intent_saved', 'config_installed', 'config_validated', 'reloaded', 'public_checked', 'committed'];
const healthy = slot => ({ ...slot, running: true, ready: true, httpStatus: 200, ok: true, consecutive: 3, freshConnections: true, workerGenerationConfirmed: true });
const event = type => ({ type, success: true, observation: type === 'public_checked' ? healthy(candidate) : type === 'rollback_checked' ? healthy(stable) : null });
function setup(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-poll-stage5-'));
  const c = { root, lock: acquireLocalLock(root) };
  c.store = createLocalStateStore(root, { now: () => 100, ...options });
  c.state = c.store.initialize(c.lock, stable, 'manual-bootstrap-test');
  c.reader = openLocalStopReader(root, c.state.workspaceId);
  c.requester = openLocalStopRequester(root, c.state.workspaceId, { now: () => 101 });
  return c;
}
function cleanup(c) {
  for (const lock of [c.configLock, c.lock]) if (lock) { try { releaseLocalLock(lock); } catch { /* sticky lockは解除せず試験領域の後片付けのみ。 */ } }
  const root = fs.realpathSync(c.root);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^siteflow-poll-stage5-[a-zA-Z0-9]+$/);
  fs.rmSync(root, { recursive: true, force: true });
}
function local(name, run) { test(name, async () => { const c = setup(); try { await run(c); } finally { cleanup(c); } }); }
function ready(c) {
  let s = c.store.consume(c.lock, 0, 'used-201-a1');
  for (const phase of ['candidate_starting', 'candidate_checking', 'candidate_ready']) s = c.store.checkpoint(c.lock, s.revision, phase, candidate);
  c.configLock = acquireLocalConfigLock(c.root);
  c.plan = createNginxPlan({ stable, candidate, origin: 'https://siteflow.invalid', config: {
    path: '/etc/nginx/conf.d/siteflow.conf', realPath: '/etc/nginx/conf.d/siteflow.conf', uid: 0, mode: 0o600, symlink: false, links: 1, text: bytes.toString(), reviewedHash: hash(bytes),
    parentEntries: pathChain('/etc/nginx/conf.d').map(p => ({ path: p, realPath: p, type: 'directory', uid: 0, gid: 0, mode: 0o755, symlink: false, deviceId: 1 })) },
    observed: { currentUpstreamPort: 3001, stable: healthy(stable), candidate: healthy(candidate), configurationExclusive: true, nginxHealthy: true } });
  c.state = s; return c;
}
function prepare(c) {
  ready(c); c.receipt = c.store.prepareNginxRecovery(c.lock, c.configLock, c.state.revision, c.plan, bytes);
  c.state = c.store.read(c.lock); return c;
}
function advance(c, count) { for (const type of steps.slice(0, count)) c.plan = advanceNginxPlan(c.plan, event(type), c.receipt); c.state = c.store.read(c.lock); }
function observed(c, which) {
  const r = c.state.nginxRecovery;
  return { environment: { mounted: true, uuidMatches: true, volumeMatches: true, rootOwned: true, symlinkFree: true, mysqlHealthy: true },
    containers: [healthy(stable), healthy(candidate)], route: which === 'after' ? candidate : stable, configMatches: true,
    nginxConfigHash: which === 'before' ? r.beforeHash : which === 'after' ? r.afterHash : 'f'.repeat(64),
    configurationExclusive: true, backupHash: r.beforeHash, backupFile: r.backupFile };
}

local('H3: deploy/config locks do not block durable stop requests; recorded is not stopped', c => {
  c.configLock = acquireLocalConfigLock(c.root);
  const r = c.requester.requestStop();
  assert.equal(r.requestRecorded, true); assert.equal(r.workerStopped, 'unconfirmed'); assert.equal(r.executionAllowed, false);
  assert.equal(c.reader.read().status, 'requested'); assert.deepEqual(c.reader.read().requestIds, [r.requestId]);
});
local('H3: reader and writer bind to the same trusted workspace, not arbitrary IDs', c => {
  assert.throws(() => openLocalStopRequester(c.root, 'f'.repeat(64), { now: () => 101 }), /WORKSPACE/);
  assert.throws(() => openLocalStopReader(c.root, 'f'.repeat(64)), /WORKSPACE/);
  c.requester.requestStop(); assert.equal(openLocalStopReader(c.root, c.state.workspaceId).read().status, 'requested');
});
local('H3: reopening after restart retains requested stop and refuses new release', c => {
  c.requester.requestStop(); releaseLocalLock(c.lock); c.lock = acquireLocalLock(c.root);
  const reopened = createLocalStateStore(c.root, { now: () => 102 });
  assert.equal(reopened.read(c.lock).revision, 0);
  assert.throws(() => reopened.consume(c.lock, 0, 'used-201-a1'), /STOP/);
});
local('H3: requests are append-only, distinct, and never overwrite each other', c => {
  const first = c.requester.requestStop(), second = c.requester.requestStop();
  assert.notEqual(first.requestId, second.requestId); assert.deepEqual(new Set(c.reader.read().requestIds), new Set([first.requestId, second.requestId]));
});
local('H3: no ordinary reader/requester/store resume or clear entry; reinitialization refused', c => {
  c.requester.requestStop();
  for (const api of [c.reader, c.requester, c.store]) { assert.equal(Object.hasOwn(api, 'clearStop'), false); assert.equal(Object.hasOwn(api, 'resume'), false); }
  assert.throws(() => initializeLocalStopControl(c.root, c.state.workspaceId), /NOT_FRESH/);
  assert.throws(() => c.store.checkBeforeEffect(c.lock, 'resume'), /INVALID_EFFECT/);
  assert.equal(c.reader.read().status, 'requested');
});
for (const operation of ['docker_pull', 'docker_create', 'docker_start', 'candidate_check', 'nginx_install', 'nginx_reload', 'public_check', 'commit']) local(`H3: fresh stop read before ${operation}, cached clear cannot authorize`, c => {
  const cached = c.reader.read(); assert.equal(cached.status, 'clear');
  assert.equal(c.store.checkBeforeEffect(c.lock, operation).executionAllowed, false);
  c.requester.requestStop();
  assert.throws(() => c.store.checkBeforeEffect(c.lock, operation, cached), /STOP/);
});
for (const point of ['before_stop_write', 'after_stop_write', 'after_stop_sync']) local(`H3: ${point} failure never reports stop success and latches refusal`, c => {
  const writer = openLocalStopRequester(c.root, c.state.workspaceId, { now: () => 101, fault: p => { if (p === point) throw new Error('SIMULATED_IO_FAILURE'); } });
  assert.throws(() => writer.requestStop(), /^Error: STOP_NOT_CONFIRMED$/);
  assert.notEqual(c.reader.read().status, 'clear'); assert.throws(() => c.store.consume(c.lock, 0, 'used-201-a1'), /STOP/);
});
local('H3: total inability to persist is unconfirmed delivery, never a claimed worker stop', c => {
  const writer = openLocalStopRequester(c.root, c.state.workspaceId, { now: () => 101, fault: p => { if (['before_stop_write', 'before_failure_latch'].includes(p)) throw new Error('SIMULATED_ALL_WRITES_FAILED'); } });
  assert.throws(() => writer.requestStop(), /^Error: STOP_NOT_CONFIRMED$/);
  // 何も書けなければreaderには要求未達。別管理経路が必要という限界を明示する。
  assert.equal(c.reader.read().status, 'clear');
});
for (const kind of ['corrupt_request', 'replaced_binding']) local(`H3: ${kind} gives unknown and fails closed`, c => {
  const r = c.requester.requestStop();
  fs.writeFileSync(path.join(c.root, kind === 'corrupt_request' ? `stop-request-${r.requestId}.json` : 'stop-binding.json'), '{}');
  assert.equal(c.reader.read().status, 'unknown'); assert.throws(() => c.reader.assertClear(), /STOP/);
});
local('H3: request after the last check is a documented TOCTOU window, not an authority token', c => {
  const old = c.store.checkBeforeEffect(c.lock, 'docker_start'); c.requester.requestStop();
  assert.equal(old.executionAllowed, false); assert.equal(old.status, 'fresh_local_stop_check_only');
  assert.throws(() => c.store.checkBeforeEffect(c.lock, 'docker_start'), /STOP/);
});
local('H3: stop after write-intent check prevents durable forward transition', c => {
  const store = createLocalStateStore(c.root, { now: () => 101, fault: p => { if (p === 'before_rename') c.requester.requestStop(); } });
  assert.throws(() => store.consume(c.lock, 0, 'used-201-a1'), /WRITE_UNCERTAIN/);
  assert.equal(inspectLocalState(c.root).status, 'incident');
});
for (const phase of ['idle', 'preparing', 'switching', 'verifying', 'committing', 'committed']) test(`H3: phase-aware stop action ${phase}`, () => {
  const r = stopActionAtPhase('requested', phase); assert.equal(r.executionAllowed, false);
  assert.equal(r.requiredAction, phase === 'committed' ? 'keep_committed_block_new' : ['switching', 'verifying', 'committing'].includes(phase) ? 'reconcile_or_rollback' : 'abort_before_switch');
});

local('H2: recovery backup, hashes, previous release and operation are durable before switching', c => {
  prepare(c); const r = c.store.read(c.lock).nginxRecovery;
  assert.equal(r.previous.port, 3001); assert.equal(r.previous.image, stable.image); assert.equal(r.previousReleaseId, 'manual-bootstrap-test');
  assert.equal(r.releaseId, 'used-201-a1'); assert.equal(r.beforeHash, hash(bytes)); assert.equal(r.operation, 'prepared');
  assert.equal(r.afterHash, c.plan.nextHash); assert.ok(fs.existsSync(path.join(c.root, r.backupFile)));
  assert.throws(() => c.store.checkpoint(c.lock, c.state.revision, 'switching'), /RECORDED_NGINX/);
});
local('H2: no saved receipt, fake receipt, wrong lock or missing stable ID cannot advance', c => {
  ready(c);
  assert.throws(() => advanceNginxPlan(c.plan, event('backup_saved')), /RECEIPT/);
  assert.throws(() => advanceNginxPlan(c.plan, event('backup_saved'), {}), /RECEIPT/);
  assert.throws(() => c.store.prepareNginxRecovery(c.lock, c.lock, c.state.revision, c.plan, bytes), /LOCK/);
  assert.throws(() => c.store.prepareNginxRecovery(c.lock, c.configLock, c.state.revision, c.plan, Buffer.from('WRONG')), /HASH/);
});
local('H2: missing initial stable release identity is not invented', c => {
  const s = structuredClone(c.state); s.stableReleaseId = null;
  const text = JSON.stringify({ formatVersion: 1, payload: s, checksumSha256: hash(JSON.stringify(s)) });
  fs.writeFileSync(path.join(c.root, 'state.json'), text); fs.writeFileSync(path.join(c.root, 'revision-0000000000.json'), text);
  ready(c);
  assert.throws(() => c.store.prepareNginxRecovery(c.lock, c.configLock, c.state.revision, c.plan, bytes), /PREPARATION_MISMATCH/);
});
local('H2: direct journal call cannot skip backup steps to committed', c => {
  prepare(c); const before = c.store.read(c.lock);
  assert.throws(() => recordNginxTransition(c.receipt, c.plan, event('committed'), { ...c.plan, phase: 'committed' }), /RECORDED_EDGE/);
  assert.deepEqual(c.store.read(c.lock), before);
});
local('H2: old plan or changed digest cannot reuse a saved receipt', c => {
  prepare(c); const old = structuredClone(c.plan); advance(c, 1);
  assert.throws(() => advanceNginxPlan(old, event('backup_saved'), c.receipt), /STALE_OR_DIFFERENT/);
  const changed = structuredClone(c.plan); changed.candidate.image = `ghcr.io/syucream02/siteflow@sha256:${'f'.repeat(64)}`;
  assert.throws(() => advanceNginxPlan(changed, event('staged_validated'), c.receipt), /STALE_OR_DIFFERENT/);
});
local('H3: successful rollback after stop still does not clear incident or stop requests', c => {
  prepare(c); advance(c, 6); c.requester.requestStop();
  c.plan = advanceNginxPlan(c.plan, event('public_checked'), c.receipt);
  for (const type of ['rollback_restored', 'rollback_validated', 'rollback_reloaded', 'rollback_checked']) c.plan = advanceNginxPlan(c.plan, event(type), c.receipt);
  assert.equal(c.plan.phase, 'incident'); assert.equal(c.store.read(c.lock).phase, 'incident'); assert.equal(c.reader.read().status, 'requested');
  assert.equal(c.store.read(c.lock).stable.port, 3001);
});
local('H2: config lock excludes competing local writers and cannot substitute deploy lock', c => {
  prepare(c); assert.throws(() => acquireLocalConfigLock(c.root), /EEXIST/);
  assert.throws(() => c.store.read(c.configLock), /LOCK/);
});
for (const count of [0, 3, 4, 6, 7, 8]) local(`H2: reload durable record after interruption at step ${count}`, c => {
  prepare(c); advance(c, count); const before = c.store.read(c.lock);
  releaseLocalLock(c.configLock); c.configLock = null; releaseLocalLock(c.lock); c.lock = acquireLocalLock(c.root);
  const reopened = createLocalStateStore(c.root, { now: () => 102 });
  assert.deepEqual(reopened.read(c.lock), before);
  const snap = { status: 'snapshot', executionAllowed: false, state: before };
  for (const which of ['before', 'after', 'unknown']) {
    const r = assessRecovery(snap, observed(c, which)); assert.equal(r.executionAllowed, false);
    assert.equal(r.configClassification ?? (which === 'unknown' ? 'unknown' : which), which);
    if (which === 'unknown') { assert.equal(r.status, 'incident'); assert.equal(r.target, null); }
  }
});
for (const damage of ['missing', 'corrupt', 'wrong_backup_binding']) local(`H2: ${damage} backup blocks further plan steps`, c => {
  prepare(c); const file = path.join(c.root, c.state.nginxRecovery.backupFile);
  if (damage === 'missing') fs.unlinkSync(file);
  else if (damage === 'corrupt') fs.writeFileSync(file, '{}');
  else { const b = JSON.parse(fs.readFileSync(file)); b.releaseId = 'used-202-a1'; fs.writeFileSync(file, JSON.stringify(b)); }
  assert.throws(() => advanceNginxPlan(c.plan, event('backup_saved'), c.receipt));
  assert.equal(inspectLocalState(c.root).status, 'incident');
});
for (const point of ['before_backup_write', 'after_backup_write']) local(`H2: ${point} failure cannot proceed to switch`, c => {
  ready(c); const store = createLocalStateStore(c.root, { now: () => 101, fault: p => { if (p === point) throw new Error('SIMULATED_BACKUP_FAILURE'); } });
  assert.throws(() => store.prepareNginxRecovery(c.lock, c.configLock, c.state.revision, c.plan, bytes), /PREPARATION_UNCERTAIN/);
  assert.equal(inspectLocalState(c.root).status, 'incident'); assert.equal(c.plan.phase, 'candidate_ready');
});
local('H2: missing recovery field and Vinext target are rejected', c => {
  prepare(c); const invalid = structuredClone(c.state); delete invalid.nginxRecovery.beforeHash;
  assert.throws(() => validatePersistentModel(invalid));
  const vinext = structuredClone(c.state); vinext.nginxRecovery.previous.port = 3002;
  assert.throws(() => validatePersistentModel(vinext));
});
local('H2: hash/route conflict and unlocked observation stay incident', c => {
  prepare(c); advance(c, 4); const snap = { status: 'snapshot', executionAllowed: false, state: c.state };
  const o = observed(c, 'before'); o.route = candidate;
  assert.equal(assessRecovery(snap, o).reason, 'NGINX_HASH_ROUTE_CONFLICT');
  const unlocked = observed(c, 'after'); unlocked.configurationExclusive = false;
  assert.equal(assessRecovery(snap, unlocked).status, 'incident');
});
for (const count of [0, 2, 3, 6, 7]) local(`H3: stop before next operation at stage ${count} persists abort/rollback decision`, c => {
  prepare(c); advance(c, count); c.requester.requestStop();
  c.plan = advanceNginxPlan(c.plan, event(steps[count]), c.receipt);
  assert.equal(c.store.read(c.lock).phase, 'incident'); assert.equal(c.store.read(c.lock).stable.port, 3001);
  assert.ok(['incident', 'rolling_back'].includes(c.plan.phase));
});
local('H3: stop just before journal commit is caught by a second fresh read', c => {
  ready(c);
  const store = createLocalStateStore(c.root, { now: () => 101, fault: p => { if (p === 'nginx_before_record') c.requester.requestStop(); } });
  c.receipt = store.prepareNginxRecovery(c.lock, c.configLock, c.state.revision, c.plan, bytes);
  c.plan = advanceNginxPlan(c.plan, event('backup_saved'), c.receipt);
  assert.equal(c.plan.phase, 'incident'); assert.equal(store.read(c.lock).stable.port, 3001);
});
local('H2/H3: rollback during stop is recorded, failure remains incident after reopen', c => {
  prepare(c); advance(c, 6); c.requester.requestStop();
  c.plan = advanceNginxPlan(c.plan, event('public_checked'), c.receipt);
  assert.equal(c.plan.phase, 'rolling_back');
  c.plan = advanceNginxPlan(c.plan, { type: 'rollback_restored', success: false, observation: null }, c.receipt);
  assert.equal(c.plan.phase, 'incident'); assert.equal(c.store.read(c.lock).phase, 'incident');
  assert.throws(() => c.store.consume(c.lock, c.store.read(c.lock).revision, 'used-202-a1'), /INCIDENT/);
});
local('H2: v1 is readable but never silently migrated or used for new writes', c => {
  const legacy = structuredClone(c.state); legacy.schemaVersion = 1; delete legacy.stableReleaseId; delete legacy.nginxRecovery;
  const envelope = JSON.stringify({ formatVersion: 1, payload: legacy, checksumSha256: hash(JSON.stringify(legacy)) });
  fs.writeFileSync(path.join(c.root, 'state.json'), envelope); fs.writeFileSync(path.join(c.root, 'revision-0000000000.json'), envelope);
  assert.equal(c.store.read(c.lock).schemaVersion, 1); assert.equal(inspectLocalState(c.root).status, 'legacy_readonly');
  assert.throws(() => c.store.consume(c.lock, 0, 'used-201-a1'), /LEGACY_STATE_READ_ONLY/);
  assert.equal(c.store.read(c.lock).schemaVersion, 1);
  const active = { ...legacy, phase: 'preparing', previous: stable, activeReleaseId: 'used-201-a1', consumedIds: ['used-201-a1'] };
  assert.equal(assessRecovery({ status: 'snapshot', executionAllowed: false, state: active }, observedLegacy()).reason, 'LEGACY_RECOVERY_UNPROVEN');
});
function observedLegacy() { return { environment: { mounted: true, uuidMatches: true, volumeMatches: true, rootOwned: true, symlinkFree: true, mysqlHealthy: true }, containers: [healthy(stable)], route: stable, configMatches: true }; }
