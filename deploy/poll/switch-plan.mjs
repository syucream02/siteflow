import { createState } from './state.mjs';
import { exactFields, need } from './contract.mjs';

export function validateNextSlot(slot) { createState(slot, 0); return structuredClone(slot); }
export function validateModelEnvironment(e) {
  exactFields(e, ['mounted', 'uuidMatches', 'volumeMatches', 'rootOwned', 'symlinkFree', 'mysqlHealthy'], 'INVALID_ENVIRONMENT_OBSERVATION');
  need(Object.values(e).every(v => v === true), 'UNSAFE_ENVIRONMENT_OBSERVATION');
  // これらは模擬観測であり、実EBS・root所有の証拠ではない。
}
export function sameSlot(a, b) {
  return a?.kind === b?.kind && a?.container === b?.container && a?.port === b?.port && a?.image === b?.image;
}
export function createSwitchPlan(stable, candidate, observed) {
  validateNextSlot(stable); validateNextSlot(candidate);
  exactFields(observed, ['environment', 'route', 'containers', 'listeners', 'configHash'], 'INVALID_SWITCH_OBSERVATION');
  validateModelEnvironment(observed.environment);
  need(sameSlot(observed.route, stable) && typeof observed.configHash === 'string' && /^[a-f0-9]{64}$/.test(observed.configHash) &&
    !/^0+$/.test(observed.configHash), 'CURRENT_ROUTE_MISMATCH');
  const expected = stable.port === 3101 ? 3102 : 3101;
  need(candidate.port === expected && candidate.container !== stable.container &&
    candidate.image.startsWith('ghcr.io/syucream02/siteflow@'), 'CANDIDATE_SLOT_MISMATCH');
  need(Array.isArray(observed.containers) && Array.isArray(observed.listeners), 'INCOMPLETE_RUNTIME_OBSERVATION');
  const current = observed.containers.filter(c => c.container === stable.container);
  need(current.length === 1 && sameSlot(current[0], stable) && current[0].running === true && current[0].ready === true, 'STABLE_CONTAINER_NOT_HEALTHY');
  need(!observed.containers.some(c => c.port === candidate.port || c.container === candidate.container) &&
    !observed.listeners.some(l => l.port === candidate.port), 'CANDIDATE_PORT_OR_CONTAINER_IN_USE');
  const listeners = observed.listeners.filter(l => l.port === stable.port);
  need(listeners.length === 1 && listeners[0].container === stable.container, 'STABLE_LISTENER_MISMATCH');
  return { mode: 'local-model', executionAllowed: false, phase: 'preparing', stable: structuredClone(stable),
    previous: null, candidate: structuredClone(candidate), configHash: observed.configHash,
    requiredAction: 'persist_prepare_intent', reason: null };
}

// 外部作用を実行しない。イベントも模擬値であり、本番への許可ではない。
export function advanceSwitchPlan(plan, event) {
  need(plan?.mode === 'local-model' && plan.executionAllowed === false && event && typeof event.type === 'string', 'INVALID_SWITCH_MODEL');
  validateNextSlot(plan.stable); validateNextSlot(plan.candidate);
  if (plan.previous !== null) validateNextSlot(plan.previous);
  need(plan.phase !== 'incident' && plan.phase !== 'committed', 'SWITCH_MODEL_TERMINAL');
  const next = structuredClone(plan);
  if (event.type === 'crash') {
    exactFields(event, ['type']); return { ...next, phase: 'incident', requiredAction: 'manual_review', reason: 'OUTCOME_UNKNOWN' };
  }
  const edges = {
    candidate_started: ['preparing', 'candidate_checking', 'check_candidate'],
    candidate_checked: ['candidate_checking', 'candidate_ready', 'persist_previous'],
    previous_saved: ['candidate_ready', 'validating', 'validate_nginx_config'],
    nginx_checked: ['validating', 'switch_ready', 'persist_switch_intent'],
    switch_intent_saved: ['switch_ready', 'switching', 'switch_route'],
    route_changed: ['switching', 'reload_pending', 'reload_nginx'],
    nginx_reloaded: ['reload_pending', 'verifying', 'verify_public'],
    public_checked: ['verifying', 'commit_pending', 'persist_commit'],
    commit_saved: ['commit_pending', 'committed', null],
    rollback_checked: ['rolling_back', 'incident', 'manual_review'],
  };
  need(Object.hasOwn(edges, event.type) && edges[event.type][0] === plan.phase, 'INVALID_SWITCH_TRANSITION');
  const requiresObservation = ['candidate_checked', 'public_checked', 'rollback_checked'].includes(event.type);
  exactFields(event, requiresObservation ? ['type', 'success', 'observed'] : ['type', 'success'], 'INVALID_SWITCH_EVENT');
  need(typeof event.success === 'boolean', 'INVALID_SWITCH_RESULT');
  let ok = event.success;
  if (requiresObservation && ok) {
    const expected = event.type === 'rollback_checked' ? plan.previous : plan.candidate;
    need(expected, 'ROLLBACK_TARGET_MISSING'); validateNextSlot(expected);
    ok = sameSlot(event.observed, expected) && event.observed.running === true && event.observed.ready === true;
    if (event.type !== 'candidate_checked') ok = ok && event.observed.httpsStatus === 200 &&
      event.observed.ok === true && Number.isInteger(event.observed.consecutive) && event.observed.consecutive >= 3;
  }
  if (!ok) {
    const uncertainCommit = plan.phase === 'commit_pending';
    const switched = ['switching', 'reload_pending', 'verifying', 'rolling_back'].includes(plan.phase);
    return { ...next, phase: switched && plan.phase !== 'rolling_back' ? 'rolling_back' : 'incident',
      requiredAction: switched && plan.phase !== 'rolling_back' ? 'restore_previous_route' : 'manual_review',
      reason: uncertainCommit ? 'COMMIT_OUTCOME_UNKNOWN' : plan.phase === 'rolling_back' ? 'ROLLBACK_FAILED' : 'STEP_FAILED' };
  }
  next.phase = edges[event.type][1]; next.requiredAction = edges[event.type][2];
  if (event.type === 'previous_saved') next.previous = structuredClone(plan.stable);
  if (event.type === 'switch_intent_saved') need(plan.previous && sameSlot(plan.previous, plan.stable), 'PREVIOUS_NOT_PRESERVED');
  if (event.type === 'commit_saved') next.stable = structuredClone(plan.candidate);
  if (event.type === 'rollback_checked') {
    next.stable = structuredClone(plan.previous); next.reason = 'ROLLED_BACK_REVIEW_REQUIRED';
  }
  return next;
}
