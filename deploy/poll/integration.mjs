import { acquireMockRelease, takeMockAcquisitionEvidence } from './acquire.mjs';
import { exactFields, need, isTime } from './contract.mjs';
import { assessRuntimeGuard } from './runtime-guard.mjs';
import { createLocalStateStore } from './persistent-state.mjs';
import { acquireLocalLock, acquireLocalConfigLock, releaseLocalLock, retainLocalLock } from './lock.mjs';
import { openLocalStopReader } from './stop-control.mjs';
import { createDockerPlan } from './docker-plan.mjs';
import { createNginxPlan, advanceNginxPlan } from './nginx-plan.mjs';
import { assessRecovery } from './recovery.mjs';

// H1のローカル統合モデル。実通信adapter/実行許可/外部コマンド実行は提供しない。
// authはapp-auth.mjsのgetCredential境界と互換。今回は鍵なしダミー認証を注入する。
const contexts = new WeakMap();
const origin = Object.freeze({ acquisition: 'mock-only', authenticity: 'not-established', executionAllowed: false });
export async function prepareMockIntegration(config) {
  try {
    exactFields(config, ['auth', 'transport', 'policy', 'local', 'now']);
    need(config.auth?.mode === 'mock-only' && typeof config.auth.getCredential === 'function' && typeof config.now === 'function', 'MOCK_AUTH_REQUIRED');
    const policy = structuredClone(config.policy), local = structuredClone(config.local);
    const credential = await config.auth.getCredential();
    const acquisition = { transport: config.transport, credential, policy, local, now: config.now };
    const summary = await acquireMockRelease(acquisition);
    const evidence = takeMockAcquisitionEvidence(summary);
    const context = Object.freeze({ ...origin, releaseId: summary.releaseId });
    contexts.set(context, { acquisition, summary: structuredClone(summary), evidence });
    return context;
  } catch { throw new Error('MOCK_INTEGRATION_PREPARATION_REJECTED'); }
}

export async function runMockIntegration(context, options) {
  const entry = contexts.get(context);
  need(entry, 'INVALID_OR_USED_MOCK_CONTEXT');
  contexts.delete(context); // awaitやlock取得の前に消費。失敗/競合時も再利用しない。
  exactFields(options, ['directory', 'now', 'observe']);
  const { directory, now, observe } = options;
  need(typeof now === 'function' && typeof observe === 'function', 'INVALID_MOCK_OPTIONS');
  let lock, configLock, state, store, stop, plan, receipt, latestObservation;
  const trace = [];
  let operationStage = 'before_deploy';
  let consumedHere = false, uncertainFailure = false;
  let lastTime = 0;
  // 永続記録/復旧は承認期限に依存させない。時計の推測補正は行わない。
  function persistenceTime() { const t = now(); need(isTime(t) && t >= lastTime, 'MOCK_CLOCK_INVALID'); lastTime = t; return t; }
  function forwardTime() { const t = persistenceTime(); need(t < entry.summary.expiresAt, 'MOCK_APPROVAL_EXPIRED'); return t; }
  function read() { state = store.read(lock); need(state.schemaVersion >= 2 && state.phase !== 'incident', 'INCIDENT_OR_LEGACY_STATE'); stop.assertClear(); return state; }
  async function observation(stage, candidate = stage === 'before_consume' ? null : state?.candidate) {
    operationStage = stage.startsWith('generation_cleanup') ? 'generation_cleanup' :
      ['before_commit', 'public_checked'].includes(stage) ? 'post_switch' :
      ['before_switch', 'backup_saved', 'staged_validated', 'intent_saved', 'config_installed', 'config_validated', 'reloaded'].includes(stage) ? 'nginx_switch' :
      stage.startsWith('candidate_') ? 'candidate' : 'before_deploy';
    forwardTime(); read();
    const data = structuredClone(await observe(stage, structuredClone(state), structuredClone(candidate)));
    forwardTime(); read(); // callback/await中の停止要求・状態変更も再読込する。
    latestObservation = data; return data;
  }
  async function guard(stage, candidate) {
    const data = await observation(stage, candidate);
    // 模擬GitHubを再取得。初回証跡を別releaseや差し替えartifactへ流用しない。
    const result = await acquireMockRelease(entry.acquisition);
    need(JSON.stringify(result) === JSON.stringify(entry.summary), 'MOCK_RELEASE_CHANGED');
    const fresh = takeMockAcquisitionEvidence(result);
    need(JSON.stringify(fresh) === JSON.stringify(entry.evidence), 'MOCK_EVIDENCE_CHANGED');
    read();
    const host = { ...data.host, lock: { held: true, releaseId: entry.summary.releaseId, workspaceId: state.workspaceId, revision: state.revision } };
    const checked = await assessRuntimeGuard({ stage, ...fresh, state, storage: data.storage, host }, forwardTime());
    need(checked.status === 'mock_runtime_consistent', 'MOCK_RUNTIME_REJECTED');
    read(); trace.push({ stage, phase: state.phase, revision: state.revision, executionAllowed: false });
    return data;
  }
  function checkpoint(phase, candidate) { forwardTime(); read(); state = store.checkpoint(lock, state.revision, phase, candidate); }
  async function rollback() {
    if (plan?.phase !== 'rolling_back') return;
    for (const type of ['rollback_restored', 'rollback_validated', 'rollback_reloaded', 'rollback_checked']) {
      persistenceTime(); state = store.read(lock);
      const data = structuredClone(await observe(type, structuredClone(state), structuredClone(state.candidate)));
      persistenceTime();
      // 保存済みreceiptはphase、復旧先、hash、両ロック、停止状態を再照合する。
      plan = advanceNginxPlan(plan, { type, success: data.event?.success === true, observation: data.event?.observation ?? null }, receipt);
      state = store.read(lock); trace.push({ stage: type, phase: state.phase, revision: state.revision, executionAllowed: false });
      if (plan.phase === 'incident') break;
    }
  }
  try {
    lock = acquireLocalLock(directory);
    store = createLocalStateStore(directory, { now: persistenceTime, forwardDeadline: entry.summary.expiresAt });
    state = store.read(lock); // lock取得後の実ファイル原本。呼び出し元stateは受け付けない。
    stop = openLocalStopReader(directory, state.workspaceId); read();
    const initial = await guard('before_consume');
    forwardTime(); state = store.consume(lock, state.revision, entry.summary.releaseId);
    consumedHere = true;
    trace.push({ stage: 'consumed', phase: state.phase, revision: state.revision, executionAllowed: false });
    const candidate = structuredClone(initial.docker.candidate);
    let create = await guard('before_create', candidate);
    if (create.docker.runtime.containers.some(c => c.port === candidate.port || c.container === candidate.container) ||
      create.docker.runtime.listeners.some(l => l.port === candidate.port)) {
      // ID消費と今回のrollback保存より前には整理しない。未知世代はstore側で拒否。
      configLock = acquireLocalConfigLock(directory);
      const before = await observation('generation_cleanup_before_stop', candidate);
      const targets = before.generations?.containers?.filter(c => c.slot.port === candidate.port) ?? [];
      need(targets.length === 1, 'GENERATION_SLOT_UNKNOWN');
      const cleanup = store.prepareGenerationCleanup(lock, configLock, state.revision, targets[0].releaseId, before.generations);
      store.checkGenerationCleanup(cleanup, before.generations);
      async function cleanupObservation(stage) {
        forwardTime(); const data = structuredClone(await observe(stage, structuredClone(state), structuredClone(candidate))); forwardTime(); return data.generations;
      }
      store.advanceGenerationCleanup(cleanup, 'stopped', await cleanupObservation('generation_cleanup_stopped'));
      store.checkGenerationCleanup(cleanup, await cleanupObservation('generation_cleanup_before_remove'));
      const removed = store.advanceGenerationCleanup(cleanup, 'removed', await cleanupObservation('generation_cleanup_removed'));
      need(removed.slotAvailable === true, 'GENERATION_SLOT_NOT_RELEASED');
      state = store.read(lock); trace.push({ stage: 'generation_cleanup_confirmed', phase: state.phase, revision: state.revision, executionAllowed: false });
      create = await guard('before_create', candidate); // 削除確認後も実行計画の全条件を再照合。
    }
    const docker = createDockerPlan({ ...create.docker, record: entry.evidence.githubData.record, stable: state.stable, candidate, storage: create.storage });
    if (state.schemaVersion === 3) state = store.saveCandidateConfiguration(lock, state.revision, candidate, docker.configurationReceipt);
    forwardTime();
    store.checkBeforeEffect(lock, 'docker_pull');
    for (const [stage, phase, operation] of [['candidate_starting', 'candidate_starting', 'docker_create'], ['candidate_checking', 'candidate_checking', 'docker_start'], ['candidate_ready', 'candidate_ready', 'candidate_check']]) {
      checkpoint(phase, candidate);
      const data = await observation(stage, candidate);
      forwardTime(); store.checkBeforeEffect(lock, operation); need(data.event?.success === true, 'MOCK_CANDIDATE_STEP_FAILED');
      trace.push({ stage, phase: state.phase, revision: state.revision, executionAllowed: false });
    }
    const switching = await guard('before_switch', candidate);
    configLock ??= acquireLocalConfigLock(directory);
    read();
    plan = createNginxPlan({ ...switching.nginx, stable: state.stable, candidate });
    need(switching.host.rollback.configHash === plan.expectedHash, 'ROLLBACK_CONFIG_BINDING_MISMATCH');
    forwardTime(); receipt = store.prepareNginxRecovery(lock, configLock, state.revision, plan, Buffer.from(switching.nginx.config.text, 'utf8'));
    state = store.read(lock);
    const events = ['backup_saved', 'staged_validated', 'intent_saved', 'config_installed', 'config_validated', 'reloaded', 'public_checked', 'committed'];
    for (const type of events) {
      const data = type === 'committed' ? await guard('before_commit', candidate) : await observation(type, candidate);
      forwardTime(); store.checkBeforeEffect(lock, type === 'committed' ? 'commit' : type === 'reloaded' ? 'nginx_reload' : type === 'config_installed' ? 'nginx_install' : 'public_check');
      plan = advanceNginxPlan(plan, { type, success: data.event?.success === true, observation: data.event?.observation ?? null }, receipt);
      state = store.read(lock); trace.push({ stage: type, phase: state.phase, revision: state.revision, executionAllowed: false });
      if (state.phase === 'incident') break;
    }
    // 復旧も模擬イベントのみ。成功してもincident/停止要求を自動解除しない。
    await rollback();
    const incident = state.phase === 'incident' ? recordFailure() : null;
    return { ...origin, status: state.phase === 'committed' ? 'mock_committed' : 'incident', state, trace, incident,
      plan: { docker, nginx: plan }, recovery: state.phase === 'incident' ? recovery(latestObservation) : null };
  } catch {
    if (lock && store) {
      try {
        state = store.read(lock);
        if (state.activeReleaseId === entry.summary.releaseId && !['committed', 'incident'].includes(state.phase)) {
          if (receipt && plan) { plan = advanceNginxPlan(plan, { type: 'abort', success: false, observation: null }, receipt); await rollback(); }
          else store.checkpoint(lock, state.revision, 'incident');
        }
        state = store.read(lock);
      } catch { uncertainFailure = true; try { store.markIncident(lock, 'INTEGRATION_OUTCOME_UNCERTAIN'); } catch { retainLocalLock(lock); } }
    }
    const incident = lock && store && (state?.phase === 'incident' || consumedHere || uncertainFailure) ? recordFailure() : null;
    return { ...origin, status: 'rejected', reason: 'MOCK_INTEGRATION_REJECTED', trace, state: state ?? null, incident, recovery: recovery(latestObservation) };
  } finally {
    for (const owned of [configLock, lock]) if (owned) { try { releaseLocalLock(owned); } catch { /* incident lockは解除しない。 */ } }
  }
  function recovery(data) {
    return assessRecovery({ status: 'snapshot', executionAllowed: false, state }, data?.recovery ?? {});
  }
  function recordFailure() {
    try {
      // 既存事故で開始を拒否しただけなら、その同じ事故を再通知判定する。
      // 今回の新しい副作用/状態不明がある場合には再利用せず新しい記録を作る。
      const previous = !consumedHere && !uncertainFailure && state?.phase === 'incident' ? store.listIncidents(lock) : [];
      const saved = previous.length === 1 ? { status: 'already_recorded', record: previous[0] } : store.recordIncident(lock, { reason: plan ? 'RECOVERY_UNCERTAIN' : 'DEPLOYMENT_INTERRUPTED', stage: operationStage,
        // 例外時の最後の観測を「現在も一致」とは扱わない。生の応答/例外は保存しない。
        nginxMatch: 'unknown', dockerMatch: 'unknown', recoveryPhase: plan ? 'uncertain' : 'interrupted' });
      let notification;
      try { notification = store.prepareIncidentNotification(lock, saved.record.incidentId); }
      catch { notification = { status: 'plan_not_confirmed', executionAllowed: false, incidentResolved: false }; }
      return { status: saved.status, incidentId: saved.record.incidentId, notification, executionAllowed: false };
    } catch {
      retainLocalLock(lock); return { status: 'record_not_confirmed', executionAllowed: false };
    }
  }
}
