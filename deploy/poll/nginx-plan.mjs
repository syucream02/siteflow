import { createHash } from 'node:crypto';
import { exactFields, need } from './contract.mjs';
import { sameSlot, validateNextSlot } from './switch-plan.mjs';
import { validateRootChain } from './linux-storage.mjs';
import { readRecordedNginxPlan, recordNginxTransition } from './persistent-state.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
export function readinessRequest(originText, port) {
  let origin;
  try { origin = new URL(originText); } catch { throw new Error('INVALID_READINESS_ORIGIN'); }
  need(origin.protocol === 'https:' && origin.origin === originText && !origin.username && !origin.password && !origin.port &&
    [3001, 3101, 3102].includes(port), 'INVALID_READINESS_TARGET');
  return { mode: 'local-plan', executionAllowed: false, internalUrl: `http://127.0.0.1:${port}/api/ready`, publicUrl: `${originText}/api/ready`,
    headers: { Host: origin.host, 'X-Forwarded-Proto': 'https' }, connectionReuse: false, maximumWaitSeconds: 30, consecutiveSuccesses: 3 };
}
function healthy(observed, slot, publicly = false) {
  return sameSlot(observed, slot) && observed.running === true && observed.ready === true &&
    (!publicly || (observed.httpStatus === 200 && observed.ok === true && Number.isSafeInteger(observed.consecutive) && observed.consecutive >= 3 && observed.consecutive <= 30 &&
      observed.freshConnections === true && observed.workerGenerationConfirmed === true));
}
// 現行の単一proxy_passを含むレビュー済み全設定だけ対象。include方式への移行は追加しない。
// 本文を結果/例外へ返さない。staged全設定の検査・reloadの実adapterは未実装。
export function createNginxPlan(data) {
  exactFields(data, ['stable', 'candidate', 'origin', 'config', 'observed'], 'INVALID_NGINX_PLAN_INPUT');
  const { stable, candidate, origin, config, observed } = data;
  validateNextSlot(stable); validateNextSlot(candidate);
  need(candidate.port === (stable.port === 3101 ? 3102 : 3101) && candidate.container !== stable.container &&
    candidate.image.startsWith('ghcr.io/syucream02/siteflow@'), 'INVALID_NGINX_CANDIDATE');
  exactFields(config, ['path', 'realPath', 'uid', 'mode', 'symlink', 'links', 'parentEntries', 'text', 'reviewedHash'], 'INVALID_NGINX_METADATA');
  validateRootChain('/etc/nginx/conf.d', config.parentEntries, 0o755);
  need(config.path === '/etc/nginx/conf.d/siteflow.conf' && config.realPath === config.path && config.uid === 0 &&
    [0o600, 0o644].includes(config.mode) && config.symlink === false && config.links === 1 &&
    typeof config.text === 'string' && Buffer.byteLength(config.text) <= 65536 && !config.text.includes('\0') &&
    /^[a-f0-9]{64}$/.test(config.reviewedHash) && !/^0+$/.test(config.reviewedHash) && hash(config.text) === config.reviewedHash, 'UNTRUSTED_NGINX_CONFIG');
  const expectedLine = `proxy_pass http://127.0.0.1:${stable.port};`;
  const pattern = /^([ \t]*)proxy_pass http:\/\/127\.0\.0\.1:(3001|3101|3102);\r?$/gm;
  const matches = [...config.text.matchAll(pattern)];
  need(matches.length === 1 && Number(matches[0][2]) === stable.port &&
    (config.text.match(/\bproxy_pass\b/g) ?? []).length === 1 &&
    /^\s*proxy_set_header Host \$host;\r?$/m.test(config.text) &&
    /^\s*proxy_set_header X-Forwarded-Proto \$scheme;\r?$/m.test(config.text), 'UNSUPPORTED_NGINX_LAYOUT_OR_HEADERS');
  exactFields(observed, ['currentUpstreamPort', 'stable', 'candidate', 'configurationExclusive', 'nginxHealthy'], 'INVALID_NGINX_OBSERVATION');
  need(observed.currentUpstreamPort === stable.port && healthy(observed.stable, stable) && healthy(observed.candidate, candidate) &&
    observed.configurationExclusive === true && observed.nginxHealthy === true, 'NGINX_OR_CANDIDATE_NOT_READY');
  const replacement = `proxy_pass http://127.0.0.1:${candidate.port};`;
  const offset = matches[0].index + matches[0][1].length;
  const next = config.text.slice(0, offset) + replacement + config.text.slice(offset + expectedLine.length);
  return { mode: 'local-plan', executionAllowed: false, phase: 'candidate_ready', previous: structuredClone(stable), candidate: structuredClone(candidate),
    configPath: config.path, expectedHash: config.reviewedHash, nextHash: hash(next),
    replacement: { from: expectedLine, to: replacement, preserveAllOtherBytes: true },
    readiness: readinessRequest(origin, candidate.port), requiredAction: 'save_previous_config_and_nextjs', reason: null,
    pendingChecks: ['validate_staged_full_config_not_snippet', 'coordinate_all_writers_and_reloaders_including_certbot', 'atomic_write_fsync_on_linux', 'actual_new_workers_and_request_upstream_identity'],
  };
}
export function advanceNginxPlan(plan, event, receipt) {
  const context = readRecordedNginxPlan(receipt, plan);
  const rollback = plan.phase.startsWith('rollback') || plan.phase === 'rolling_back';
  // 解除されない停止要求でも、安全な旧経路への復旧モデルは記録できる。
  const effective = context.stop.status !== 'clear' && !rollback ? { type: 'abort', success: false, observation: null } : event;
  return recordNginxTransition(receipt, plan, effective, advanceNginxModel(plan, effective));
}
function advanceNginxModel(plan, event) {
  need(plan?.mode === 'local-plan' && plan.executionAllowed === false && !['committed', 'incident'].includes(plan.phase), 'INVALID_OR_TERMINAL_NGINX_PLAN');
  validateNextSlot(plan.previous); validateNextSlot(plan.candidate);
  need(plan.candidate.port === (plan.previous.port === 3101 ? 3102 : 3101) && plan.candidate.container !== plan.previous.container &&
    plan.candidate.image.startsWith('ghcr.io/syucream02/siteflow@'), 'INVALID_NGINX_CANDIDATE');
  const changed = ['install_pending', 'installed', 'reload_pending', 'verifying', 'commit_pending', 'rolling_back', 'rollback_validating', 'rollback_reloading', 'rollback_verifying'].includes(plan.phase);
  function stop(reason) { return { ...structuredClone(plan), phase: changed ? 'rolling_back' : 'incident', requiredAction: changed ? 'restore_exact_previous_config' : 'manual_review', reason }; }
  exactFields(event, ['type', 'success', 'observation'], 'INVALID_NGINX_EVENT');
  need(typeof event.success === 'boolean', 'INVALID_NGINX_EVENT_RESULT');
  if (event.type === 'abort') return stop('INTERRUPTED_OR_PERMISSION_REVOKED');
  const edges = {
    backup_saved: ['candidate_ready', 'staging', 'validate_staged_full_config'],
    staged_validated: ['staging', 'switch_ready', 'persist_switch_intent'],
    intent_saved: ['switch_ready', 'install_pending', 'recheck_permission_and_config_hash_then_atomic_install'],
    config_installed: ['install_pending', 'installed', 'validate_live_config_before_reload'],
    config_validated: ['installed', 'reload_pending', 'recheck_permission_then_reload'],
    reloaded: ['reload_pending', 'verifying', 'confirm_new_workers_then_check_public'],
    public_checked: ['verifying', 'commit_pending', 'recheck_permission_then_persist_commit'],
    committed: ['commit_pending', 'committed', null],
    rollback_restored: ['rolling_back', 'rollback_validating', 'validate_previous_config'],
    rollback_validated: ['rollback_validating', 'rollback_reloading', 'reload_previous_config'],
    rollback_reloaded: ['rollback_reloading', 'rollback_verifying', 'verify_previous_public_route'],
    rollback_checked: ['rollback_verifying', 'incident', 'manual_review_before_any_new_release'],
  };
  const edge = edges[event.type]; need(Object.hasOwn(edges, event.type) && edge[0] === plan.phase, 'INVALID_NGINX_TRANSITION');
  let passed = event.success;
  if (['public_checked', 'rollback_checked'].includes(event.type)) passed = passed && healthy(event.observation, event.type === 'public_checked' ? plan.candidate : plan.previous, true);
  if (!passed) {
    if (plan.phase.startsWith('rollback') || plan.phase === 'rolling_back') return { ...structuredClone(plan), phase: 'incident', requiredAction: 'manual_review', reason: 'ROLLBACK_FAILED' };
    if (plan.phase === 'commit_pending') return { ...structuredClone(plan), phase: 'incident', requiredAction: 'reconcile_durable_commit_before_any_change', reason: 'COMMIT_OUTCOME_UNKNOWN' };
    return stop('NGINX_STEP_FAILED');
  }
  return { ...structuredClone(plan), phase: edge[1], requiredAction: edge[2], reason: event.type === 'rollback_checked' ? 'ROLLED_BACK_INCIDENT_REMAINS' : null };
}
