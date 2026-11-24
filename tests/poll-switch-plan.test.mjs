import test from 'node:test';
import assert from 'node:assert/strict';
import { createSwitchPlan, advanceSwitchPlan } from '../deploy/poll/switch-plan.mjs';

const stable = { kind: 'nextjs', container: 'current', port: 3001, image: `sha256:${'a'.repeat(64)}` };
const candidate = { kind: 'nextjs', container: 'blue', port: 3101, image: `ghcr.io/syucream02/siteflow@sha256:${'b'.repeat(64)}` };
const environment = { mounted: true, uuidMatches: true, volumeMatches: true, rootOwned: true, symlinkFree: true, mysqlHealthy: true };
const observe = (s = stable) => ({ environment: { ...environment }, route: s, containers: [{ ...s, running: true, ready: true }], listeners: [{ port: s.port, container: s.container }], configHash: 'd'.repeat(64) });
const steps = ['candidate_started', 'candidate_checked', 'previous_saved', 'nginx_checked', 'switch_intent_saved', 'route_changed', 'nginx_reloaded', 'public_checked', 'commit_saved'];
function event(type, slot = candidate) {
  return ['candidate_checked', 'public_checked', 'rollback_checked'].includes(type) ? { type, success: true, observed: { ...slot, running: true, ready: true, httpsStatus: 200, ok: true, consecutive: 3 } } : { type, success: true };
}
function at(count) { let p = createSwitchPlan(stable, candidate, observe()); for (const type of steps.slice(0, count)) p = advanceSwitchPlan(p, event(type)); return p; }
test('switch: full ordered plan from 3001 to 3101 preserves previous', () => {
  const p = at(9); assert.equal(p.phase, 'committed'); assert.equal(p.previous.port, 3001);
  assert.equal(p.stable.port, 3101); assert.equal(p.executionAllowed, false);
});
test('switch: future 3101 to 3102 then 3102 to 3101', () => {
  const blue = candidate, green = { ...candidate, port: 3102, container: 'green' };
  assert.equal(createSwitchPlan(blue, green, observe(blue)).candidate.port, 3102);
  assert.equal(createSwitchPlan(green, blue, observe(green)).candidate.port, 3101);
});
for (const key of Object.keys(environment)) test(`switch: unsafe ${key} blocks plan`, () => {
  const o = observe(); o.environment[key] = false; assert.throws(() => createSwitchPlan(stable, candidate, o), /UNSAFE/);
});
test('switch: free port alone insufficient when container exists', () => {
  const o = observe(); o.containers.push({ ...candidate, running: false });
  assert.throws(() => createSwitchPlan(stable, candidate, o), /IN_USE/);
});
test('switch: non-Docker listener prevents candidate use', () => {
  const o = observe(); o.listeners.push({ port: 3101, container: null }); assert.throws(() => createSwitchPlan(stable, candidate, o), /IN_USE/);
});
test('switch: mismatching route, listener and unhealthy previous refused', () => {
  for (const modify of [o => { o.route = candidate; }, o => { o.listeners = []; }, o => { o.containers[0].ready = false; }]) {
    const o = observe(); modify(o); assert.throws(() => createSwitchPlan(stable, candidate, o));
  }
});
for (const count of [0, 1, 2, 3, 4]) test(`switch: pre-public step failure ${steps[count]} cannot switch route`, () => {
  const e = event(steps[count]); e.success = false;
  const p = advanceSwitchPlan(at(count), e); assert.equal(p.phase, 'incident'); assert.equal(p.requiredAction, 'manual_review');
});
for (const count of [5, 6, 7]) test(`switch: post-intent ${steps[count]} failure requests previous Next.js`, () => {
  const e = event(steps[count]); e.success = false;
  const p = advanceSwitchPlan(at(count), e); assert.equal(p.phase, 'rolling_back'); assert.equal(p.previous.port, 3001);
  const failure = advanceSwitchPlan(p, { type: 'rollback_checked', success: false, observed: null });
  assert.equal(failure.phase, 'incident'); assert.equal(failure.reason, 'ROLLBACK_FAILED');
  const restored = advanceSwitchPlan(p, event('rollback_checked', stable));
  assert.equal(restored.stable.port, 3001); assert.equal(restored.phase, 'incident');
});
test('switch: unknown commit outcome never claims success', () => {
  assert.equal(advanceSwitchPlan(at(8), { type: 'commit_saved', success: false }).reason, 'COMMIT_OUTCOME_UNKNOWN');
});
test('switch: missing health evidence and insufficient consecutive public checks rejected', () => {
  const e = event('public_checked'); e.observed.consecutive = 2;
  assert.equal(advanceSwitchPlan(at(7), e).phase, 'rolling_back');
  const c = event('candidate_checked'); c.observed.image = stable.image;
  assert.equal(advanceSwitchPlan(at(1), c).phase, 'incident');
});
test('switch: no skipping checks, migration or Vinext rollback', () => {
  assert.throws(() => advanceSwitchPlan(at(0), event('route_changed')), /TRANSITION/);
  assert.throws(() => advanceSwitchPlan(at(0), { type: 'migration', success: true }), /TRANSITION/);
  assert.throws(() => createSwitchPlan({ ...stable, port: 3002 }, candidate, observe()), /NEXTJS_PORT/);
  const p = at(5); p.previous = { ...stable, port: 3002 };
  assert.throws(() => advanceSwitchPlan(p, event('route_changed')));
});
for (let count = 0; count < 9; count++) test(`switch: abrupt outcome unknown at step ${count} requires manual review`, () => {
  const p = advanceSwitchPlan(at(count), { type: 'crash' }); assert.equal(p.phase, 'incident');
  assert.throws(() => advanceSwitchPlan(p, event('candidate_started')), /TERMINAL/);
});
