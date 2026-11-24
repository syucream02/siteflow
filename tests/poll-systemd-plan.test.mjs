import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemdPlan, assessSystemdStart as assess } from '../deploy/poll/systemd-plan.mjs';

const policy = { mount: '/srv/siteflow-mysql', uuid: '11111111-2222-3333-4444-555555555555', volumeId: 'vol-11111111111111111',
  stateDirectory: '/srv/siteflow-mysql/poll-state', mysqlDataDirectory: '/srv/siteflow-mysql/data', minFreeBytes: 256 * 1024 * 1024 };
const assessSystemdStart = (plan, observation) => assess(plan, observation, policy);
const observed = () => ({ mountReady: true, dockerReady: true, networkReady: true, mysqlHealthy: true, clockSynchronized: true,
  paused: false, incident: false, residualLock: false, serviceActive: false, lockHeld: false,
  dependencies: ['srv-siteflow\\x2dmysql.mount', 'docker.service', 'network-online.target', 'siteflow-mysql.service'] });
test('systemd: disabled/paused initial plan, five minutes after completion, no retry storm', () => {
  const p = createSystemdPlan(policy); assert.equal(p.executionAllowed, false);
  assert.deepEqual(p.initial, { enabled: false, paused: true });
  assert.equal(p.timer.onUnitInactiveSec, 300); assert.equal(p.timer.persistent, false);
  assert.equal(p.service.restart, 'no'); assert.equal(p.service.remainAfterExit, false);
  assert.equal(p.service.limitCore, 0); assert.equal(p.service.memorySwapMax, 0);
  assert.deepEqual(p.service.commandArguments, []); assert.deepEqual(p.service.environmentSecrets, []);
  assert.equal(assessSystemdStart(p, observed()).executionAllowed, false);
  assert.equal(p.service.requires.includes('siteflow-mysql.service'), false); // CDから既存DBを勝手に起動しない。
});
for (const k of ['mountReady', 'dockerReady', 'networkReady', 'mysqlHealthy', 'clockSynchronized']) test(`systemd: ${k} false blocks start`, () => {
  const o = observed(); o[k] = false; assert.throws(() => assessSystemdStart(createSystemdPlan(policy), o));
});
for (const k of ['paused', 'incident', 'residualLock', 'serviceActive', 'lockHeld']) test(`systemd: ${k} blocks duplicate/recovery start`, () => {
  const o = observed(); o[k] = true; assert.throws(() => assessSystemdStart(createSystemdPlan(policy), o));
});
test('systemd: missing observations and dependency configuration rejected', () => {
  const p = createSystemdPlan(policy), o = observed(); p.service.after = ['docker.service'];
  assert.throws(() => assessSystemdStart(p, o));
  const fresh = createSystemdPlan(policy); o.dependencies = []; assert.throws(() => assessSystemdStart(fresh, o));
  delete o.mountReady; assert.throws(() => assessSystemdStart(fresh, o));
});
for (const modify of [p => { p.service.restart = 'always'; }, p => { p.service.remainAfterExit = true; }, p => { p.timer.onUnitInactiveSec = 1; }, p => { p.timer.persistent = true; }]) test('systemd: unsafe restart/timer policy refused', () => {
  const p = createSystemdPlan(policy); modify(p); assert.throws(() => assessSystemdStart(p, observed()));
});
for (const modify of [p => { p.service.limitCore = 1; }, p => { p.service.memorySwapMax = 100; }, p => { p.service.protectSystem = 'no'; },
  p => { p.service.commandArguments.push('DUMMY_SECRET_SENTINEL'); }, p => { p.service.standardError = 'journal'; }]) test('systemd: unsafe hardening or raw log/argument settings refused', () => {
  const p = createSystemdPlan(policy); modify(p); assert.throws(() => assessSystemdStart(p, observed()));
});
test('systemd: modifying write scope, install state or unrecognized fields rejected', () => {
  for (const modify of [p => { p.service.readWritePaths = [policy.mysqlDataDirectory]; }, p => { p.initial.enabled = true; }, p => { p.service.exec = '/bin/sh'; }]) {
    const p = createSystemdPlan(policy); modify(p); assert.throws(() => assessSystemdStart(p, observed()), /PLAN_CHANGED/);
  }
});
