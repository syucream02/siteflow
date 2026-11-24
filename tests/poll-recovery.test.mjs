import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRecovery } from '../deploy/poll/recovery.mjs';

const stable = { kind: 'nextjs', container: 'current', port: 3001, image: `sha256:${'a'.repeat(64)}` };
const candidate = { kind: 'nextjs', container: 'blue', port: 3101, image: `ghcr.io/syucream02/siteflow@sha256:${'b'.repeat(64)}` };
function snapshot(phase = 'idle') {
  const needsRecovery = ['switching', 'verifying', 'committing', 'rolling_back', 'committed'].includes(phase);
  return { status: 'snapshot', executionAllowed: false, state: { schemaVersion: 2, mode: 'local-model', executionAllowed: false, workspaceId: 'd'.repeat(64), revision: 0, updatedAt: 100,
    phase, stable: phase === 'committed' ? candidate : stable, lastKnownGood: phase === 'committed' ? candidate : stable,
    stableReleaseId: phase === 'committed' ? 'used-10-a1' : 'manual-initial-test',
    nginxRecovery: needsRecovery ? { version: 1, releaseId: 'used-10-a1', previousReleaseId: 'manual-initial-test', previous: stable, candidate, configPath: '/etc/nginx/conf.d/siteflow.conf',
      beforeHash: 'b'.repeat(64), afterHash: 'c'.repeat(64), backupFile: 'nginx-backup-used-10-a1.json', backupBytes: 10, planPhase: phase === 'committed' ? 'committed' : 'verifying', operation: 'reloaded' } : null,
    previous: phase === 'idle' ? null : stable, candidate: ['idle', 'preparing'].includes(phase) ? null : candidate, activeReleaseId: phase === 'idle' ? null : 'used-10-a1', consumedIds: phase === 'idle' ? [] : ['used-10-a1'], incident: phase === 'incident' ? 'MANUAL_REVIEW_REQUIRED' : null } };
}
function observation() { return { environment: { mounted: true, uuidMatches: true, volumeMatches: true, rootOwned: true, symlinkFree: true, mysqlHealthy: true }, route: stable, containers: [{ ...stable, running: true, ready: true }], configMatches: true,
  nginxConfigHash: 'b'.repeat(64), configurationExclusive: true, backupHash: 'b'.repeat(64), backupFile: 'nginx-backup-used-10-a1.json' }; }
test('recovery: stable initial 3001 is only a model, not deploy permission', () => {
  const r = assessRecovery(snapshot(), observation()); assert.equal(r.status, 'stable_model'); assert.equal(r.target.port, 3001);
  assert.equal(r.executionAllowed, false); assert.equal(r.newDeploymentsAllowed, false);
});
for (const phase of ['preparing', 'candidate_starting', 'candidate_checking', 'candidate_ready']) test(`recovery: interrupted ${phase} preserves old route and consumed ID`, () => {
  const s = snapshot(phase), r = assessRecovery(s, observation());
  assert.equal(r.requiredAction, 'keep_previous_and_review_candidate'); assert.equal(r.status, 'incident');
  assert.deepEqual(s.state.consumedIds, ['used-10-a1']);
});
for (const phase of ['switching', 'verifying', 'committing', 'rolling_back']) test(`recovery: uncertain ${phase} requires reviewed rollback`, () => {
  const o = observation(); o.route = candidate; o.nginxConfigHash = 'c'.repeat(64);
  const r = assessRecovery(snapshot(phase), o); assert.equal(r.requiredAction, 'review_then_restore_previous'); assert.equal(r.target.port, 3001);
});
test('recovery: committed state requires actual matching candidate observation', () => {
  const s = snapshot('committed'); assert.equal(assessRecovery(s, observation()).status, 'incident');
  const o = observation(); o.route = candidate; o.nginxConfigHash = 'c'.repeat(64); o.containers = [{ ...candidate, running: true, ready: true }];
  assert.equal(assessRecovery(s, o).status, 'stable_model');
});
test('recovery: reboot never clears incident', () => {
  assert.equal(assessRecovery(snapshot('incident'), observation()).reason, 'INCIDENT_REMAINS');
});
for (const key of ['mounted', 'uuidMatches', 'volumeMatches', 'rootOwned', 'symlinkFree', 'mysqlHealthy']) test(`recovery: ${key} false blocks recovery`, () => {
  const o = observation(); o.environment[key] = false;
  assert.equal(assessRecovery(snapshot('switching'), o).requiredAction, 'manual_review');
});
test('recovery: corruption and active/stale lock fail closed', () => {
  for (const s of [null, {}, { status: 'incident', state: null }, { ...snapshot(), state: { bad: true } }]) assert.equal(assessRecovery(s, observation()).status, 'incident');
});
test('recovery: Docker or Nginx mismatch and previous unavailable block automatic rollback', () => {
  for (const modify of [o => { o.containers = []; }, o => { o.containers[0].image = candidate.image; }, o => { o.configMatches = false; }, o => { o.route = candidate; }]) {
    const o = observation(); modify(o); assert.equal(assessRecovery(snapshot(), o).status, 'incident');
  }
  const o = observation(); o.containers = []; assert.equal(assessRecovery(snapshot('switching'), o).target, null);
});
test('recovery: old Vinext cannot become recovery target', () => {
  const s = snapshot('switching'); s.state.previous.port = 3002;
  assert.equal(assessRecovery(s, observation()).target, null);
});
test('recovery: missing observation and unsupported state version refused', () => {
  assert.equal(assessRecovery(snapshot(), null).status, 'incident');
  const s = snapshot(); s.state.schemaVersion = 3; assert.equal(assessRecovery(s, observation()).status, 'incident');
});
