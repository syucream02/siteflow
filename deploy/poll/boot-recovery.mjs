import { exactFields, isTime, need } from './contract.mjs';
import { createLocalStateStore, validatePersistentModel } from './persistent-state.mjs';
import { acquireLocalLock, acquireLocalConfigLock, releaseLocalLock, retainLocalLock, writeExclusiveLocal, syncLocalDirectory } from './lock.mjs';
import { openLocalStopReader } from './stop-control.mjs';
import { assessLinuxStorage } from './linux-storage.mjs';
import { sameSlot, validateNextSlot } from './switch-plan.mjs';
import { readinessRequest } from './nginx-plan.mjs';
import { assessRecovery } from './recovery.mjs';
import { compareSavedContainerConfiguration } from './docker-plan.mjs';
import path from 'node:path';

// H4: 一時領域だけで動く復帰仕様モデル。観測の真正性/実Linux起動は保証しない。
// GitHub/最新main/latestを参照せず、既存コンテナの固定IDをstartする計画だけを返す。
const IMAGE = 'ghcr.io/syucream02/siteflow@';
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) && !/^0+$/.test(v);
const digest = v => typeof v === 'string' && v.startsWith('sha256:') && hash(v.slice(7));
const MiB = 1024 ** 2;
function identity(state) {
  validatePersistentModel(state);
  need(state.schemaVersion === 3 && ['idle', 'committed'].includes(state.phase), 'BOOT_SAVED_CONFIGURATION_REQUIRED');
  validateNextSlot(state.stable);
  need(typeof state.stableReleaseId === 'string' && (state.phase === 'idle' ? /^manual-[a-zA-Z0-9_.-]{1,80}$/.test(state.stableReleaseId) :
    state.stableReleaseId === state.activeReleaseId && state.consumedIds.includes(state.stableReleaseId)), 'UNKNOWN_STABLE_RELEASE');
  // 裸のsha256はローカルimage IDかもしれない。OCI digestへ推測変換しない。
  need(state.stable.image.startsWith(IMAGE) && digest(state.stable.image.slice(IMAGE.length)), 'SAVED_OCI_BINDING_REQUIRED');
  if (state.phase === 'idle') need(state.stable.port === 3001 && state.nginxRecovery === null, 'INITIAL_SLOT_NOT_3001');
  else need([3101, 3102].includes(state.stable.port) && state.nginxRecovery?.planPhase === 'committed' &&
    sameSlot(state.nginxRecovery.candidate, state.stable), 'COMMITTED_SLOT_NOT_BOUND');
  return state.stable;
}
function inventory(state, data) {
  exactFields(data, ['observedAt', 'containers', 'listeners', 'availableMemoryBytes', 'rootFreeBytes']);
  need(Array.isArray(data.containers) && data.containers.length <= 100 && Array.isArray(data.listeners) && data.listeners.length <= 100, 'RUNTIME_LIST_UNKNOWN');
  for (const c of data.containers) {
    exactFields(c, ['id', 'name', 'port', 'image', 'imageId', 'running', 'ready', 'command', 'configuration']);
    need(hash(c.id) && typeof c.name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(c.name) &&
      Number.isSafeInteger(c.port) && c.port > 0 && c.port < 65536 && typeof c.image === 'string' && digest(c.imageId) &&
      typeof c.running === 'boolean' && typeof c.ready === 'boolean' && Array.isArray(c.command), 'INVALID_CONTAINER_OBSERVATION');
  }
  need(new Set(data.containers.map(c => c.id)).size === data.containers.length && new Set(data.containers.map(c => c.name)).size === data.containers.length, 'DUPLICATE_CONTAINER');
  for (const l of data.listeners) { exactFields(l, ['port', 'containerId']); need(Number.isInteger(l.port) && l.port > 0 && l.port < 65536 && hash(l.containerId), 'LISTENER_UNKNOWN'); }
  const stable = state.stable, matches = data.containers.filter(c => c.name === stable.container);
  need(matches.length === 1, 'SAVED_CONTAINER_MISSING');
  const c = matches[0];
  compareSavedContainerConfiguration(state.stableConfiguration, stable, state.stableReleaseId, c.configuration);
  need(c.port === stable.port && c.image === stable.image && JSON.stringify(c.command) === JSON.stringify(['node', 'server.js']), 'SAVED_CONTAINER_MISMATCH_OR_MIGRATION');
  need(!data.containers.some(other => other.id !== c.id && (other.port === c.port || other.image === c.image)), 'STABLE_PORT_OR_DIGEST_COLLISION');
  const listeners = data.listeners.filter(l => l.port === stable.port);
  need(c.running ? listeners.length === 1 && listeners[0].containerId === c.id : listeners.length === 0, 'STABLE_LISTENER_CONFLICT');
  need(Number.isSafeInteger(data.availableMemoryBytes) && data.availableMemoryBytes >= (c.running ? 128 : 768) * MiB &&
    Number.isSafeInteger(data.rootFreeBytes) && data.rootFreeBytes >= 2 * 1024 * MiB, 'BOOT_RESOURCE_SHORTAGE');
  return c;
}

export function assessBootGenerations(state, data) {
  identity(state); inventory(state, data);
  const port = state.stable.port === 3101 ? 3102 : 3101;
  const occupied = data.containers.filter(c => c.port === port).map(c => c.name);
  const occupiedListeners = data.listeners.some(l => l.port === port);
  return { mode: 'local-plan', executionAllowed: false, stable: structuredClone(state.stable), rollback: structuredClone(state.previous),
    nextSlot: { port, status: occupied.length || occupiedListeners ? 'requires_generation_cleanup_approval' : 'available_observation_only', occupied },
    cleanupImplemented: false, newDeploymentAllowed: false };
}

export async function runMockBootRecovery(options) {
  exactFields(options, ['directory', 'storagePolicy', 'origin', 'now', 'observe']);
  const { directory, storagePolicy, origin, now, observe } = options;
  need(typeof now === 'function' && typeof observe === 'function', 'INVALID_BOOT_MODEL_OPTIONS');
  let lock, configLock, store, state, reader, stateText, stopped = false, operationPlanned = false, last = 0;
  const trace = [], operations = [];
  const stopBlocked = Object.freeze({}); // 外部例外のmessage/getterを読んで安全判定しない。
  const result = (status, reason, extra = {}) => ({ mode: 'local-boot-model', executionAllowed: false, newDeploymentAllowed: false,
    authenticity: 'mock_observations_only', status, reason, trace, operations, state: state ?? null, ...extra });
  function time() { const t = now(); need(isTime(t) && t >= last, 'BOOT_CLOCK_UNKNOWN'); last = t; return t; }
  function fresh() {
    const current = store.read(lock); need(JSON.stringify(current) === stateText, 'BOOT_STATE_CHANGED');
    const stop = reader.read(); need(stop.status !== 'unknown', 'STOP_STATE_UNKNOWN');
    stopped = stop.status === 'requested'; return stop;
  }
  async function observeStage(stage) {
    if (store) fresh();
    const d = structuredClone(await observe(stage, state ? structuredClone(state) : null));
    const t = time(); need(isTime(d?.observedAt) && d.observedAt <= t && t - d.observedAt <= 5, 'STALE_BOOT_OBSERVATION');
    if (store) fresh();
    trace.push(stage); return d;
  }
  function noStartWhileStopped() { fresh(); if (stopped) throw stopBlocked; }
  try {
    // stateDirectoryへ触る前に、模擬Linux EBS観測を検証する。
    const storage = await observeStage('storage');
    exactFields(storage, ['observedAt', 'observation']); assessLinuxStorage(storagePolicy, storage.observation);
    lock = acquireLocalLock(directory); store = createLocalStateStore(directory, { now: time });
    state = store.read(lock); stateText = JSON.stringify(state);
    reader = openLocalStopReader(directory, state.workspaceId); fresh(); identity(state); trace.push('state_and_stop');
    const mysql = await observeStage('mysql');
    exactFields(mysql, ['observedAt', 'ready', 'tls', 'dataUuid']);
    need(mysql.ready === true && mysql.tls === true && mysql.dataUuid === storagePolicy.uuid, 'MYSQL_NOT_READY');
    const image = await observeStage('image');
    exactFields(image, ['observedAt', 'releaseId', 'repoDigests', 'imageId', 'os', 'architecture']);
    need(image.releaseId === state.stableReleaseId && Array.isArray(image.repoDigests) && image.repoDigests.length === 1 && image.repoDigests[0] === state.stable.image &&
      digest(image.imageId) && image.os === 'linux' && image.architecture === 'amd64', 'BOOT_IMAGE_IDENTITY_MISMATCH');
    const runtime = await observeStage('container'); const container = inventory(state, runtime);
    need(container.imageId === image.imageId, 'OCI_LOCAL_IMAGE_MAPPING_MISMATCH');
    const generations = assessBootGenerations(state, runtime);
    const services = await observeStage('services');
    exactFields(services, ['observedAt', 'legacy3001Enabled', 'legacy3001Active', 'otherBootWorkerActive', 'pollWorkerActive', 'dockerReady']);
    need(services.legacy3001Enabled === false && services.legacy3001Active === false && services.otherBootWorkerActive === false &&
      services.pollWorkerActive === false && services.dockerReady === true, 'BOOT_SERVICE_OWNERSHIP_CONFLICT');
    const request = readinessRequest(origin, state.stable.port);
    if (!container.running) {
      noStartWhileStopped();
      operations.push({ operation: 'start_saved_container_only', binary: '/usr/bin/docker', args: ['start', container.id], executionAllowed: false });
      operationPlanned = true;
      const started = await observeStage('start_result');
      noStartWhileStopped();
      exactFields(started, ['observedAt', 'containerId', 'success']); need(started.containerId === container.id && started.success === true, 'STABLE_START_OUTCOME_UNKNOWN');
    }
    const app = await observeStage('app_readiness');
    exactFields(app, ['observedAt', 'containerId', 'slot', 'running', 'ready', 'request']);
    need(app.containerId === container.id && sameSlot(app.slot, state.stable) && app.running === true && app.ready === true &&
      JSON.stringify(app.request) === JSON.stringify(request), 'STABLE_APP_NOT_READY');
    configLock = acquireLocalConfigLock(directory); fresh();
    const nginx = await observeStage('nginx');
    exactFields(nginx, ['observedAt', 'route', 'configHash', 'configMatches', 'configurationExclusive', 'nginxHealthy', 'backupHash', 'backupFile']);
    need(sameSlot(nginx.route, state.stable) && hash(nginx.configHash) && nginx.configMatches === true &&
      nginx.configurationExclusive === true && nginx.nginxHealthy === true, 'NGINX_STABLE_ROUTE_MISMATCH');
    if (state.phase === 'committed') need(nginx.configHash === state.nginxRecovery.afterHash && nginx.backupHash === state.nginxRecovery.beforeHash &&
      nginx.backupFile === state.nginxRecovery.backupFile, 'NGINX_RECOVERY_EVIDENCE_MISMATCH');
    else need(nginx.backupHash === null && nginx.backupFile === null, 'UNEXPECTED_INITIAL_RECOVERY_RECORD');
    const pub = await observeStage('public_health');
    exactFields(pub, ['observedAt', 'containerId', 'slot', 'httpStatus', 'ok', 'consecutive', 'freshConnections', 'workerGenerationConfirmed']);
    need(pub.containerId === container.id && sameSlot(pub.slot, state.stable) && pub.httpStatus === 200 && pub.ok === true &&
      Number.isSafeInteger(pub.consecutive) && pub.consecutive >= 3 && pub.consecutive <= 30 && pub.freshConnections === true &&
      pub.workerGenerationConfirmed === true, 'PUBLIC_STABLE_HEALTH_FAILED');
    fresh();
    const recovery = assessRecovery({ status: 'snapshot', executionAllowed: false, state }, {
      environment: { mounted: true, uuidMatches: true, volumeMatches: true, rootOwned: true, symlinkFree: true, mysqlHealthy: true },
      containers: [{ ...state.stable, running: true, ready: true }], route: nginx.route, configMatches: nginx.configMatches,
      nginxConfigHash: nginx.configHash, configurationExclusive: nginx.configurationExclusive, backupHash: nginx.backupHash, backupFile: nginx.backupFile,
    });
    need(recovery.status === 'stable_model', 'BOOT_RECOVERY_NOT_PROVEN'); trace.push('stable_confirmed');
    return result(container.running ? 'mock_stable_checked' : 'mock_stable_restored', null, { generations, stopRequested: stopped, recovery });
  } catch (error) {
    const blocked = error === stopBlocked && !operationPlanned;
    let incident = null;
    if (lock && !blocked) {
      // 結果不明/検査失敗を再起動で消さない。既存incidentを上書きしない。
      try { writeExclusiveLocal(path.join(directory, 'incident.json'), JSON.stringify({ reason: 'BOOT_RECOVERY_UNCERTAIN' })); syncLocalDirectory(directory); }
      catch { retainLocalLock(lock); }
      if (store) {
        try {
          const saved = store.recordIncident(lock, { reason: 'BOOT_UNCERTAIN', stage: 'boot', nginxMatch: 'unknown', dockerMatch: 'unknown', recoveryPhase: 'uncertain' });
          let notification;
          try { notification = store.prepareIncidentNotification(lock, saved.record.incidentId); }
          catch { notification = { status: 'plan_not_confirmed', executionAllowed: false, incidentResolved: false }; }
          incident = { status: saved.status, incidentId: saved.record.incidentId, notification, executionAllowed: false };
        } catch { retainLocalLock(lock); incident = { status: 'record_not_confirmed', executionAllowed: false }; }
      }
    }
    return result(blocked ? 'blocked_by_stop' : 'incident', blocked ? 'STOP_BLOCKS_RESTART_SITE_MAY_REMAIN_DOWN' : 'BOOT_RECOVERY_UNCERTAIN', { incident });
  } finally {
    for (const owned of [configLock, lock]) if (owned) { try { releaseLocalLock(owned); } catch { /* 所有権不明/事故lockを自動解除しない。 */ } }
  }
}
