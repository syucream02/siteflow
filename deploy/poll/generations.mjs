import { exactFields, need, isTime } from './contract.mjs';
import { sameSlot, validateNextSlot } from './switch-plan.mjs';
import { validateSavedContainerConfiguration, compareSavedContainerConfiguration } from './docker-plan.mjs';

// 模擬観測の整合性だけを判定する。所有権の真正性・Docker操作権限を発行しない。
const fullId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
const releaseId = value => typeof value === 'string' && /^used-[1-9][0-9]{0,19}-a[1-9][0-9]{0,19}$/.test(value);
const GiB = 1024 ** 3;
function generation(g) {
  exactFields(g, ['releaseId', 'slot', 'configuration']);
  need(releaseId(g.releaseId), 'UNKNOWN_GENERATION'); validateNextSlot(g.slot);
  need([3101, 3102].includes(g.slot.port), 'INITIAL_OR_VINEXT_GENERATION_PROTECTED');
  validateSavedContainerConfiguration(g.configuration, g.slot, g.releaseId);
}
export function validateCleanupRecord(r) {
  exactFields(r, ['version', 'mode', 'executionAllowed', 'workspaceId', 'stateRevision', 'stateHash', 'releaseId', 'rollback', 'rollbackContainerId', 'target', 'nginxHash', 'phase']);
  need(r.version === 1 && r.mode === 'local-generation-model' && r.executionAllowed === false &&
    fullId(r.workspaceId) && fullId(r.stateHash) && Number.isSafeInteger(r.stateRevision) && r.stateRevision > 0 &&
    releaseId(r.releaseId) && fullId(r.nginxHash) && ['stop_pending', 'remove_pending', 'removed'].includes(r.phase), 'INVALID_CLEANUP_RECORD');
  generation(r.rollback);
  exactFields(r.target, ['releaseId', 'slot', 'configuration', 'containerId', 'owner']);
  generation({ releaseId: r.target.releaseId, slot: r.target.slot, configuration: r.target.configuration });
  need(fullId(r.rollbackContainerId) && fullId(r.target.containerId) && r.rollbackContainerId !== r.target.containerId && r.target.owner === 'poll-release' && r.target.releaseId !== r.releaseId &&
    r.target.releaseId !== r.rollback.releaseId && r.target.slot.port !== r.rollback.slot.port &&
    r.target.slot.container !== r.rollback.slot.container && r.target.slot.image !== r.rollback.slot.image, 'PROTECTED_OR_AMBIGUOUS_GENERATION');
  return structuredClone(r);
}

function inspect(r, o, now, absent) {
  exactFields(o, ['observedAt', 'incident', 'containers', 'listeners', 'nginx', 'resources']);
  need(isTime(now) && isTime(o.observedAt) && o.observedAt <= now && now - o.observedAt <= 5 && o.incident === false &&
    Array.isArray(o.containers) && o.containers.length <= 100 && Array.isArray(o.listeners) && o.listeners.length <= 100, 'STALE_OR_UNKNOWN_GENERATION_OBSERVATION');
  for (const c of o.containers) {
    exactFields(c, ['containerId', 'releaseId', 'owner', 'slot', 'configuration', 'running', 'ready']);
    need(fullId(c.containerId) && typeof c.releaseId === 'string' && typeof c.owner === 'string' &&
      typeof c.running === 'boolean' && typeof c.ready === 'boolean', 'INVALID_GENERATION_CONTAINER');
    validateNextSlot(c.slot);
  }
  need(new Set(o.containers.map(c => c.containerId)).size === o.containers.length &&
    new Set(o.containers.map(c => c.slot.container)).size === o.containers.length &&
    new Set(o.containers.map(c => c.slot.port)).size === o.containers.length, 'GENERATION_COLLISION');
  for (const l of o.listeners) { exactFields(l, ['port', 'containerId']); need(Number.isInteger(l.port) && l.port > 0 && l.port < 65536 && fullId(l.containerId), 'UNKNOWN_LISTENER'); }
  const protectedContainers = o.containers.filter(c => sameSlot(c.slot, r.rollback.slot));
  need(protectedContainers.length === 1, 'ROLLBACK_CONTAINER_MISSING');
  const stable = protectedContainers[0];
  need(stable.containerId === r.rollbackContainerId && stable.releaseId === r.rollback.releaseId && stable.owner === 'poll-release' && stable.running === true && stable.ready === true, 'ROLLBACK_NOT_HEALTHY_OR_OWNED');
  compareSavedContainerConfiguration(r.rollback.configuration, stable.slot, stable.releaseId, stable.configuration);
  const stableListeners = o.listeners.filter(l => l.port === stable.slot.port);
  need(stableListeners.length === 1 && stableListeners[0].containerId === stable.containerId, 'ROLLBACK_LISTENER_MISMATCH');
  exactFields(o.nginx, ['slot', 'configHash', 'healthy', 'configurationExclusive']);
  need(sameSlot(o.nginx.slot, r.rollback.slot) && o.nginx.configHash === r.nginxHash && o.nginx.healthy === true &&
    o.nginx.configurationExclusive === true, 'NGINX_REFERENCE_UNCERTAIN');
  exactFields(o.resources, ['availableMemoryBytes', 'rootFreeBytes', 'imageUnpackedBytes', 'mysqlHealthy']);
  need(o.resources.mysqlHealthy === true && Number.isSafeInteger(o.resources.availableMemoryBytes) && o.resources.availableMemoryBytes >= 768 * 1024 ** 2 &&
    Number.isSafeInteger(o.resources.imageUnpackedBytes) && o.resources.imageUnpackedBytes > 0 &&
    Number.isSafeInteger(o.resources.rootFreeBytes) && o.resources.rootFreeBytes >= 2 * o.resources.imageUnpackedBytes + 2 * GiB, 'GENERATION_RESOURCE_SHORTAGE');
  const matches = o.containers.filter(c => c.containerId === r.target.containerId || c.releaseId === r.target.releaseId ||
    c.slot.container === r.target.slot.container || c.slot.port === r.target.slot.port);
  const listeners = o.listeners.filter(l => l.port === r.target.slot.port || l.containerId === r.target.containerId);
  if (absent) { need(matches.length === 0 && listeners.length === 0, 'REMOVAL_NOT_CONFIRMED'); return null; }
  need(matches.length === 1, 'TARGET_MISSING_OR_REPLACED'); const target = matches[0];
  need(target.containerId === r.target.containerId && target.releaseId === r.target.releaseId && target.owner === r.target.owner &&
    sameSlot(target.slot, r.target.slot), 'TARGET_IDENTITY_MISMATCH');
  compareSavedContainerConfiguration(r.target.configuration, target.slot, target.releaseId, target.configuration);
  need(target.running ? listeners.length === 1 && listeners[0].containerId === target.containerId : listeners.length === 0, 'TARGET_LISTENER_MISMATCH');
  return target;
}
export function createGenerationCleanup(state, retired, stableRecord, observed, stateHash, now) {
  generation(retired); generation(stableRecord);
  need(state.schemaVersion === 3 && state.phase === 'preparing' && state.incident === null && state.candidate === null &&
    state.candidateConfiguration === null && sameSlot(state.previous, state.stable) &&
    JSON.stringify(state.previousConfiguration) === JSON.stringify(state.stableConfiguration) &&
    stableRecord.releaseId === state.stableReleaseId && sameSlot(stableRecord.slot, state.stable) &&
    JSON.stringify(stableRecord.configuration) === JSON.stringify(state.stableConfiguration) &&
    state.consumedIds.includes(retired.releaseId) && state.consumedIds.includes(state.activeReleaseId), 'ROLLBACK_TRANSFER_NOT_RECORDED');
  need(retired.slot.port === (state.stable.port === 3101 ? 3102 : 3101), 'NOT_NEXT_CANDIDATE_SLOT');
  const candidates = observed?.containers?.filter(c => c.releaseId === retired.releaseId) ?? [];
  need(candidates.length === 1, 'UNKNOWN_TARGET_GENERATION');
  const r = { version: 1, mode: 'local-generation-model', executionAllowed: false, workspaceId: state.workspaceId,
    stateRevision: state.revision, stateHash, releaseId: state.activeReleaseId, rollback: structuredClone(stableRecord),
    rollbackContainerId: observed.containers.find(c => sameSlot(c.slot, state.stable))?.containerId,
    target: { ...structuredClone(retired), containerId: candidates[0].containerId, owner: candidates[0].owner },
    nginxHash: observed.nginx?.configHash, phase: 'stop_pending' };
  validateCleanupRecord(r); inspect(r, observed, now, false); return r;
}
export function checkGenerationCleanup(record, observed, now) {
  const r = validateCleanupRecord(record); need(r.phase !== 'removed', 'CLEANUP_ALREADY_FINISHED');
  const target = inspect(r, observed, now, false);
  if (r.phase === 'remove_pending') need(target.running === false, 'TARGET_NOT_STOPPED');
  return { mode: 'local-plan', executionAllowed: false, target: structuredClone(r.target),
    operation: { binary: '/usr/bin/docker', args: [r.phase === 'stop_pending' ? 'stop' : 'rm', r.target.containerId] } };
}
export function confirmGenerationCleanup(record, event, observed, now) {
  const r = validateCleanupRecord(record);
  need((event === 'stopped' && r.phase === 'stop_pending') || (event === 'removed' && r.phase === 'remove_pending'), 'INVALID_CLEANUP_TRANSITION');
  if (event === 'stopped') need(inspect(r, observed, now, false).running === false, 'TARGET_NOT_STOPPED');
  else inspect(r, observed, now, true);
  return { ...r, phase: event === 'stopped' ? 'remove_pending' : 'removed' };
}
