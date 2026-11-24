import { validatePersistentModel } from './persistent-state.mjs';
import { sameSlot, validateModelEnvironment } from './switch-plan.mjs';
import { exactFields, isTime, need } from './contract.mjs';
import { validateIncidentRecord } from './incident.mjs';
import { compareSavedContainerConfiguration } from './docker-plan.mjs';

// 読み取り観測も模擬。復旧を計画するだけで、Nginx/Docker/DB操作はしない。
export function assessRecovery(snapshot, observed) {
  const result = (reason, action = 'manual_review', target = null) => ({ mode: 'local-model', executionAllowed: false, newDeploymentsAllowed: false, status: 'incident', reason, requiredAction: action, target });
  try {
    if (snapshot?.status !== 'snapshot' || snapshot.executionAllowed !== false) return result('STATE_OR_LOCK_UNCERTAIN');
    const s = validatePersistentModel(snapshot.state);
    validateModelEnvironment(observed.environment);
    if (!Array.isArray(observed.containers)) return result('RUNTIME_UNKNOWN');
    const healthy = slot => {
      const found = observed.containers.filter(c => c.container === slot.container);
      return found.length === 1 && sameSlot(found[0], slot) && found[0].running === true && found[0].ready === true;
    };
    if (s.schemaVersion === 1) return result('LEGACY_RECOVERY_UNPROVEN');
    if (s.schemaVersion >= 2 && s.nginxRecovery !== null) {
      const r = s.nginxRecovery;
      const classification = observed.nginxConfigHash === r.beforeHash ? 'before' : observed.nginxConfigHash === r.afterHash ? 'after' : 'unknown';
      if (classification === 'unknown' || observed.configurationExclusive !== true || observed.backupHash !== r.beforeHash || observed.backupFile !== r.backupFile) {
        return { ...result('NGINX_CONFIGURATION_OR_BACKUP_UNCERTAIN'), configClassification: classification };
      }
      if ((classification === 'before' && !sameSlot(observed.route, r.previous)) || (classification === 'after' && !sameSlot(observed.route, r.candidate))) {
        return { ...result('NGINX_HASH_ROUTE_CONFLICT'), configClassification: classification };
      }
      if (s.phase === 'incident') return { ...result('INCIDENT_REMAINS'), configClassification: classification };
      // 分類は模擬観測からの判定。実Nginx操作/incident解除をしない。
      if (!['idle', 'committed'].includes(s.phase)) return healthy(r.previous) ?
        { ...result('SWITCH_OR_COMMIT_OUTCOME_UNCERTAIN', 'review_then_restore_previous', r.previous), configClassification: classification } : result('PREVIOUS_NEXTJS_UNAVAILABLE');
    }
    if (s.phase === 'incident') return result('INCIDENT_REMAINS');
    if (['idle', 'committed'].includes(s.phase)) {
      if (!healthy(s.stable) || !sameSlot(observed.route, s.stable) || observed.configMatches !== true) return result('STABLE_RUNTIME_MISMATCH');
      return { ...result('STABLE_MODEL_ONLY', 'keep_stable', s.stable), status: 'stable_model' };
    }
    if (!s.previous || !healthy(s.previous)) return result('PREVIOUS_NEXTJS_UNAVAILABLE');
    if (['preparing', 'candidate_starting', 'candidate_checking', 'candidate_ready'].includes(s.phase)) {
      return sameSlot(observed.route, s.previous) && observed.configMatches === true ? result('INTERRUPTED_BEFORE_SWITCH', 'keep_previous_and_review_candidate', s.previous) : result('UNEXPECTED_ROUTE_BEFORE_SWITCH');
    }
    // committingも確定していない。公開先が候補に見えても成功確定しない。
    return result('SWITCH_OR_COMMIT_OUTCOME_UNCERTAIN', 'review_then_restore_previous', s.previous);
  } catch { return result('INVALID_STATE_OR_ENVIRONMENT'); }
}

// 人が照合するための模擬計画。approval booleanを受け付けず、解除/実操作入口もない。
export function planManualRecovery(record, evidence, now) {
  const blocked = reason => ({ mode: 'local-manual-recovery-plan', executionAllowed: false, newDeploymentsAllowed: false,
    incidentResolved: false, status: 'blocked', reason, steps: ['preserve_incident_and_stop', 'request_manual_investigation'] });
  try {
    const r = validateIncidentRecord(record), e = evidence;
    exactFields(e, ['observedAt', 'stateMatches', 'ebsReady', 'mysqlReady', 'stopStatus', 'stable', 'rollback', 'nginx', 'dockerMatch', 'cleanup', 'publicHealthy', 'legacyServiceConflict', 'control', 'rollbackIdentity']);
    need(['stateMatches', 'ebsReady', 'mysqlReady', 'publicHealthy', 'legacyServiceConflict'].every(k => typeof e[k] === 'boolean'), 'INVALID_MANUAL_OBSERVATION_TYPE');
    need(isTime(now) && isTime(e.observedAt) && e.observedAt >= r.occurredAt && e.observedAt <= now && now - e.observedAt <= 5, 'OBSERVATION_STALE');
    need(r.stateConfidence === 'validated' && e.stateMatches === true && e.ebsReady === true && e.mysqlReady === true && e.legacyServiceConflict === false && e.dockerMatch === 'match', 'STATE_OR_DEPENDENCIES_UNCERTAIN');
    need(['clear', 'requested'].includes(e.stopStatus), 'STOP_UNKNOWN');
    exactFields(e.control, ['incidentId', 'workspaceId', 'stateRevision', 'lockHeld', 'stopStatus', 'nginxPort']);
    need(e.control.incidentId === r.incidentId && e.control.workspaceId === r.workspaceId && e.control.stateRevision === r.stateRevision &&
      e.control.lockHeld === true && e.control.stopStatus === e.stopStatus && e.control.nginxPort === e.nginx.routePort, 'MANUAL_CONTEXT_OR_LOCK_MISMATCH');
    function runtime(observed, saved, requireRunning) {
      exactFields(observed, ['port', 'digest', 'configurationMatches', 'running', 'ready']);
      need(saved?.digest !== null && saved !== null && observed.port === saved.port && observed.digest === saved.digest &&
        observed.configurationMatches === true && typeof observed.running === 'boolean' && typeof observed.ready === 'boolean' &&
        (!requireRunning || (observed.running === true && observed.ready === true)), 'SAVED_NEXTJS_UNPROVEN');
    }
    const restoring = ['nginx_switch', 'post_switch'].includes(r.stage);
    // 故障側もport/digest/設定の識別は必要。正常性は復旧対象に要求する。
    runtime(e.stable, r.stable, r.stage !== 'boot' && !restoring);
    exactFields(e.nginx, ['match', 'routePort', 'routeMatchesSavedConfig', 'backupMatches', 'exclusive']);
    need(['routeMatchesSavedConfig', 'backupMatches', 'exclusive'].every(k => typeof e.nginx[k] === 'boolean'), 'INVALID_NGINX_OBSERVATION_TYPE');
    need(['before', 'after', 'stable'].includes(e.nginx.match) && [3001, 3101, 3102].includes(e.nginx.routePort) &&
      e.nginx.routeMatchesSavedConfig === true && e.nginx.exclusive === true, 'NGINX_UNCERTAIN');
    exactFields(e.cleanup, ['status', 'targetMatches', 'protectedMatches']);
    need(typeof e.cleanup.targetMatches === 'boolean' && typeof e.cleanup.protectedMatches === 'boolean', 'INVALID_CLEANUP_OBSERVATION_TYPE');
    need(['none', 'stopped', 'removed'].includes(e.cleanup.status), 'CLEANUP_OUTCOME_UNKNOWN');
    if (r.stage !== 'generation_cleanup') need(e.cleanup.status === 'none', 'UNFINISHED_CLEANUP');
    if (e.stopStatus === 'requested') {
      need(e.stable.running && e.stable.ready && e.nginx.routePort === r.stable.port && e.publicHealthy === true, 'STOP_BLOCKS_RESTART_OR_CHANGE');
      return { ...blocked('STOP_OBSERVATION_ONLY'), status: 'observation_only', steps: ['verify_running_saved_stable', 'keep_stop_and_incident', 'no_start_switch_or_cleanup'] };
    }
    let steps;
    switch (r.stage) {
      case 'before_deploy': case 'candidate':
        need(e.nginx.routePort === r.stable.port && e.publicHealthy === true, 'STABLE_ROUTE_UNPROVEN');
        steps = ['keep_current_stable', 'review_incident_and_stop', ...(r.stage === 'candidate' ? ['inventory_candidate_without_delete_or_reuse'] : ['do_not_start_unknown_candidate'])]; break;
      case 'nginx_switch': case 'post_switch':
        runtime(e.rollback, r.rollback, true); need(e.nginx.backupMatches === true, 'RESTORE_BACKUP_UNPROVEN');
        {
          exactFields(e.rollbackIdentity, ['saved', 'observed']);
          const { saved, observed } = e.rollbackIdentity;
          for (const v of [saved, observed]) exactFields(v, ['containerId', 'releaseId', 'owner', 'configuration']);
          need(typeof saved.containerId === 'string' && /^[a-f0-9]{64}$/.test(saved.containerId) && !/^0+$/.test(saved.containerId) &&
            saved.containerId === observed.containerId && saved.releaseId === observed.releaseId && saved.releaseId !== r.releaseId &&
            saved.owner === 'poll-release' && observed.owner === saved.owner &&
            saved.configuration.slot.port === r.rollback.port && saved.configuration.slot.image === `ghcr.io/syucream02/siteflow@${r.rollback.digest}`,
          'ROLLBACK_IDENTITY_MISMATCH');
          // savedは独立に保存/レビューした模擬台帳、observedは別の模擬観測。
          // 両者の自己申告は本番の所有権/実測証明ではない。実行許可は発行しない。
          compareSavedContainerConfiguration(saved.configuration, saved.configuration.slot, saved.releaseId, observed.configuration);
          if (r.stage === 'post_switch') need([r.stable.port, r.rollback.port].includes(e.nginx.routePort), 'POST_SWITCH_ROUTE_UNPROVEN');
        }
        steps = ['verify_saved_backup_hash_and_exclusive_config_lock', 'obtain_separate_restore_approval', 'plan_restore_saved_nextjs_only', 'require_config_validation_then_reload', 'require_fresh_public_health_checks']; break;
      case 'generation_cleanup':
        need(e.cleanup.targetMatches === true && e.cleanup.protectedMatches === true && e.nginx.routePort === r.stable.port && e.publicHealthy === true, 'CLEANUP_IDENTITY_UNCERTAIN');
        steps = ['keep_stable_and_rollback', `inventory_target_${e.cleanup.status}`, 'do_not_retry_delete_or_reuse_slot', 'review_cleanup_intent_and_confirmation']; break;
      case 'boot':
        need(e.nginx.routePort === r.stable.port, 'BOOT_ROUTE_MISMATCH');
        if (e.stable.running) need(e.stable.ready && e.publicHealthy === true, 'BOOT_HEALTH_UNPROVEN');
        steps = ['verify_ebs_then_state_stop_incident', 'verify_mysql_readiness', 'verify_saved_oci_and_configuration',
          ...(e.stable.running ? ['observe_running_saved_stable'] : ['obtain_separate_start_approval', 'plan_start_saved_stable_only']),
          'require_app_readiness_then_nginx_match_then_public_health']; break;
      default: return blocked('UNKNOWN_OPERATION_STAGE');
    }
    return { mode: 'local-manual-recovery-plan', executionAllowed: false, newDeploymentsAllowed: false, incidentResolved: false,
      status: 'review_plan_requires_approval', stage: r.stage, steps,
      resumeRequirements: ['separate_administrator_approval', 'fresh_state_and_runtime_match', 'stable_and_public_health', 'docker_configuration_and_oci_match',
        'explicit_stop_request_handling', 'fresh_github_approval_permission_main_and_workflow_checks', 'no_unfinished_cleanup', 'new_unused_release_id'],
      forbidden: ['automatic_incident_clear', 'vinext_3002', 'database_rollback', 'migration', 'automatic_cleanup_retry'] };
  } catch { return blocked('RECOVERY_EVIDENCE_UNPROVEN'); }
}
