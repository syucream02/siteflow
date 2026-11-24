import { assessRelease, exactFields, isDigest, isTime, need, releaseIdentity } from './contract.mjs';

// 本番入口はcreateState/transitionStateのみ。authorizedを発行する入口はまだない。
// 下のtransitionModelは外部副作用のない仕様モデルで、exportしない。
// テストだけが隔離VMでモデルを取り出す。環境変数・booleanによる迂回口は設けない。
// 永続化、排他ロック、GitHub証拠、Docker/Nginx確認は第2段階以降の責務。
const statuses = ['idle', 'authorized', 'preparing', 'candidate_ready', 'switching',
  'verifying', 'committed', 'rolling_back', 'incident'];
const stateKeys = ['status', 'current', 'previous', 'candidate', 'release', 'consumedIds',
  'lastCheckedAt', 'requiredAction', 'reason', 'executionAllowed'];

function validateSlot(slot) {
  exactFields(slot, ['kind', 'container', 'port', 'image'], 'INVALID_NEXTJS_SLOT');
  need(slot.kind === 'nextjs' && [3001, 3101, 3102].includes(slot.port), 'NEXTJS_PORT_REQUIRED');
  need(typeof slot.container === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(slot.container), 'INVALID_CONTAINER_NAME');
  const digest = typeof slot.image === 'string' && slot.image.startsWith('ghcr.io/syucream02/siteflow@')
    ? slot.image.slice('ghcr.io/syucream02/siteflow@'.length) : slot.image;
  need(isDigest(digest), 'INVALID_SLOT_IMAGE'); // 初回3001はローカルimage IDも許容。
}

function validateState(state) {
  exactFields(state, stateKeys, 'INVALID_STATE_FIELDS');
  need(statuses.includes(state.status) && state.executionAllowed === false, 'INVALID_STATE_STATUS');
  validateSlot(state.current);
  for (const slot of [state.previous, state.candidate]) if (slot !== null) validateSlot(slot);
  need(isTime(state.lastCheckedAt) && Array.isArray(state.consumedIds) &&
    state.consumedIds.every(value => typeof value === 'string' && /^used-[1-9][0-9]{0,19}-a[1-9][0-9]{0,19}$/.test(value)) &&
    new Set(state.consumedIds).size === state.consumedIds.length, 'INVALID_STATE_HISTORY');
  need([null, 'check_candidate', 'verify_public', 'rollback', 'manual_review'].includes(state.requiredAction), 'INVALID_REQUIRED_ACTION');
  need(state.reason === null || (typeof state.reason === 'string' && /^[A-Z_]{1,80}$/.test(state.reason)), 'INVALID_STATE_REASON');
  if (state.release !== null) {
    exactFields(state.release, ['record', 'input'], 'INVALID_RELEASE_CONTEXT');
    const { record, input } = state.release;
    // 期限後の復旧は許すが、保存された入力の形式・整合性は再検査する。
    // ここでも外部証拠の検証にはならない。currentは最後に確定した版を表す。
    assessRelease(record, input, input.artifactCreatedAt);
    const id = releaseIdentity(record);
    need(state.consumedIds.includes(id), 'RELEASE_NOT_CONSUMED');
    need(JSON.stringify(state.consumedIds) === JSON.stringify([...input.consumedIds, id]), 'STATE_HISTORY_MISMATCH');
    need(state.previous !== null, 'ROLLBACK_TARGET_MISSING');
  }
  if (state.status === 'idle') need(state.release === null && state.previous === null && state.candidate === null, 'IDLE_STATE_CONFLICT');
  if (['authorized', 'preparing', 'candidate_ready', 'switching', 'verifying', 'rolling_back', 'committed'].includes(state.status)) {
    need(state.release !== null, 'MISSING_ACTIVE_RELEASE');
  }
}

export function createState(current, now) {
  // 新規初期状態専用。既存履歴の読み戻しや事故解除に使ってはいけない。
  // 再利用防止を再起動後も成立させるには、第2段階以降の永続化・排他が必須。
  validateSlot(current);
  need(isTime(now), 'INVALID_NOW');
  return { status: 'idle', current: { ...current }, previous: null, candidate: null,
    release: null, consumedIds: [], lastCheckedAt: now, requiredAction: null,
    reason: null, executionAllowed: false };
}

function stopped(state, reason, now) {
  const rollback = ['switching', 'verifying', 'rolling_back'].includes(state.status);
  return { ...structuredClone(state), status: rollback ? 'rolling_back' : 'incident',
    requiredAction: rollback ? 'rollback' : 'manual_review', reason, lastCheckedAt: now };
}

// 外部検証済みを仮定した遷移の模擬仕様。本番adapterから呼ぶ公開APIではない。
function transitionModel(state, event, now) {
  validateState(state);
  need(isTime(now) && now >= state.lastCheckedAt, 'CLOCK_MOVED_BACKWARD');
  need(event && typeof event.type === 'string', 'INVALID_EVENT');
  need(state.status !== 'incident', 'INCIDENT_REQUIRES_MANUAL_REVIEW');
  const next = structuredClone(state);
  next.lastCheckedAt = now;
  if (event.type === 'authorize') {
    exactFields(event, ['type', 'record', 'input'], 'INVALID_EVENT_FIELDS');
    need(['idle', 'committed'].includes(state.status), 'INVALID_TRANSITION');
    need(JSON.stringify(event.input.consumedIds) === JSON.stringify(state.consumedIds), 'CONSUMED_HISTORY_MISMATCH');
    const assessment = assessRelease(event.record, event.input, now);
    next.status = 'authorized';
    next.release = structuredClone({ record: event.record, input: event.input });
    next.consumedIds.push(assessment.releaseId);
    next.previous = { ...state.current };
    next.candidate = null;
    next.requiredAction = null;
    next.reason = null;
    return next;
  }
  if (event.type === 'crash') {
    exactFields(event, ['type'], 'INVALID_EVENT_FIELDS');
    need(!['idle', 'committed'].includes(state.status), 'INVALID_TRANSITION');
    return { ...next, status: 'incident', requiredAction: 'manual_review', reason: 'OUTCOME_UNKNOWN' };
  }
  if (event.type === 'revoke' || event.type === 'fail') {
    exactFields(event, ['type'], 'INVALID_EVENT_FIELDS');
    need(!['idle', 'committed'].includes(state.status), 'INVALID_TRANSITION');
    return stopped(state, event.type === 'revoke' ? 'PERMISSION_REVOKED' : 'OPERATION_FAILED', now);
  }
  if (event.type === 'rollback_confirmed' || event.type === 'rollback_failed') {
    exactFields(event, ['type'], 'INVALID_EVENT_FIELDS');
    need(state.status === 'rolling_back', 'INVALID_TRANSITION');
    // 復旧にも承認期限を要求しない。期限切れでも旧経路を守る。
    validateSlot(state.previous);
    if (event.type === 'rollback_confirmed') next.current = { ...state.previous };
    next.status = 'incident'; // 成功後も自動再開しない。解除入口は第1段階では設けない。
    next.requiredAction = 'manual_review';
    next.reason = event.type === 'rollback_confirmed' ? 'ROLLED_BACK_REVIEW_REQUIRED' : 'ROLLBACK_FAILED';
    return next;
  }
  need(state.release !== null, 'MISSING_ACTIVE_RELEASE');
  const edges = { prepare: ['authorized', 'preparing'], candidate_passed: ['preparing', 'candidate_ready'],
    switch: ['candidate_ready', 'switching'], switched: ['switching', 'verifying'],
    commit: ['verifying', 'committed'], check: [state.status, state.status] };
  need(Object.hasOwn(edges, event.type) && state.status === edges[event.type][0], 'INVALID_TRANSITION');
  exactFields(event, event.type === 'candidate_passed' ? ['type', 'candidate'] : ['type'], 'INVALID_EVENT_FIELDS');
  if (now >= state.release.input.expiresAt) return stopped(state, 'APPROVAL_EXPIRED', now);
  if (event.type === 'candidate_passed') {
    validateSlot(event.candidate);
    need([3101, 3102].includes(event.candidate.port) && event.candidate.port !== state.current.port &&
      event.candidate.container !== state.current.container &&
      event.candidate.image === `ghcr.io/syucream02/siteflow@${state.release.record.digest}`, 'CANDIDATE_MISMATCH');
    next.candidate = { ...event.candidate };
  }
  if (['switch', 'switched', 'commit'].includes(event.type)) {
    need(state.candidate !== null && state.previous !== null, 'CANDIDATE_OR_ROLLBACK_MISSING');
  }
  next.status = edges[event.type][1];
  next.requiredAction = event.type === 'prepare' ? 'check_candidate' :
    event.type === 'switched' ? 'verify_public' : null;
  if (event.type === 'commit') next.current = { ...state.candidate };
  return next;
}

export function transitionState(state, event, now) {
  validateState(state);
  // 入力を偽造してauthorized等を渡しても、本番APIは処理しない。
  need(['idle', 'incident'].includes(state.status), 'EXTERNAL_VERIFICATION_NOT_IMPLEMENTED');
  need(event?.type !== 'authorize', 'EXTERNAL_VERIFICATION_NOT_IMPLEMENTED');
  return transitionModel(state, event, now);
}
