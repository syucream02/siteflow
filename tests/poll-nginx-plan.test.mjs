import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNginxPlan, advanceNginxPlan as advanceRecordedPlan, readinessRequest } from '../deploy/poll/nginx-plan.mjs';
import { pathChain } from '../deploy/poll/linux-storage.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalStateStore } from '../deploy/poll/persistent-state.mjs';
import { acquireLocalLock, acquireLocalConfigLock, releaseLocalLock } from '../deploy/poll/lock.mjs';

const stable = { kind: 'nextjs', container: 'current', port: 3001, image: `sha256:${'e'.repeat(64)}` };
const candidate = { kind: 'nextjs', container: 'blue', port: 3101, image: `ghcr.io/syucream02/siteflow@sha256:${'b'.repeat(64)}` };
const hash = t => createHash('sha256').update(t).digest('hex');
function fixture() {
  const text = 'server {\n  listen 443 ssl;\n  ssl_certificate /etc/letsencrypt/live/siteflow/fullchain.pem;\n  ssl_certificate_key /etc/letsencrypt/live/siteflow/privkey.pem;\n  location / {\n    proxy_pass http://127.0.0.1:3001;\n    proxy_set_header Host $host;\n    proxy_set_header X-Forwarded-Proto $scheme;\n  }\n}\n';
  return { stable: { ...stable }, candidate: { ...candidate }, origin: 'https://siteflow.invalid',
    config: { path: '/etc/nginx/conf.d/siteflow.conf', realPath: '/etc/nginx/conf.d/siteflow.conf', uid: 0, mode: 0o644, symlink: false, links: 1,
      parentEntries: pathChain('/etc/nginx/conf.d').map(p => ({ path: p, realPath: p, uid: 0, gid: 0, mode: 0o755, symlink: false, type: 'directory', deviceId: 1 })), text, reviewedHash: hash(text) },
    observed: { currentUpstreamPort: 3001, stable: { ...stable, running: true, ready: true }, candidate: { ...candidate, running: true, ready: true }, configurationExclusive: true, nginxHealthy: true } };
}
const contexts = new WeakMap(), temporary = [];
afterEach(() => {
  for (const c of temporary.splice(0)) {
    for (const lock of [c.configLock, c.lock]) if (lock) { try { releaseLocalLock(lock); } catch { /* 不確定ロックの自動解除はしない。試験領域だけを回収。 */ } }
    const root = fs.realpathSync(c.root);
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^siteflow-poll-stage5-[a-zA-Z0-9]+$/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function advanceNginxPlan(plan, e) {
  let c = contexts.get(plan);
  if (!c) {
    c = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-poll-stage5-')) }; temporary.push(c);
    c.lock = acquireLocalLock(c.root); c.store = createLocalStateStore(c.root, { now: () => 100 });
    let s = c.store.initialize(c.lock, plan.previous, 'manual-nginx-test'); s = c.store.consume(c.lock, s.revision, 'used-101-a1');
    for (const phase of ['candidate_starting', 'candidate_checking', 'candidate_ready']) s = c.store.checkpoint(c.lock, s.revision, phase, plan.candidate);
    c.configLock = acquireLocalConfigLock(c.root);
    c.receipt = c.store.prepareNginxRecovery(c.lock, c.configLock, s.revision, plan, Buffer.from(fixture().config.text));
  }
  const next = advanceRecordedPlan(plan, e, c.receipt); contexts.set(next, c); return next;
}
const steps = ['backup_saved', 'staged_validated', 'intent_saved', 'config_installed', 'config_validated', 'reloaded', 'public_checked', 'committed'];
const publicObservation = slot => ({ ...slot, running: true, ready: true, httpStatus: 200, ok: true, consecutive: 3, freshConnections: true, workerGenerationConfirmed: true });
const event = type => ({ type, success: true, observation: type === 'public_checked' ? publicObservation(candidate) : type === 'rollback_checked' ? publicObservation(stable) : null });
function at(n) { let p = createNginxPlan(fixture()); for (const t of steps.slice(0, n)) p = advanceNginxPlan(p, event(t)); return p; }
test('nginx: only upstream changes, certificates/headers preserved, no config body in output', () => {
  const d = fixture(), before = structuredClone(d), p = createNginxPlan(d);
  assert.equal(p.executionAllowed, false); assert.equal(p.previous.port, 3001);
  assert.equal(p.nextHash, hash(d.config.text.replace('proxy_pass http://127.0.0.1:3001;', 'proxy_pass http://127.0.0.1:3101;')));
  assert.equal(Object.hasOwn(p, 'text'), false); assert.deepEqual(d, before);
  assert.equal(at(8).phase, 'committed');
});
test('nginx: readiness sends public Host/https, fresh connections, 3 successes within 30s', () => {
  const r = readinessRequest('https://siteflow.invalid', 3101);
  assert.deepEqual(r.headers, { Host: 'siteflow.invalid', 'X-Forwarded-Proto': 'https' });
  assert.equal(r.internalUrl, 'http://127.0.0.1:3101/api/ready'); assert.equal(r.connectionReuse, false);
  assert.equal(r.maximumWaitSeconds, 30); assert.equal(r.consecutiveSuccesses, 3);
  for (const [origin, port] of [['http://siteflow.invalid', 3101], ['https://x:y@siteflow.invalid', 3101], ['https://siteflow.invalid', 3002], ['https://siteflow.invalid', 3306]]) assert.throws(() => readinessRequest(origin, port));
});
for (const port of [3101, 3102]) test(`nginx: blue-green starting at ${port}`, () => {
  const d = fixture(); d.stable.port = port; d.candidate.port = port === 3101 ? 3102 : 3101;
  d.config.text = d.config.text.replace(':3001;', `:${port};`); d.config.reviewedHash = hash(d.config.text);
  d.observed.currentUpstreamPort = port; d.observed.stable.port = port; d.observed.candidate.port = d.candidate.port;
  assert.equal(createNginxPlan(d).candidate.port, d.candidate.port);
});
const cases = [
  ['Vinext target', d => { d.candidate.port = 3002; }], ['DB target', d => { d.candidate.port = 3306; }],
  ['unbound local candidate image', d => { d.candidate.image = stable.image; }],
  ['wrong reviewed hash', d => { d.config.reviewedHash = 'a'.repeat(64); }],
  ['missing candidate health', d => { d.observed.candidate.ready = false; }],
  ['wrong candidate image', d => { d.observed.candidate.image = stable.image; }],
  ['no configuration lock', d => { d.observed.configurationExclusive = false; }],
  ['wrong current route', d => { d.observed.currentUpstreamPort = 3002; }],
  ['symlink file', d => { d.config.symlink = true; }], ['non-root parent', d => { d.config.parentEntries[1].uid = 1000; }],
  ['wrong config path', d => { d.config.path = '/etc/nginx/nginx.conf'; }],
];
for (const [name, modify] of cases) test(`nginx refuses ${name}`, () => { const d = fixture(); modify(d); assert.throws(() => createNginxPlan(d)); });
for (const text of ['proxy_pass http://127.0.0.1:3002;', 'proxy_pass http://$unknown;', fixture().config.text + '\nproxy_pass http://127.0.0.1:3001;', fixture().config.text.replace('X-Forwarded-Proto $scheme', 'X-Forwarded-Proto http')]) test('nginx: unsupported/ambiguous layout fails closed', () => {
  const d = fixture(); d.config.text = text; d.config.reviewedHash = hash(text); assert.throws(() => createNginxPlan(d));
});
for (let i = 0; i < steps.length; i++) test(`nginx: failure at ${steps[i]} stops or plans rollback, never commits`, () => {
  const e = event(steps[i]); e.success = false;
  const p = advanceNginxPlan(at(i), e); assert.notEqual(p.phase, 'committed'); assert.equal(p.executionAllowed, false);
  if (i >= 3 && i < 7) assert.equal(p.phase, 'rolling_back');
});
test('nginx: reload failure -> restore -> validate -> reload -> previous HTTPS, incident remains', () => {
  let p = advanceNginxPlan(at(5), { type: 'reloaded', success: false, observation: null });
  for (const t of ['rollback_restored', 'rollback_validated', 'rollback_reloaded', 'rollback_checked']) p = advanceNginxPlan(p, event(t));
  assert.equal(p.phase, 'incident'); assert.equal(p.reason, 'ROLLED_BACK_INCIDENT_REMAINS');
  assert.equal(p.previous.port, 3001); assert.throws(() => advanceNginxPlan(p, event('backup_saved')));
});
for (const t of ['rollback_restored', 'rollback_validated', 'rollback_reloaded', 'rollback_checked']) test(`nginx: ${t} failure latches incident`, () => {
  let p = advanceNginxPlan(at(5), { type: 'reloaded', success: false, observation: null });
  for (const type of ['rollback_restored', 'rollback_validated', 'rollback_reloaded', 'rollback_checked']) {
    const e = event(type); if (type === t) e.success = false;
    p = advanceNginxPlan(p, e); if (type === t) break;
  }
  assert.equal(p.phase, 'incident'); assert.equal(p.reason, 'ROLLBACK_FAILED');
});
for (const k of ['freshConnections', 'workerGenerationConfirmed', 'ok']) test(`nginx: missing ${k} rejects public success`, () => {
  const e = event('public_checked'); e.observation[k] = false;
  assert.equal(advanceNginxPlan(at(6), e).phase, 'rolling_back');
});
for (const value of ['3', 2, Infinity, 31, null]) test(`nginx: invalid consecutive count ${String(value)} rejected`, () => {
  const e = event('public_checked'); e.observation.consecutive = value;
  assert.equal(advanceNginxPlan(at(6), e).phase, 'rolling_back');
});
test('nginx: no configuration text/secret-like directive is returned in plan', () => {
  const d = fixture(); d.config.text += '# DUMMY_SECRET_SENTINEL\n'; d.config.reviewedHash = hash(d.config.text);
  const p = createNginxPlan(d); assert.equal(JSON.stringify(p).includes('DUMMY_SECRET_SENTINEL'), false);
});
test('nginx: stopping before/after install intent has distinct recovery action', () => {
  const e = { type: 'abort', success: false, observation: null };
  assert.equal(advanceNginxPlan(at(0), e).phase, 'incident');
  assert.equal(advanceNginxPlan(at(3), e).phase, 'rolling_back');
  assert.throws(() => advanceNginxPlan(at(0), event('reloaded')));
});
