import { createHash } from 'node:crypto';
import { exactFields, isDigest, isTime, need } from './contract.mjs';

// M5: 記録と通知「計画」の契約。ログ出力、通知送信、incident解除は提供しない。
export const INCIDENT_STAGES = ['before_deploy', 'candidate', 'nginx_switch', 'post_switch', 'generation_cleanup', 'boot', 'unknown'];
const phases = ['idle', 'preparing', 'candidate_starting', 'candidate_checking', 'candidate_ready', 'switching', 'verifying', 'committing', 'committed', 'rolling_back', 'incident', 'unknown'];
const reasons = ['DEPLOYMENT_INTERRUPTED', 'RECOVERY_UNCERTAIN', 'CLEANUP_UNCERTAIN', 'BOOT_UNCERTAIN', 'STATE_UNCERTAIN'];
const matches = ['match', 'mismatch', 'unknown'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
const release = value => typeof value === 'string' && /^used-([1-9][0-9]{0,19})-a[1-9][0-9]{0,19}$/.test(value);
function slot(value) {
  if (value === null) return;
  exactFields(value, ['port', 'digest']);
  need([3001, 3101, 3102].includes(value.port) && (value.digest === null || isDigest(value.digest)), 'INVALID_INCIDENT_SLOT');
}
export function summarizeIncidentSlot(value) {
  if (!value || ![3001, 3101, 3102].includes(value.port)) return null;
  const prefix = 'ghcr.io/syucream02/siteflow@';
  const digest = typeof value.image === 'string' && value.image.startsWith(prefix) ? value.image.slice(prefix.length) : null;
  // bare sha256はローカルimage IDかもしれない。OCI digestと偽らない。
  return { port: value.port, digest: isDigest(digest) ? digest : null };
}
function identity(record) { const { incidentId: _id, occurredAt: _time, integritySha256: _sum, ...key } = record; void _id; void _time; void _sum; return key; }
function integrity(record) { const { integritySha256: _sum, ...content } = record; void _sum; return hash(content); }
export function validateIncidentRecord(r) {
  exactFields(r, ['version', 'mode', 'executionAllowed', 'incidentId', 'occurredAt', 'workspaceId', 'stateRevision', 'stateConfidence',
    'releaseId', 'runId', 'reason', 'stage', 'phase', 'stable', 'rollback', 'stopStatus', 'nginxMatch', 'dockerMatch', 'recoveryPhase', 'lastKnownGood', 'integritySha256']);
  // v1はoccurredAtの破損を検出できない。自動移行や上書きをせず拒否する。
  need(r.version === 2 && r.mode === 'local-incident-model' && r.executionAllowed === false && hex(r.workspaceId) &&
    Number.isSafeInteger(r.stateRevision) && r.stateRevision >= 0 && ['validated', 'unconfirmed'].includes(r.stateConfidence) &&
    isTime(r.occurredAt) && reasons.includes(r.reason) && INCIDENT_STAGES.includes(r.stage) && phases.includes(r.phase) &&
    ['clear', 'requested', 'unknown'].includes(r.stopStatus) && matches.includes(r.nginxMatch) && matches.includes(r.dockerMatch) &&
    ['not_started', 'interrupted', 'uncertain', 'verified_not_cleared'].includes(r.recoveryPhase), 'INVALID_INCIDENT_RECORD');
  need(r.releaseId === null ? r.runId === null : release(r.releaseId) && r.runId === r.releaseId.match(/^used-([0-9]+)-/)[1], 'INCIDENT_RUN_MISMATCH');
  for (const s of [r.stable, r.rollback, r.lastKnownGood]) slot(s);
  need(r.incidentId === hash(identity(r)), 'INCIDENT_ID_MISMATCH');
  // 偶発的破損の検出。書込権限のある攻撃者による再計算を防ぐ署名/MACではない。
  need(hex(r.integritySha256) && r.integritySha256 === integrity(r), 'INCIDENT_INTEGRITY_MISMATCH'); return structuredClone(r);
}
export function createIncidentRecord(input, occurredAt) {
  exactFields(input, ['workspaceId', 'stateRevision', 'stateConfidence', 'releaseId', 'reason', 'stage', 'phase', 'stable', 'rollback', 'stopStatus', 'nginxMatch', 'dockerMatch', 'recoveryPhase', 'lastKnownGood']);
  const record = { version: 2, mode: 'local-incident-model', executionAllowed: false, incidentId: null, occurredAt,
    ...structuredClone(input), runId: input.releaseId === null ? null : input.releaseId.match(/^used-([0-9]+)-/)?.[1] };
  // 並び順も固定し、同一障害の時刻だけの違いではIDを変えない。
  record.incidentId = hash(identity(record)); record.integritySha256 = integrity(record); return validateIncidentRecord(record);
}
export function validateIncidentNotice(n, id) {
  exactFields(n, ['version', 'incidentId', 'attemptedAt']);
  need(n.version === 1 && n.incidentId === id && hex(id) && isTime(n.attemptedAt), 'INVALID_INCIDENT_NOTICE'); return n;
}
export function validateIncidentOutcome(n, notice) {
  exactFields(n, ['version', 'incidentId', 'attemptedAt', 'status']);
  need(n.version === 1 && n.incidentId === notice.incidentId && n.attemptedAt === notice.attemptedAt &&
    ['simulated_delivered', 'simulated_failed'].includes(n.status), 'INVALID_INCIDENT_OUTCOME'); return n;
}
export function planIncidentNotification(record, history, now) {
  const r = validateIncidentRecord(record);
  need(isTime(now) && now >= r.occurredAt && Array.isArray(history) && history.length <= 1000, 'INVALID_NOTICE_CLOCK_OR_HISTORY');
  const seen = new Set();
  for (const item of history) {
    exactFields(item, ['notice', 'outcome']); validateIncidentNotice(item.notice, r.incidentId);
    if (item.outcome !== null) validateIncidentOutcome(item.outcome, item.notice);
    need(!seen.has(item.notice.attemptedAt) && item.notice.attemptedAt >= r.occurredAt && item.notice.attemptedAt <= now, 'NOTICE_HISTORY_CONFLICT'); seen.add(item.notice.attemptedAt);
  }
  const delivered = history.some(h => h.outcome?.status === 'simulated_delivered');
  const recent = history.some(h => now - h.notice.attemptedAt < 300);
  return { executionAllowed: false, incidentResolved: false, status: delivered || recent ? 'suppressed' : 'planned',
    event: delivered || recent ? null : { MESSAGE_ID: hash('siteflow.poll.incident.v1').slice(0, 32), PRIORITY: '3', SITEFLOW_INCIDENT_ID: r.incidentId,
      SITEFLOW_RELEASE_ID: r.releaseId ?? 'unknown', SITEFLOW_RUN_ID: r.runId ?? 'unknown', SITEFLOW_STAGE: r.stage, SITEFLOW_REASON: r.reason,
      MESSAGE: 'SiteFlow CD requires manual review; automatic deployment remains blocked.' },
    checks: ['inspect_persisted_state', 'inspect_stop_and_locks', 'compare_saved_nginx_and_docker', 'follow_nextjs_manual_recovery'],
    delivery: 'simulation_only' };
}
