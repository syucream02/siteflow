import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createLocalStateStore, inspectLocalState, validatePersistentModel } from '../deploy/poll/persistent-state.mjs';
import { acquireLocalLock, acquireLocalConfigLock, releaseLocalLock } from '../deploy/poll/lock.mjs';
import { advanceNginxPlan } from '../deploy/poll/nginx-plan.mjs';

const stable = { kind: 'nextjs', container: 'current', port: 3001, image: `sha256:${'a'.repeat(64)}` };
const candidate = { kind: 'nextjs', container: 'blue', port: 3101, image: `ghcr.io/syucream02/siteflow@sha256:${'b'.repeat(64)}` };
function local(name, run) {
  test(name, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-poll-stage5-'));
    try { run(root); } finally {
      const real = fs.realpathSync(root);
      assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
      assert.match(path.basename(real), /^siteflow-poll-stage5-[a-zA-Z0-9]+$/);
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
}
function setup(root, options = {}) {
  const lock = acquireLocalLock(root), store = createLocalStateStore(root, { now: () => 100, ...options });
  const state = store.initialize(lock, stable, 'manual-initial-test'); return { lock, store, state };
}
local('state: initialize and reopen after orderly unlock', root => {
  const { lock, store } = setup(root);
  assert.equal(store.read(lock).stable.port, 3001);
  assert.equal(store.executionAllowed, false); releaseLocalLock(lock);
  assert.equal(inspectLocalState(root).status, 'snapshot');
  const h = acquireLocalLock(root), reopened = createLocalStateStore(root, { now: () => 101 });
  assert.equal(reopened.read(h).revision, 0); releaseLocalLock(h);
});
local('state: consume ID before work and retain across restart', root => {
  const { lock, store } = setup(root);
  const s = store.consume(lock, 0, 'used-10-a1');
  assert.deepEqual(s.consumedIds, ['used-10-a1']);
  assert.equal(s.phase, 'preparing');
  assert.throws(() => store.consume(lock, 1, 'used-10-a1'), /REUSE/);
  releaseLocalLock(lock);
  assert.deepEqual(inspectLocalState(root).state.consumedIds, ['used-10-a1']);
});
local('state: full model checkpoint preserves previous Next.js and commits candidate', root => {
  const { lock, store } = setup(root); let s = store.consume(lock, 0, 'used-10-a1');
  for (const phase of ['candidate_starting', 'candidate_checking', 'candidate_ready']) {
    s = store.checkpoint(lock, s.revision, phase, candidate); assert.equal(s.executionAllowed, false);
  }
  const configLock = acquireLocalConfigLock(root), text = 'proxy_pass http://127.0.0.1:3001;\n';
  const digest = v => createHash('sha256').update(v).digest('hex');
  let plan = { mode: 'local-plan', executionAllowed: false, phase: 'candidate_ready', previous: stable, candidate,
    configPath: '/etc/nginx/conf.d/siteflow.conf', expectedHash: digest(text), nextHash: digest(text.replace(':3001;', ':3101;')) };
  const receipt = store.prepareNginxRecovery(lock, configLock, s.revision, plan, Buffer.from(text));
  for (const type of ['backup_saved', 'staged_validated', 'intent_saved', 'config_installed', 'config_validated', 'reloaded', 'public_checked', 'committed']) {
    plan = advanceNginxPlan(plan, { type, success: true, observation: type === 'public_checked' ? { ...candidate, running: true, ready: true, httpStatus: 200, ok: true, consecutive: 3, freshConnections: true, workerGenerationConfirmed: true } : null }, receipt);
  }
  s = store.read(lock); releaseLocalLock(configLock);
  assert.equal(s.previous.port, 3001); assert.equal(s.stable.port, 3101);
  assert.throws(() => store.consume(lock, s.revision, 'used-10-a1'), /REUSE/);
  const next = store.consume(lock, s.revision, 'used-11-a1');
  assert.equal(next.previous.port, 3101); releaseLocalLock(lock);
});
local('state: stale revision refused without changing state', root => {
  const { lock, store } = setup(root); store.consume(lock, 0, 'used-10-a1');
  assert.throws(() => store.consume(lock, 0, 'used-11-a1'), /STALE/); assert.equal(store.read(lock).revision, 1);
  releaseLocalLock(lock);
});
local('state: incident survives restart and has no reset method', root => {
  const { lock, store } = setup(root); store.consume(lock, 0, 'used-10-a1'); store.checkpoint(lock, 1, 'incident');
  assert.throws(() => store.consume(lock, 2, 'used-11-a1'), /INCIDENT/);
  releaseLocalLock(lock); assert.equal(inspectLocalState(root).state.phase, 'incident');
});
local('state: cannot initialize over existing workspace', root => {
  const { lock, store } = setup(root); assert.throws(() => store.initialize(lock, stable), /ALREADY_EXISTS/); releaseLocalLock(lock);
});
for (const point of ['after_intent', 'before_rename', 'after_rename', 'before_intent_clear']) {
  local(`state: injected crash at ${point} remains fail closed`, root => {
    const { lock } = setup(root);
    const store = createLocalStateStore(root, { now: () => 101, fault: step => { if (step === point) throw new Error('SIMULATED_CRASH'); } });
    assert.throws(() => store.consume(lock, 0, 'used-10-a1'), /WRITE_UNCERTAIN/);
    assert.equal(inspectLocalState(root).status, 'incident');
    assert.throws(() => store.read(lock)); assert.throws(() => releaseLocalLock(lock), /MANUAL_REVIEW/);
  });
}
for (const code of ['ENOSPC', 'EROFS']) {
  local(`state: simulated ${code} rejects further writes`, root => {
    const { lock } = setup(root);
    const store = createLocalStateStore(root, { now: () => 101, fault: step => { if (step === 'after_intent') throw Object.assign(new Error('IO_FAILURE'), { code }); } });
    assert.throws(() => store.consume(lock, 0, 'used-10-a1'), /WRITE_UNCERTAIN/);
    assert.equal(inspectLocalState(root).status, 'incident');
  });
}
for (const corrupt of ['{broken', '{"formatVersion":2}', '{}']) {
  local(`state: corrupt file ${corrupt} rejected`, root => {
    const { lock } = setup(root); fs.writeFileSync(path.join(root, 'state.json'), corrupt);
    assert.equal(inspectLocalState(root).status, 'incident'); releaseLocalLock(lock);
  });
}
local('state: rewind current snapshot cannot erase consumed ID', root => {
  const { lock, store } = setup(root), old = fs.readFileSync(path.join(root, 'state.json'));
  store.consume(lock, 0, 'used-10-a1'); fs.writeFileSync(path.join(root, 'state.json'), old);
  assert.throws(() => store.read(lock), /GENERATION/); releaseLocalLock(lock);
});
local('state: deleting used marker detected', root => {
  const { lock, store } = setup(root); store.consume(lock, 0, 'used-10-a1');
  fs.unlinkSync(path.join(root, 'used-10-a1.json')); assert.throws(() => store.read(lock), /MARKER/); releaseLocalLock(lock);
});
local('state: changing marker content detected', root => {
  const { lock, store } = setup(root); store.consume(lock, 0, 'used-10-a1');
  fs.writeFileSync(path.join(root, 'used-10-a1.json'), '{}'); assert.throws(() => store.read(lock), /MARKER/); releaseLocalLock(lock);
});
local('state: checksum does not accept payload change', root => {
  const { lock, store } = setup(root), p = path.join(root, 'state.json');
  const value = JSON.parse(fs.readFileSync(p)); value.payload.updatedAt++; fs.writeFileSync(p, JSON.stringify(value));
  assert.throws(() => store.read(lock), /CHECKSUM/); releaseLocalLock(lock);
});
local('state: Vinext, migration phase and candidate replacement refused', root => {
  const { lock, store, state } = setup(root);
  assert.throws(() => validatePersistentModel({ ...state, stable: { ...stable, port: 3002 } }));
  store.consume(lock, 0, 'used-10-a1');
  assert.throws(() => store.checkpoint(lock, 1, 'migration', candidate), /TRANSITION/);
  store.checkpoint(lock, 1, 'candidate_starting', candidate);
  assert.throws(() => store.checkpoint(lock, 2, 'candidate_checking', { ...candidate, image: `ghcr.io/syucream02/siteflow@sha256:${'c'.repeat(64)}` }), /CHANGED/);
  releaseLocalLock(lock);
});
local('state: unknown fields and backward clock refused', root => {
  const { lock, state } = setup(root);
  assert.throws(() => validatePersistentModel({ ...state, approved: true }), /FIELDS/);
  const store = createLocalStateStore(root, { now: () => 99 });
  assert.throws(() => store.consume(lock, 0, 'used-10-a1'), /CLOCK/); releaseLocalLock(lock);
});
local('state: unsupported version, future revision and execution permission refused', root => {
  const { lock, state } = setup(root);
  for (const change of [{ schemaVersion: 0 }, { revision: -1 }, { revision: 10000000000 }, { executionAllowed: true }, { consumedIds: ['used-1-a1', 'used-1-a1'] }]) {
    assert.throws(() => validatePersistentModel({ ...state, ...change }));
  }
  releaseLocalLock(lock);
});
local('state: contradictory stable, previous and candidate metadata refused', root => {
  const { lock, store } = setup(root);
  const initial = store.read(lock);
  assert.throws(() => validatePersistentModel({ ...initial, previous: stable }), /INITIAL/);
  const preparing = store.consume(lock, 0, 'used-10-a1');
  assert.throws(() => validatePersistentModel({ ...preparing, previous: candidate }), /STABLE_MISMATCH/);
  const starting = store.checkpoint(lock, 1, 'candidate_starting', candidate);
  assert.throws(() => validatePersistentModel({ ...starting, candidate: { ...candidate, port: 3102 } }), /SAVED_CANDIDATE/);
  assert.throws(() => validatePersistentModel({ ...starting, phase: 'committed' }), /COMMITTED/);
  releaseLocalLock(lock);
});
local('state: malformed release IDs cannot introduce path traversal', root => {
  const { lock, store } = setup(root);
  for (const id of ['../state', 'used-0-a1', 'used-1-a0', 'used-1-a1.json', 'used-1-a1/../', true, null]) assert.throws(() => store.consume(lock, 0, id));
  assert.equal(store.read(lock).revision, 0); releaseLocalLock(lock);
});
local('state: used marker creation conflict leaves incident and preserves existing marker', root => {
  const { lock, store } = setup(root);
  // An unexpected file is rejected before the write transaction begins.
  fs.writeFileSync(path.join(root, 'used-10-a1.json'), 'preserved');
  assert.throws(() => store.consume(lock, 0, 'used-10-a1'), /MARKER/);
  assert.equal(fs.readFileSync(path.join(root, 'used-10-a1.json'), 'utf8'), 'preserved');
  releaseLocalLock(lock);
});
local('state: partial workspace cannot reset old history', root => {
  fs.writeFileSync(path.join(root, 'workspace.json'), '{}');
  const lock = acquireLocalLock(root), store = createLocalStateStore(root, { now: () => 100 });
  assert.throws(() => store.initialize(lock, stable), /ALREADY_EXISTS/);
  assert.equal(inspectLocalState(root).status, 'incident'); releaseLocalLock(lock);
});
for (const point of ['before_rename', 'after_rename']) {
  local(`state: actual child abrupt exit ${point} leaves uncertain state`, root => {
    const { lock } = setup(root); releaseLocalLock(lock);
    const storeUrl = new URL('../deploy/poll/persistent-state.mjs', import.meta.url).href;
    const lockUrl = new URL('../deploy/poll/lock.mjs', import.meta.url).href;
    const code = `import {createLocalStateStore} from ${JSON.stringify(storeUrl)}; import {acquireLocalLock} from ${JSON.stringify(lockUrl)}; const root=${JSON.stringify(root)}; const h=acquireLocalLock(root); const s=createLocalStateStore(root,{now:()=>101,fault:p=>{if(p===${JSON.stringify(point)})process.exit(23)}}); s.consume(h,0,'used-10-a1');`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    assert.equal(child.status, 23); assert.equal(inspectLocalState(root).status, 'incident');
    assert.throws(() => acquireLocalLock(root), /EEXIST/);
  });
}
for (const point of ['after_intent', 'before_rename', 'after_rename']) local(`Review1: forward deadline crossing ${point} never reports a successful durable advance`, root => {
  const { lock, store } = setup(root); const active = store.consume(lock, 0, 'used-10-a1'); let clock = 101;
  const bounded = createLocalStateStore(root, { now: () => clock, forwardDeadline: 200, fault: at => { if (at === point) clock = 200; } });
  assert.throws(() => bounded.checkpoint(lock, active.revision, 'candidate_starting', candidate), /STATE_WRITE_UNCERTAIN/);
  assert.equal(inspectLocalState(root).status, 'incident'); assert.ok(fs.existsSync(path.join(root, 'used-10-a1.json')));
});
