import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createIncidentRecord, validateIncidentRecord, summarizeIncidentSlot, planIncidentNotification, INCIDENT_STAGES } from '../deploy/poll/incident.mjs';
import { createLocalStateStore, inspectLocalState } from '../deploy/poll/persistent-state.mjs';
import { acquireLocalLock, releaseLocalLock } from '../deploy/poll/lock.mjs';
import { openLocalStopRequester } from '../deploy/poll/stop-control.mjs';
import { planManualRecovery } from '../deploy/poll/recovery.mjs';

const NOW = 1000, DIGEST = `sha256:${'a'.repeat(64)}`;
const stable = { kind: 'nextjs', container: 'fixture-stable', port: 3102, image: `ghcr.io/syucream02/siteflow@${DIGEST}` };
const details = (stage = 'candidate') => ({ reason: 'DEPLOYMENT_INTERRUPTED', stage, nginxMatch: 'unknown', dockerMatch: 'unknown', recoveryPhase: 'interrupted' });
const OLD_DIGEST = `sha256:${'b'.repeat(64)}`;
function input(stage = 'candidate') {
  return { workspaceId: 'f'.repeat(64), stateRevision: 3, stateConfidence: 'validated', releaseId: 'used-10-a1',
    ...details(stage), phase: 'incident', stable: { port: 3102, digest: DIGEST }, rollback: { port: 3101, digest: OLD_DIGEST },
    stopStatus: 'clear', lastKnownGood: { port: 3102, digest: DIGEST } };
}
function local(name, run) {
  test(name, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-poll-stage5-'));
    const c = { root, clock: NOW, fail: null };
    c.store = createLocalStateStore(root, { now: () => c.clock, forwardDeadline: NOW + 10, fault: p => { if (p === c.fail) throw new Error('SIMULATED_IO_FAILURE'); } });
    c.lock = acquireLocalLock(root);
    c.state = c.store.initialize(c.lock, stable, 'manual-fixture-stable');
    c.state = c.store.consume(c.lock, c.state.revision, 'used-10-a1');
    c.state = c.store.checkpoint(c.lock, c.state.revision, 'incident');
    try { await run(c); } finally {
      try { releaseLocalLock(c.lock); } catch { /* sticky incident locks are never reclaimed */ }
      const real = fs.realpathSync(root);
      assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir())); assert.match(path.basename(real), /^siteflow-poll-stage5-[a-zA-Z0-9]+$/);
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
}
function evidence(stage = 'candidate') {
  return { observedAt: NOW, stateMatches: true, ebsReady: true, mysqlReady: true, stopStatus: 'clear',
    stable: { port: 3102, digest: DIGEST, configurationMatches: true, running: true, ready: true },
    rollback: { port: 3101, digest: OLD_DIGEST, configurationMatches: true, running: true, ready: true },
    nginx: { match: ['nginx_switch', 'post_switch'].includes(stage) ? 'after' : 'stable', routePort: 3102, routeMatchesSavedConfig: true, backupMatches: true, exclusive: true },
    dockerMatch: 'match', cleanup: { status: stage === 'generation_cleanup' ? 'stopped' : 'none', targetMatches: true, protectedMatches: true },
    publicHealthy: true, legacyServiceConflict: false,
    control: { incidentId: createIncidentRecord(input(stage), NOW).incidentId, workspaceId: 'f'.repeat(64), stateRevision: 3, lockHeld: true, stopStatus: 'clear', nginxPort: 3102 },
    rollbackIdentity: rollbackIdentity() };
}
function rollbackIdentity() {
  const cfg = {
    entrypoint: ['node'], cmd: ['server.js'], user: '1000:1000', workingDir: '/app',
    env: { NODE_ENV: 'production', HOSTNAME: '0.0.0.0', PORT: '3000', SITEFLOW_WORKSPACE_MODE: 'public-integrated', SITEFLOW_PUBLIC_ORIGIN: 'https://siteflow.invalid', SITEFLOW_DB_HOST: 'mysql.siteflow.test', SITEFLOW_DB_PORT: '3306', SITEFLOW_DB_NAME: 'siteflow_public_app', SITEFLOW_DB_USER: 'siteflow_app', SITEFLOW_DB_TLS: 'required', SITEFLOW_DB_CA_FILE: '/run/siteflow/ca.pem', SITEFLOW_DB_PASSWORD_FILE: '/run/secrets/db-password', SITEFLOW_AUTH_SECRET_FILE: '/run/secrets/auth-secret' },
    mounts: [
      { type: 'bind', source: '/srv/siteflow-mysql/secrets/candidate/db-password', target: '/run/secrets/db-password', readOnly: true },
      { type: 'bind', source: '/srv/siteflow-mysql/secrets/candidate/auth-secret', target: '/run/secrets/auth-secret', readOnly: true },
      { type: 'bind', source: '/srv/siteflow-mysql/tls/server/ca.pem', target: '/run/siteflow/ca.pem', readOnly: true }],
    portBindings: [{ hostIp: '127.0.0.1', hostPort: 3101, containerPort: 3000 }], networkMode: 'siteflow-production-database', privileged: false, readonlyRootfs: true,
    capAdd: [], capDrop: ['ALL'], securityOpt: ['no-new-privileges:true'], memory: 384 * 1024 ** 2, memorySwap: 384 * 1024 ** 2, nanoCpus: 500000000, pidsLimit: 128,
    ulimits: { core: { soft: 0, hard: 0 } }, tmpfs: { '/tmp': 'rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=1777' }, restartPolicy: 'no', logDriver: 'none', stopTimeout: 30
  };
  const saved = { containerId: 'c'.repeat(64), releaseId: 'used-9-a1', owner: 'poll-release',
    configuration: { version: 1, releaseId: 'used-9-a1', slot: { kind: 'nextjs', container: 'old-nextjs', port: 3101, image: `ghcr.io/syucream02/siteflow@${OLD_DIGEST}` }, configuration: cfg, hash: createHash('sha256').update(JSON.stringify(cfg)).digest('hex') } };
  return { saved, observed: { containerId: saved.containerId, releaseId: saved.releaseId, owner: saved.owner, configuration: structuredClone(cfg) } };
}

test('incident: strict allowlist, run correspondence, immutable clone and stable ID', () => {
  const i = input(), r = createIncidentRecord(i, NOW), later = createIncidentRecord(i, NOW + 1);
  assert.equal(r.incidentId, later.incidentId); assert.equal(r.runId, '10'); assert.equal(r.executionAllowed, false);
  i.stable.port = 3002; assert.equal(r.stable.port, 3102);
  assert.deepEqual(validateIncidentRecord(r), r);
});
for (const field of ['token', 'privateKey', 'env', 'databaseUrl', 'error', 'response']) test(`incident: rejects secret-bearing unknown field ${field}`, () => {
  const sentinel = 'NEVER_OUTPUT_THIS_FIXTURE_VALUE';
  assert.throws(() => createIncidentRecord({ ...input(), [field]: sentinel }, NOW), e => !e.message.includes(sentinel));
});
for (const [name, change] of [
  ['unknown stage', r => { r.stage = 'other'; }], ['unknown reason', r => { r.reason = 'unfiltered external error'; }],
  ['invalid time', r => { r.occurredAt = NaN; }], ['run mismatch', r => { r.runId = '99'; }],
  ['ID tampering', r => { r.incidentId = '0'.repeat(64); }], ['Vinext rollback', r => { r.rollback.port = 3002; }],
  ['unknown digest', r => { r.stable.digest = 'latest'; }], ['real permission', r => { r.executionAllowed = true; }],
]) test(`incident: rejects ${name}`, () => {
  const r = createIncidentRecord(input(), NOW); change(r); assert.throws(() => validateIncidentRecord(r));
});
test('incident: local image ID is never recorded as proven OCI digest', () => {
  assert.equal(summarizeIncidentSlot({ ...stable, image: DIGEST }).digest, null);
  assert.equal(summarizeIncidentSlot({ ...stable, port: 3002 }), null);
});
test('fix4: valid-to-valid occurredAt modification must be rejected by stored integrity', () => {
  const r = createIncidentRecord(input(), NOW); r.occurredAt++;
  assert.throws(() => validateIncidentRecord(r));
});
local('incident store: durable record, dedup and reopen retain incident and consumed ID', c => {
  const a = c.store.recordIncident(c.lock, details()); c.clock++;
  const b = c.store.recordIncident(c.lock, details()); assert.equal(b.status, 'already_recorded'); assert.equal(a.record.incidentId, b.record.incidentId);
  assert.equal(c.store.read(c.lock).phase, 'incident'); assert.deepEqual(c.store.read(c.lock).consumedIds, ['used-10-a1']);
  releaseLocalLock(c.lock); c.lock = acquireLocalLock(c.root);
  const reopened = createLocalStateStore(c.root, { now: () => c.clock });
  assert.equal(reopened.listIncidents(c.lock).length, 1); assert.equal(reopened.read(c.lock).phase, 'incident');
  assert.throws(() => reopened.consume(c.lock, c.state.revision, 'used-11-a1'));
});
local('incident store: records after approval expiry without permitting forward work', c => {
  c.clock += 100;
  const r = c.store.recordIncident(c.lock, details()); assert.equal(r.record.occurredAt, c.clock);
  assert.throws(() => c.store.consume(c.lock, c.state.revision, 'used-11-a1'));
  assert.equal(c.store.prepareIncidentNotification(c.lock, r.record.incidentId).status, 'planned');
});
for (const fault of ['before_incident_write', 'after_incident_write', 'before_incident_notice', 'before_incident_outcome']) local(`incident store: ${fault} never reports success and latches failure`, c => {
  let r, p;
  if (!fault.includes('write')) r = c.store.recordIncident(c.lock, details());
  if (fault === 'before_incident_outcome') p = c.store.prepareIncidentNotification(c.lock, r.record.incidentId);
  c.fail = fault;
  assert.throws(() => fault.includes('write') ? c.store.recordIncident(c.lock, details()) : fault === 'before_incident_notice' ?
    c.store.prepareIncidentNotification(c.lock, r.record.incidentId) : c.store.recordIncidentNotification(p.receipt, 'simulated_delivered'), /NOT_CONFIRMED|UNCONFIRMED/);
  assert.equal(inspectLocalState(c.root).status, 'incident');
  if (r) assert.equal(c.store.listIncidents(c.lock)[0].incidentId, r.record.incidentId);
});
local('incident store: backward clock is refused without hiding the existing incident', c => {
  c.store.recordIncident(c.lock, details()); c.clock--;
  assert.throws(() => c.store.recordIncident(c.lock, details('post_switch')), /NOT_CONFIRMED/);
  assert.equal(c.store.listIncidents(c.lock).length, 1);
});
local('incident store: corrupt state records only unconfirmed/unknown information', c => {
  fs.writeFileSync(path.join(c.root, 'state.json'), '{}');
  const r = c.store.recordIncident(c.lock, details());
  assert.equal(r.record.stateConfidence, 'unconfirmed'); assert.equal(r.record.stable, null); assert.equal(r.record.releaseId, null);
  assert.equal(planManualRecovery(r.record, evidence(), NOW).status, 'blocked');
});
local('incident store: raw response and exception values never appear in persisted data or event', c => {
  const r = c.store.recordIncident(c.lock, details());
  const p = c.store.prepareIncidentNotification(c.lock, r.record.incidentId);
  const output = JSON.stringify({ record: r.record, event: p.event });
  for (const field of ['authorization', 'password', 'databaseUrl', 'privateKey', 'stack']) assert.equal(output.includes(`"${field}"`), false);
  assert.deepEqual(Object.keys(p.event).sort(), ['MESSAGE', 'MESSAGE_ID', 'PRIORITY', 'SITEFLOW_INCIDENT_ID', 'SITEFLOW_REASON', 'SITEFLOW_RELEASE_ID', 'SITEFLOW_RUN_ID', 'SITEFLOW_STAGE'].sort());
});
local('notice: reservation throttles duplicates across restart even with unknown delivery', c => {
  const r = c.store.recordIncident(c.lock, details()), id = r.record.incidentId;
  assert.equal(c.store.prepareIncidentNotification(c.lock, id).status, 'planned');
  assert.equal(c.store.prepareIncidentNotification(c.lock, id).status, 'suppressed');
  releaseLocalLock(c.lock); c.lock = acquireLocalLock(c.root);
  const reopened = createLocalStateStore(c.root, { now: () => c.clock });
  assert.equal(reopened.prepareIncidentNotification(c.lock, id).status, 'suppressed');
});
local('notice: failed delivery retains incident; retries only after 300s and never clears it', c => {
  const id = c.store.recordIncident(c.lock, details()).record.incidentId;
  const p = c.store.prepareIncidentNotification(c.lock, id);
  assert.equal(c.store.recordIncidentNotification(p.receipt, 'simulated_failed').incidentResolved, false);
  c.clock += 299; assert.equal(c.store.prepareIncidentNotification(c.lock, id).status, 'suppressed');
  c.clock++; assert.equal(c.store.prepareIncidentNotification(c.lock, id).status, 'planned');
  assert.equal(c.store.read(c.lock).phase, 'incident');
});
local('notice: delivery success never resolves incident; different serious failure is not suppressed', c => {
  const id = c.store.recordIncident(c.lock, details()).record.incidentId;
  const p = c.store.prepareIncidentNotification(c.lock, id);
  c.store.recordIncidentNotification(p.receipt, 'simulated_delivered'); c.clock += 300;
  assert.equal(c.store.prepareIncidentNotification(c.lock, id).status, 'suppressed');
  assert.throws(() => c.store.recordIncidentNotification(p.receipt, 'simulated_delivered'));
  assert.throws(() => c.store.recordIncidentNotification({ verified: true }, 'simulated_delivered'));
  const other = c.store.recordIncident(c.lock, { ...details('post_switch'), reason: 'RECOVERY_UNCERTAIN' }).record;
  assert.notEqual(other.incidentId, id); assert.equal(c.store.prepareIncidentNotification(c.lock, other.incidentId).status, 'planned');
  assert.equal(c.store.read(c.lock).phase, 'incident');
});
local('notice: damaged notice record is rejected, never treated as successful delivery', c => {
  const id = c.store.recordIncident(c.lock, details()).record.incidentId;
  c.store.prepareIncidentNotification(c.lock, id);
  fs.writeFileSync(path.join(c.root, `incident-notice-${id}-${NOW}.json`), '{}');
  assert.throws(() => c.store.prepareIncidentNotification(c.lock, id)); assert.equal(inspectLocalState(c.root).status, 'incident');
});
test('notice: invalid history or backwards clock cannot authorize or deliver', () => {
  const r = createIncidentRecord(input(), NOW);
  assert.throws(() => planIncidentNotification(r, [], NOW - 1));
  assert.throws(() => planIncidentNotification(r, [{ approved: true }], NOW));
  assert.equal(planIncidentNotification(r, [], NOW).executionAllowed, false);
});

for (const stage of INCIDENT_STAGES.filter(x => x !== 'unknown')) test(`manual recovery: distinct safe ${stage} plan, never a release permission`, () => {
  const r = createIncidentRecord(input(stage), NOW), p = planManualRecovery(r, evidence(stage), NOW);
  assert.equal(p.status, 'review_plan_requires_approval'); assert.equal(p.stage, stage);
  assert.equal(p.executionAllowed, false); assert.equal(p.newDeploymentsAllowed, false); assert.equal(p.incidentResolved, false);
  assert.ok(p.resumeRequirements.includes('new_unused_release_id')); assert.ok(p.forbidden.includes('database_rollback'));
});
for (const [name, edit] of [
  ['state mismatch', e => { e.stateMatches = false; }], ['EBS absent', e => { e.ebsReady = false; }],
  ['MySQL unavailable', e => { e.mysqlReady = false; }], ['stop unknown', e => { e.stopStatus = 'unknown'; }],
  ['digest mismatch', e => { e.stable.digest = `sha256:${'b'.repeat(64)}`; }], ['configuration mismatch', e => { e.stable.configurationMatches = false; }],
  ['stable not ready', e => { e.stable.ready = false; }], ['Docker mismatch', e => { e.dockerMatch = 'mismatch'; }],
  ['Nginx unknown', e => { e.nginx.match = 'unknown'; }], ['Nginx route unknown', e => { e.nginx.routeMatchesSavedConfig = false; }],
  ['Certbot exclusion absent', e => { e.nginx.exclusive = false; }], ['public failed', e => { e.publicHealthy = false; }],
  ['legacy service conflict', e => { e.legacyServiceConflict = true; }], ['stale observation', e => { e.observedAt = NOW - 6; }],
  ['Vinext port', e => { e.stable.port = 3002; }], ['unknown evidence', e => { e.approved = true; }],
  ['cleanup unknown', e => { e.cleanup.status = 'unknown'; }], ['cleanup unfinished', e => { e.cleanup.status = 'stopped'; }],
]) test(`manual recovery: rejects ${name}`, () => {
  const e = evidence(); edit(e); assert.equal(planManualRecovery(createIncidentRecord(input(), NOW), e, NOW).status, 'blocked');
});
for (const stage of ['nginx_switch', 'post_switch']) for (const field of ['backup', 'rollback']) test(`manual recovery: ${stage} requires proven ${field}`, () => {
  const e = evidence(stage); if (field === 'backup') e.nginx.backupMatches = false; else e.rollback.configurationMatches = false;
  assert.equal(planManualRecovery(createIncidentRecord(input(stage), NOW), e, NOW).status, 'blocked');
});
for (const stage of INCIDENT_STAGES.filter(x => x !== 'unknown')) test(`manual recovery: stop request permits observation only at ${stage}`, () => {
  const e = evidence(stage); e.stopStatus = 'requested'; e.control.stopStatus = 'requested';
  const r = planManualRecovery(createIncidentRecord(input(stage), NOW), e, NOW);
  assert.equal(r.status, 'observation_only'); assert.equal(r.executionAllowed, false);
  e.stable.running = false; assert.equal(planManualRecovery(createIncidentRecord(input(stage), NOW), e, NOW).status, 'blocked');
});
test('manual recovery: boot offline stable needs separate approval and never latest or Vinext', () => {
  const e = evidence('boot'); e.stable.running = false; e.stable.ready = false; e.publicHealthy = false;
  const r = planManualRecovery(createIncidentRecord(input('boot'), NOW), e, NOW);
  assert.equal(r.status, 'review_plan_requires_approval'); assert.ok(r.steps.includes('obtain_separate_start_approval'));
  e.stopStatus = 'requested'; e.control.stopStatus = 'requested'; assert.equal(planManualRecovery(createIncidentRecord(input('boot'), NOW), e, NOW).status, 'blocked');
});
test('fix4: failed new stable and a distinct healthy rollback can produce only a review plan', () => {
  const i = input('post_switch'), e = evidence('post_switch');
  i.rollback = { port: 3101, digest: `sha256:${'b'.repeat(64)}` };
  e.stable.running = false; e.stable.ready = false; e.publicHealthy = false;
  Object.assign(e.rollback, i.rollback);
  const r = planManualRecovery(createIncidentRecord(i, NOW), e, NOW);
  assert.equal(r.status, 'review_plan_requires_approval'); assert.equal(r.executionAllowed, false);
});
for (const [name, change] of [
  ['container ID', e => { e.rollbackIdentity.observed.containerId = 'd'.repeat(64); }],
  ['generation', e => { e.rollbackIdentity.observed.releaseId = 'used-8-a1'; }],
  ['owner', e => { e.rollbackIdentity.observed.owner = 'unmanaged'; }],
  ['configuration', e => { e.rollbackIdentity.observed.configuration.cmd = ['migrate']; }],
  ['saved configuration', e => { e.rollbackIdentity.saved.configuration.hash = 'e'.repeat(64); }],
  ['digest', e => { e.rollback.digest = DIGEST; }], ['port Vinext', e => { e.rollback.port = 3002; }],
  ['rollback stopped', e => { e.rollback.running = false; }], ['rollback unhealthy', e => { e.rollback.ready = false; }],
  ['missing identity', e => { e.rollbackIdentity = null; }], ['lock absent', e => { e.control.lockHeld = false; }],
  ['state revision', e => { e.control.stateRevision++; }], ['other incident', e => { e.control.incidentId = 'e'.repeat(64); }],
  ['Nginx reference', e => { e.control.nginxPort = 3101; }],
]) test(`fix4: refuses rollback ${name}`, () => {
  const e = evidence('post_switch'); change(e);
  assert.equal(planManualRecovery(createIncidentRecord(input('post_switch'), NOW), e, NOW).status, 'blocked');
});
local('fix4: occurredAt corruption on disk is refused and not overwritten', c => {
  const r = c.store.recordIncident(c.lock, details()).record;
  const file = path.join(c.root, `incident-record-${r.incidentId}.json`);
  r.occurredAt++; const broken = JSON.stringify(r); fs.writeFileSync(file, broken);
  assert.throws(() => c.store.listIncidents(c.lock));
  assert.throws(() => c.store.recordIncident(c.lock, details()));
  assert.equal(fs.readFileSync(file, 'utf8'), broken); assert.equal(inspectLocalState(c.root).status, 'incident');
});
test('fix4: legacy record without whole-record checksum is rejected, never auto-upgraded', () => {
  const r = createIncidentRecord(input(), NOW); r.version = 1; delete r.integritySha256;
  assert.throws(() => validateIncidentRecord(r));
});
local('fix4: legacy on-disk records are preserved and block further writes', c => {
  const r = c.store.recordIncident(c.lock, details()).record;
  const file = path.join(c.root, `incident-record-${r.incidentId}.json`);
  r.version = 1; delete r.integritySha256;
  const original = JSON.stringify(r); fs.writeFileSync(file, original);
  assert.throws(() => c.store.listIncidents(c.lock)); assert.throws(() => c.store.recordIncident(c.lock, details()));
  assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(inspectLocalState(c.root).status, 'incident');
});
test('manual recovery: cleanup absent/stopped/removed are distinguished; unknown is blocked', () => {
  const r = createIncidentRecord(input('generation_cleanup'), NOW);
  for (const status of ['none', 'stopped', 'removed']) {
    const e = evidence('generation_cleanup'); e.cleanup.status = status;
    assert.ok(planManualRecovery(r, e, NOW).steps.includes(`inventory_target_${status}`));
  }
  const e = evidence('generation_cleanup'); e.cleanup.status = 'unknown'; assert.equal(planManualRecovery(r, e, NOW).status, 'blocked');
});
test('manual recovery: unknown stage or absent OCI proof cannot yield an actionable plan', () => {
  assert.equal(planManualRecovery(createIncidentRecord(input('unknown'), NOW), evidence(), NOW).status, 'blocked');
  const i = input(); i.stable.digest = null;
  assert.equal(planManualRecovery(createIncidentRecord(i, NOW), evidence(), NOW).status, 'blocked');
});
local('incident store: durable stop is retained and never cleared by records or notices', c => {
  openLocalStopRequester(c.root, c.state.workspaceId, { now: () => c.clock }).requestStop();
  const r = c.store.recordIncident(c.lock, details()); assert.equal(r.record.stopStatus, 'requested');
  const p = c.store.prepareIncidentNotification(c.lock, r.record.incidentId);
  c.store.recordIncidentNotification(p.receipt, 'simulated_delivered');
  assert.equal(inspectLocalState(c.root).status, 'incident'); assert.equal(c.store.read(c.lock).phase, 'incident');
});
