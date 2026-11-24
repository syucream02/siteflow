import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { exactFields, need, isTime } from './contract.mjs';
import { decodeStrictJson } from './transport.mjs';
import { validateNextSlot, sameSlot } from './switch-plan.mjs';
import { assertLocalDirectory, assertLocalLock, assertLocalConfigLock, readLocalFile, writeExclusiveLocal, syncLocalDirectory, retainLocalLock } from './lock.mjs';
import { initializeLocalStopControl, openLocalStopReader } from './stop-control.mjs';
import { takeContainerConfiguration, validateSavedContainerConfiguration } from './docker-plan.mjs';
import { createGenerationCleanup, validateCleanupRecord, checkGenerationCleanup, confirmGenerationCleanup } from './generations.mjs';
import { createIncidentRecord, validateIncidentRecord, summarizeIncidentSlot, validateIncidentNotice, validateIncidentOutcome, planIncidentNotification } from './incident.mjs';

// ローカル試験専用。checksumは破損検出であり、改ざんの真正性証明ではない。
const phases = ['idle', 'preparing', 'candidate_starting', 'candidate_checking', 'candidate_ready', 'switching', 'verifying', 'committing', 'committed', 'rolling_back', 'incident'];
const idPattern = /^used-[1-9][0-9]{0,19}-a[1-9][0-9]{0,19}$/;
const hash = text => createHash('sha256').update(text).digest('hex');
const journalName = revision => `revision-${String(revision).padStart(10, '0')}.json`;
const fields = ['schemaVersion', 'mode', 'executionAllowed', 'workspaceId', 'revision', 'updatedAt', 'phase', 'stable', 'lastKnownGood', 'previous', 'candidate', 'activeReleaseId', 'consumedIds', 'incident'];
const receipts = new WeakMap();
const nginxPhases = ['candidate_ready', 'staging', 'switch_ready', 'install_pending', 'installed', 'reload_pending', 'verifying', 'commit_pending', 'committed', 'rolling_back', 'rollback_validating', 'rollback_reloading', 'rollback_verifying', 'incident'];
const validReleaseId = id => typeof id === 'string' && (idPattern.test(id) || /^manual-[a-zA-Z0-9_.-]{1,80}$/.test(id));
const incidentFile = /^incident-(record-[a-f0-9]{64}|(?:notice|outcome)-[a-f0-9]{64}-[0-9]{1,16})\.json$/;
function readIncidentFiles(root, workspaceId) {
  const names = fs.readdirSync(root).filter(n => incidentFile.test(n));
  need(names.length <= 3000, 'INCIDENT_RECORD_LIMIT');
  const records = new Map(), history = new Map();
  for (const name of names.filter(n => n.startsWith('incident-record-'))) {
    const r = validateIncidentRecord(decodeStrictJson(Buffer.from(readLocalFile(path.join(root, name), 16384))));
    need(r.workspaceId === workspaceId && name === `incident-record-${r.incidentId}.json`, 'INCIDENT_WORKSPACE_MISMATCH');
    records.set(r.incidentId, r); history.set(r.incidentId, []);
  }
  const used = new Set();
  for (const name of names.filter(n => n.startsWith('incident-notice-'))) {
    const n = decodeStrictJson(Buffer.from(readLocalFile(path.join(root, name), 4096)));
    validateIncidentNotice(n, n.incidentId);
    need(records.has(n.incidentId) && name === `incident-notice-${n.incidentId}-${n.attemptedAt}.json`, 'ORPHAN_INCIDENT_NOTICE');
    const outcomeFile = `incident-outcome-${n.incidentId}-${n.attemptedAt}.json`;
    const outcome = names.includes(outcomeFile) ? validateIncidentOutcome(decodeStrictJson(Buffer.from(readLocalFile(path.join(root, outcomeFile), 4096))), n) : null;
    if (outcome) used.add(outcomeFile);
    history.get(n.incidentId).push({ notice: n, outcome });
  }
  need(names.filter(n => n.startsWith('incident-outcome-')).every(n => used.has(n)), 'ORPHAN_INCIDENT_OUTCOME');
  return { records, history };
}
// journal APIも飛び越し記録を拒否する。Nginxモデルと別に呼ばれても確定を偽装しない。
const recordedEdges = {
  backup_saved: ['candidate_ready', 'staging'], staged_validated: ['staging', 'switch_ready'], intent_saved: ['switch_ready', 'install_pending'],
  config_installed: ['install_pending', 'installed'], config_validated: ['installed', 'reload_pending'], reloaded: ['reload_pending', 'verifying'],
  public_checked: ['verifying', 'commit_pending'], committed: ['commit_pending', 'committed'],
  rollback_restored: ['rolling_back', 'rollback_validating'], rollback_validated: ['rollback_validating', 'rollback_reloading'],
  rollback_reloaded: ['rollback_reloading', 'rollback_verifying'], rollback_checked: ['rollback_verifying', 'incident'],
};
function validateRecordedEdge(plan, event, next) {
  exactFields(event, ['type', 'success', 'observation'], 'INVALID_RECORDED_EVENT');
  need(typeof event.success === 'boolean', 'INVALID_RECORDED_EVENT');
  const changed = ['install_pending', 'installed', 'reload_pending', 'verifying', 'commit_pending', 'rolling_back', 'rollback_validating', 'rollback_reloading', 'rollback_verifying'].includes(plan.phase);
  if (event.type === 'abort') { need(next.phase === (changed ? 'rolling_back' : 'incident'), 'INVALID_RECORDED_EDGE'); return; }
  const edge = recordedEdges[event.type];
  need(Object.hasOwn(recordedEdges, event.type) && edge[0] === plan.phase, 'INVALID_RECORDED_EDGE');
  let passed = event.success;
  if (['public_checked', 'rollback_checked'].includes(event.type)) {
    const o = event.observation, slot = event.type === 'public_checked' ? plan.candidate : plan.previous;
    passed = passed && sameSlot(o, slot) && o.running === true && o.ready === true && o.httpStatus === 200 && o.ok === true &&
      Number.isSafeInteger(o.consecutive) && o.consecutive >= 3 && o.consecutive <= 30 && o.freshConnections === true && o.workerGenerationConfirmed === true;
  }
  const expected = passed ? edge[1] : plan.phase.startsWith('rollback') || plan.phase === 'rolling_back' || plan.phase === 'commit_pending' ? 'incident' : changed ? 'rolling_back' : 'incident';
  need(next.phase === expected, 'INVALID_RECORDED_EDGE');
}

function validateNginxRecovery(r, s) {
  exactFields(r, ['version', 'releaseId', 'previousReleaseId', 'previous', 'candidate', 'configPath', 'beforeHash', 'afterHash', 'backupFile', 'backupBytes', 'planPhase', 'operation'], 'INVALID_NGINX_RECOVERY');
  need(r.version === 1 && r.releaseId === s.activeReleaseId && validReleaseId(r.previousReleaseId) &&
    r.configPath === '/etc/nginx/conf.d/siteflow.conf' && /^[a-f0-9]{64}$/.test(r.beforeHash) && !/^0+$/.test(r.beforeHash) &&
    /^[a-f0-9]{64}$/.test(r.afterHash) && !/^0+$/.test(r.afterHash) && r.beforeHash !== r.afterHash &&
    r.backupFile === `nginx-backup-${r.releaseId}.json` && Number.isSafeInteger(r.backupBytes) && r.backupBytes > 0 && r.backupBytes <= 65536 &&
    nginxPhases.includes(r.planPhase) && typeof r.operation === 'string' && /^[a-z_]{1,40}$/.test(r.operation), 'INCONSISTENT_NGINX_RECOVERY');
  validateNextSlot(r.previous); validateNextSlot(r.candidate);
  need(sameSlot(r.previous, s.previous) && sameSlot(r.candidate, s.candidate), 'NGINX_RECOVERY_SLOT_MISMATCH');
  need(s.phase === 'committed' ? s.stableReleaseId === r.releaseId && r.planPhase === 'committed' : s.stableReleaseId === r.previousReleaseId, 'NGINX_RECOVERY_RELEASE_MISMATCH');
}

export function validatePersistentModel(s) {
  const versioned = [...fields, 'stableReleaseId', 'nginxRecovery'];
  exactFields(s, s?.schemaVersion === 3 ? [...versioned, 'stableConfiguration', 'previousConfiguration', 'candidateConfiguration'] : s?.schemaVersion === 2 ? versioned : fields, 'INVALID_STATE_FIELDS');
  need([1, 2, 3].includes(s.schemaVersion) && s.mode === 'local-model' && s.executionAllowed === false, 'UNSUPPORTED_STATE_VERSION_OR_MODE');
  need(typeof s.workspaceId === 'string' && /^[a-f0-9]{64}$/.test(s.workspaceId) &&
    Number.isSafeInteger(s.revision) && s.revision >= 0 && s.revision <= 9999999999 && isTime(s.updatedAt), 'INVALID_STATE_METADATA');
  need(phases.includes(s.phase), 'INVALID_STATE_PHASE');
  validateNextSlot(s.stable); validateNextSlot(s.lastKnownGood);
  need(sameSlot(s.stable, s.lastKnownGood), 'STABLE_HISTORY_MISMATCH');
  if (s.previous !== null) validateNextSlot(s.previous);
  if (s.candidate !== null) validateNextSlot(s.candidate);
  if (s.phase === 'idle') need(s.previous === null && s.candidate === null && s.revision === 0 && s.consumedIds?.length === 0, 'INVALID_INITIAL_STATE');
  need(Array.isArray(s.consumedIds) && s.consumedIds.length <= 1000 && s.consumedIds.every(id => typeof id === 'string' && idPattern.test(id)) &&
    new Set(s.consumedIds).size === s.consumedIds.length, 'INVALID_CONSUMED_IDS');
  need(s.activeReleaseId === null || s.consumedIds.includes(s.activeReleaseId), 'ACTIVE_RELEASE_NOT_CONSUMED');
  need(s.phase === 'idle' ? s.activeReleaseId === null && s.candidate === null : s.phase === 'incident' || s.activeReleaseId !== null, 'INVALID_ACTIVE_RELEASE');
  if (s.phase === 'preparing') need(s.previous !== null && (s.candidate === null || (s.schemaVersion === 3 && s.candidateConfiguration !== null)), 'INVALID_PREPARING_STATE');
  if (['candidate_starting', 'candidate_checking', 'candidate_ready', 'switching', 'verifying', 'committing', 'committed', 'rolling_back'].includes(s.phase)) {
    need(s.candidate !== null && s.previous !== null, 'MISSING_RELEASE_SLOTS');
  }
  if (s.previous !== null && s.phase !== 'committed') need(sameSlot(s.stable, s.previous), 'PREVIOUS_STABLE_MISMATCH');
  if (s.candidate !== null) {
    need(s.previous !== null && s.candidate.port === (s.previous.port === 3101 ? 3102 : 3101) &&
      s.candidate.container !== s.previous.container && s.candidate.image.startsWith('ghcr.io/syucream02/siteflow@'), 'INVALID_SAVED_CANDIDATE');
  }
  if (s.phase === 'committed') need(sameSlot(s.stable, s.candidate), 'COMMITTED_CANDIDATE_MISMATCH');
  need(s.phase === 'incident' ? typeof s.incident === 'string' && /^[A-Z_]{1,64}$/.test(s.incident) : s.incident === null, 'INVALID_INCIDENT');
  if (s.schemaVersion >= 2) {
    need(s.stableReleaseId === null || validReleaseId(s.stableReleaseId), 'INVALID_STABLE_RELEASE_ID');
    if (s.nginxRecovery !== null) validateNginxRecovery(s.nginxRecovery, s);
    if (['switching', 'verifying', 'committing', 'committed', 'rolling_back'].includes(s.phase)) need(s.nginxRecovery !== null, 'NGINX_RECOVERY_REQUIRED');
  }
  if (s.schemaVersion === 3) {
    validateSavedContainerConfiguration(s.stableConfiguration, s.stable, s.stableReleaseId);
    if (s.previous === null) need(s.previousConfiguration === null, 'UNEXPECTED_PREVIOUS_CONFIGURATION');
    else validateSavedContainerConfiguration(s.previousConfiguration, s.previous, s.phase === 'committed' ? s.nginxRecovery.previousReleaseId : s.stableReleaseId);
    if (s.candidateConfiguration !== null) validateSavedContainerConfiguration(s.candidateConfiguration, s.candidate, s.activeReleaseId);
    if (['candidate_starting', 'candidate_checking', 'candidate_ready', 'switching', 'verifying', 'committing', 'committed', 'rolling_back'].includes(s.phase)) need(s.candidateConfiguration !== null, 'CANDIDATE_CONFIGURATION_REQUIRED');
  }
  return structuredClone(s);
}
function encode(state) {
  validatePersistentModel(state);
  return JSON.stringify({ formatVersion: 1, payload: state, checksumSha256: hash(JSON.stringify(state)) });
}
function decode(text) {
  const envelope = decodeStrictJson(Buffer.from(text));
  exactFields(envelope, ['formatVersion', 'payload', 'checksumSha256'], 'INVALID_STATE_ENVELOPE');
  need(envelope.formatVersion === 1 && envelope.checksumSha256 === hash(JSON.stringify(envelope.payload)), 'STATE_CHECKSUM_MISMATCH');
  return validatePersistentModel(envelope.payload);
}
function readSnapshot(root, allowCleanup = false) {
  need(!fs.existsSync(path.join(root, 'incident.json')) && !fs.existsSync(path.join(root, 'pending.json')), 'INCOMPLETE_OR_INCIDENT_STATE');
  need(allowCleanup || !fs.existsSync(path.join(root, 'generation-cleanup.json')), 'GENERATION_CLEANUP_INCOMPLETE');
  const state = decode(readLocalFile(path.join(root, 'state.json')));
  const workspace = decodeStrictJson(Buffer.from(readLocalFile(path.join(root, 'workspace.json'), 4096)));
  exactFields(workspace, ['version', 'workspaceId'], 'INVALID_WORKSPACE');
  need(workspace.version === 1 && workspace.workspaceId === state.workspaceId, 'WORKSPACE_MISMATCH');
  const names = fs.readdirSync(root);
  need(names.every(n => incidentFile.test(n) || ['release.lock', 'nginx.lock', 'workspace.json', 'state.json', 'stop-binding.json', 'generation-cleanup.json'].includes(n) ||
    /^generation-done-used-[1-9][0-9]{0,19}-a[1-9][0-9]{0,19}\.json$/.test(n) ||
    /^stop-(request|failed)-[a-f0-9]{64}\.json$/.test(n) || /^nginx-backup-used-[1-9][0-9]{0,19}-a[1-9][0-9]{0,19}\.json$/.test(n) ||
    /^revision-\d{10}\.json$/.test(n) || /^used-[1-9][0-9]{0,19}-a[1-9][0-9]{0,19}\.json$/.test(n)), 'UNEXPECTED_STATE_FILE');
  const journals = names.filter(n => /^revision-\d{10}\.json$/.test(n)).sort();
  need(journals.length === state.revision + 1 && journals.every((n, i) => n === journalName(i)), 'STATE_GENERATION_GAP');
  need(readLocalFile(path.join(root, journalName(state.revision))) === encode(state), 'STATE_JOURNAL_MISMATCH');
  const markers = names.filter(n => n.startsWith('used-')).sort();
  need(JSON.stringify(markers) === JSON.stringify(state.consumedIds.map(id => `${id}.json`).sort()), 'USED_MARKER_MISMATCH');
  for (const id of state.consumedIds) need(readLocalFile(path.join(root, `${id}.json`), 4096) === JSON.stringify({ workspaceId: state.workspaceId, releaseId: id }), 'USED_MARKER_CORRUPT');
  for (const name of names.filter(n => n.startsWith('generation-done-'))) {
    const record = decodeCleanup(readLocalFile(path.join(root, name), 65536));
    need(record.phase === 'removed' && record.workspaceId === state.workspaceId && state.consumedIds.includes(record.releaseId) &&
      state.consumedIds.includes(record.target.releaseId) && name === `generation-done-${record.target.releaseId}.json`, 'INVALID_COMPLETED_CLEANUP');
  }
  const incidents = readIncidentFiles(root, state.workspaceId);
  need(incidents.records.size === 0 || state.phase === 'incident', 'UNRESOLVED_INCIDENT_RECORD');
  if (state.schemaVersion >= 2 && state.nginxRecovery !== null) verifyBackup(root, state);
  return state;
}
function encodeCleanup(record) { validateCleanupRecord(record); return JSON.stringify({ payload: record, checksum: hash(JSON.stringify(record)) }); }
function decodeCleanup(text) {
  const envelope = decodeStrictJson(Buffer.from(text)); exactFields(envelope, ['payload', 'checksum']);
  need(envelope.checksum === hash(JSON.stringify(envelope.payload)), 'CLEANUP_CHECKSUM_MISMATCH'); return validateCleanupRecord(envelope.payload);
}
export function inspectLocalState(directory) {
  const root = assertLocalDirectory(directory);
  try {
    const state = readSnapshot(root);
    if (state.schemaVersion === 1) return { status: 'legacy_readonly', reason: 'EXPLICIT_MIGRATION_REQUIRED', state, executionAllowed: false };
    const locked = ['release.lock', 'nginx.lock'].some(n => fs.existsSync(path.join(root, n)));
    const stopped = openLocalStopReader(root, state.workspaceId).read().status !== 'clear';
    return { status: locked || stopped ? 'incident' : 'snapshot', reason: locked ? 'RESIDUAL_OR_ACTIVE_LOCK' : stopped ? 'STOP_REQUESTED_OR_UNKNOWN' : null, state, executionAllowed: false };
  } catch {
    return { status: 'incident', reason: 'STATE_UNREADABLE_OR_UNCERTAIN', state: null, executionAllowed: false };
  }
}
function verifyBackup(root, s) {
  const r = s.nginxRecovery;
  const b = decodeStrictJson(Buffer.from(readLocalFile(path.join(root, r.backupFile), 100000)));
  exactFields(b, ['version', 'workspaceId', 'releaseId', 'base64'], 'INVALID_NGINX_BACKUP');
  need(b.version === 1 && b.workspaceId === s.workspaceId && b.releaseId === r.releaseId && typeof b.base64 === 'string', 'NGINX_BACKUP_ID_MISMATCH');
  const bytes = Buffer.from(b.base64, 'base64');
  need(bytes.toString('base64') === b.base64 && bytes.length === r.backupBytes && hash(bytes) === r.beforeHash, 'NGINX_BACKUP_CORRUPT');
  return bytes;
}

export function readRecordedNginxPlan(receipt, plan) {
  const context = receipts.get(receipt); need(context, 'PERSISTED_NGINX_RECEIPT_REQUIRED');
  return context.read(plan);
}
export function recordNginxTransition(receipt, plan, event, next) {
  const context = receipts.get(receipt); need(context, 'PERSISTED_NGINX_RECEIPT_REQUIRED');
  return context.record(plan, event, next);
}

export function createLocalStateStore(directory, { now, fault = () => {}, forwardDeadline = null }) {
  const root = assertLocalDirectory(directory);
  need(typeof now === 'function' && typeof fault === 'function' && (forwardDeadline === null || (isTime(forwardDeadline) && forwardDeadline > 0)), 'INVALID_LOCAL_STORE_OPTIONS');
  function time(previous = 0) { const t = now(); need(isTime(t) && t >= previous, 'INVALID_OR_BACKWARD_CLOCK'); return t; }
  function checkForwardDeadline(state, recovery) {
    if (!recovery && forwardDeadline !== null) need(state.updatedAt < forwardDeadline && time(state.updatedAt) < forwardDeadline, 'FORWARD_RECORD_DEADLINE_EXPIRED');
  }
  function latch(lock) {
    retainLocalLock(lock);
    try { writeExclusiveLocal(path.join(root, 'incident.json'), JSON.stringify({ reason: 'STATE_WRITE_UNCERTAIN' })); syncLocalDirectory(root); } catch { /* 残存lock/pendingも拒否理由。容量不足でマーカーさえ書けない場合がある。 */ }
  }
  function stopReader(s) { return openLocalStopReader(root, s.workspaceId); }
  function save(lock, state, consumeId = null, allowStopped = false) {
    assertLocalLock(lock, root);
    // 書き始める前の失効は記録不明ではない。既存receiptで中断/復旧できるよう、
    // incidentラッチを書かずに拒否する。復旧/事故記録には前進期限を適用しない。
    checkForwardDeadline(state, allowStopped);
    try {
      if (!allowStopped) stopReader(state).assertClear();
      writeExclusiveLocal(path.join(root, 'pending.json'), JSON.stringify({ revision: state.revision })); syncLocalDirectory(root);
      fault('after_intent');
      if (consumeId !== null) writeExclusiveLocal(path.join(root, `${consumeId}.json`), JSON.stringify({ workspaceId: state.workspaceId, releaseId: consumeId }));
      checkForwardDeadline(state, allowStopped);
      const text = encode(state);
      writeExclusiveLocal(path.join(root, journalName(state.revision)), text); syncLocalDirectory(root);
      const temporary = path.join(root, `state-next-${randomBytes(12).toString('hex')}.json`);
      writeExclusiveLocal(temporary, text); fault('before_rename');
      if (!allowStopped) stopReader(state).assertClear();
      checkForwardDeadline(state, allowStopped);
      fs.renameSync(temporary, path.join(root, 'state.json')); fault('after_rename');
      syncLocalDirectory(root); fault('before_intent_clear');
      fs.unlinkSync(path.join(root, 'pending.json')); syncLocalDirectory(root);
      if (!allowStopped) stopReader(state).assertClear();
      checkForwardDeadline(state, allowStopped);
      return structuredClone(state);
    } catch { latch(lock); throw new Error('STATE_WRITE_UNCERTAIN'); }
  }
  function read(lock) { assertLocalLock(lock, root); return readSnapshot(root); }
  function expected(lock, revision) { const s = read(lock); need(s.schemaVersion >= 2, 'LEGACY_STATE_READ_ONLY'); need(s.revision === revision && s.phase !== 'incident', 'STALE_OR_INCIDENT_STATE'); return s; }
  const cleanupReceipts = new WeakMap();
  const noticeReceipts = new WeakMap();
  function incidentWorkspace(lock) {
    assertLocalLock(lock, root);
    const w = decodeStrictJson(Buffer.from(readLocalFile(path.join(root, 'workspace.json'), 4096)));
    exactFields(w, ['version', 'workspaceId']); need(w.version === 1 && /^[a-f0-9]{64}$/.test(w.workspaceId), 'INVALID_INCIDENT_WORKSPACE'); return w.workspaceId;
  }
  function committedGeneration(releaseId, beforeRevision) {
    const matches = [];
    for (let revision = 0; revision < beforeRevision; revision++) {
      const s = decode(readLocalFile(path.join(root, journalName(revision))));
      if (s.schemaVersion === 3 && s.phase === 'committed' && s.stableReleaseId === releaseId) matches.push(s);
    }
    need(matches.length === 1, 'COMMITTED_GENERATION_NOT_UNIQUE'); return matches[0];
  }
  function cleanupContext(receipt, observed) {
    const h = cleanupReceipts.get(receipt); need(h && !h.finished, 'ORIGINAL_CLEANUP_RECEIPT_REQUIRED');
    assertLocalLock(h.lock, root); assertLocalConfigLock(h.configLock, root);
    const s = readSnapshot(root, true);
    need(s.revision === h.record.stateRevision && hash(JSON.stringify(s)) === h.record.stateHash && s.phase === 'preparing' && s.incident === null, 'CLEANUP_STATE_CHANGED');
    stopReader(s).assertClear(); checkForwardDeadline(s, false);
    need(readLocalFile(path.join(root, 'generation-cleanup.json'), 65536) === encodeCleanup(h.record), 'CLEANUP_RECORD_CHANGED');
    const old = committedGeneration(h.record.target.releaseId, s.revision), stable = committedGeneration(s.stableReleaseId, s.revision);
    need(JSON.stringify(old.stableConfiguration) === JSON.stringify(h.record.target.configuration) && sameSlot(old.stable, h.record.target.slot) &&
      sameSlot(stable.stable, s.stable) && stable.nginxRecovery.afterHash === h.record.nginxHash, 'CLEANUP_HISTORY_CHANGED');
    return { h, s, observedAt: time(s.updatedAt), observed };
  }
  function writeCleanup(record, initial) {
    if (initial) writeExclusiveLocal(path.join(root, 'generation-cleanup.json'), encodeCleanup(record));
    else {
      const temporary = path.join(root, `generation-next-${randomBytes(12).toString('hex')}.json`);
      writeExclusiveLocal(temporary, encodeCleanup(record)); fault('cleanup_before_rename');
      fs.renameSync(temporary, path.join(root, 'generation-cleanup.json'));
    }
    syncLocalDirectory(root); fault('cleanup_after_write');
    need(readLocalFile(path.join(root, 'generation-cleanup.json'), 65536) === encodeCleanup(record), 'CLEANUP_WRITE_NOT_CONFIRMED');
  }
  return Object.freeze({
    mode: 'local-test-only', executionAllowed: false,
    durability: process.platform === 'win32' ? 'directory-fsync-unverified' : 'file-and-directory-fsync-not-powerloss-tested',
    initialize(lock, stable, stableReleaseId = null, bootstrapReceipt = null) {
      assertLocalLock(lock, root); validateNextSlot(stable);
      need(fs.readdirSync(root).every(n => n === 'release.lock'), 'STATE_ALREADY_EXISTS');
      const workspaceId = randomBytes(32).toString('hex');
      try { writeExclusiveLocal(path.join(root, 'workspace.json'), JSON.stringify({ version: 1, workspaceId })); syncLocalDirectory(root); initializeLocalStopControl(root, workspaceId); }
      catch { latch(lock); throw new Error('STATE_INITIALIZATION_UNCERTAIN'); }
      const configuration = bootstrapReceipt === null ? null : takeContainerConfiguration(bootstrapReceipt, stable, stableReleaseId);
      return save(lock, { schemaVersion: configuration ? 3 : 2, mode: 'local-model', executionAllowed: false, workspaceId, revision: 0, updatedAt: time(), phase: 'idle',
        stable, lastKnownGood: stable, stableReleaseId, nginxRecovery: null, previous: null, candidate: null, activeReleaseId: null, consumedIds: [], incident: null,
        ...(configuration ? { stableConfiguration: configuration, previousConfiguration: null, candidateConfiguration: null } : {}) });
    },
    read,
    recordIncident(lock, details) {
      try {
        const workspaceId = incidentWorkspace(lock);
        exactFields(details, ['reason', 'stage', 'nginxMatch', 'dockerMatch', 'recoveryPhase']);
        let s = null, confidence = 'unconfirmed';
        try { s = readSnapshot(root, true); confidence = 'validated'; }
        catch { try { s = decode(readLocalFile(path.join(root, 'state.json'))); need(s.workspaceId === workspaceId, 'INCIDENT_STATE_WORKSPACE_MISMATCH'); } catch { s = null; } }
        const old = readIncidentFiles(root, workspaceId);
        const occurredAt = time(Math.max(s?.updatedAt ?? 0, ...Array.from(old.records.values(), r => r.occurredAt)));
        const cleanup = fs.existsSync(path.join(root, 'generation-cleanup.json'));
        const r = createIncidentRecord({ workspaceId, stateRevision: s?.revision ?? 0, stateConfidence: confidence,
          releaseId: s?.activeReleaseId ?? null, reason: cleanup ? 'CLEANUP_UNCERTAIN' : details.reason,
          stage: cleanup ? 'generation_cleanup' : details.stage, phase: s?.phase ?? 'unknown',
          stable: summarizeIncidentSlot(s?.stable), rollback: summarizeIncidentSlot(s?.previous),
          stopStatus: openLocalStopReader(root, workspaceId).read().status,
          nginxMatch: details.nginxMatch, dockerMatch: details.dockerMatch, recoveryPhase: details.recoveryPhase,
          lastKnownGood: summarizeIncidentSlot(s?.lastKnownGood) }, occurredAt);
        if (old.records.has(r.incidentId)) return { status: 'already_recorded', record: old.records.get(r.incidentId), executionAllowed: false };
        // 既存事故ラッチ/消費済みIDを上書きしない。詳細自体も通常配信の拒否理由。
        fault('before_incident_write');
        const file = path.join(root, `incident-record-${r.incidentId}.json`), text = JSON.stringify(r);
        writeExclusiveLocal(file, text); syncLocalDirectory(root); fault('after_incident_write');
        need(readLocalFile(file, 16384) === text, 'INCIDENT_READBACK_FAILED');
        return { status: 'recorded', record: r, executionAllowed: false };
      } catch { latch(lock); throw new Error('INCIDENT_RECORD_NOT_CONFIRMED'); }
    },
    listIncidents(lock) {
      const workspaceId = incidentWorkspace(lock);
      return Array.from(readIncidentFiles(root, workspaceId).records.values(), r => structuredClone(r));
    },
    prepareIncidentNotification(lock, incidentId) {
      try {
        const workspaceId = incidentWorkspace(lock), data = readIncidentFiles(root, workspaceId);
        const r = data.records.get(incidentId); need(r, 'UNKNOWN_INCIDENT');
        const plan = planIncidentNotification(r, data.history.get(incidentId), time(r.occurredAt));
        if (plan.status === 'suppressed') return plan;
        const notice = { version: 1, incidentId, attemptedAt: time(r.occurredAt) };
        const file = path.join(root, `incident-notice-${incidentId}-${notice.attemptedAt}.json`), text = JSON.stringify(notice);
        fault('before_incident_notice'); writeExclusiveLocal(file, text); syncLocalDirectory(root);
        need(readLocalFile(file, 4096) === text, 'NOTICE_RESERVATION_UNCONFIRMED');
        const receipt = Object.freeze({ mode: 'local-notice-model', executionAllowed: false });
        noticeReceipts.set(receipt, { notice, lock, done: false });
        return { ...plan, receipt };
      } catch { latch(lock); throw new Error('INCIDENT_NOTICE_NOT_CONFIRMED'); }
    },
    recordIncidentNotification(receipt, status) {
      const h = noticeReceipts.get(receipt); need(h && !h.done, 'ORIGINAL_NOTICE_RECEIPT_REQUIRED');
      try {
        const workspaceId = incidentWorkspace(h.lock), data = readIncidentFiles(root, workspaceId);
        need(data.history.get(h.notice.incidentId)?.some(i => JSON.stringify(i.notice) === JSON.stringify(h.notice) && i.outcome === null), 'NOTICE_CHANGED');
        const outcome = { ...h.notice, status }; validateIncidentOutcome(outcome, h.notice);
        const file = path.join(root, `incident-outcome-${h.notice.incidentId}-${h.notice.attemptedAt}.json`), text = JSON.stringify(outcome);
        fault('before_incident_outcome'); writeExclusiveLocal(file, text); syncLocalDirectory(root);
        need(readLocalFile(file, 4096) === text, 'NOTICE_OUTCOME_UNCONFIRMED'); h.done = true;
        return { status, incidentResolved: false, executionAllowed: false };
      } catch { latch(h.lock); throw new Error('INCIDENT_NOTICE_OUTCOME_UNCONFIRMED'); }
    },
    prepareGenerationCleanup(lock, configLock, revision, retiredReleaseId, observation) {
      const s = expected(lock, revision); assertLocalConfigLock(configLock, root); stopReader(s).assertClear(); checkForwardDeadline(s, false);
      need(typeof retiredReleaseId === 'string' && idPattern.test(retiredReleaseId) && retiredReleaseId !== s.stableReleaseId && retiredReleaseId !== s.activeReleaseId, 'PROTECTED_RELEASE');
      need(s.schemaVersion === 3 && s.phase === 'preparing' && s.candidate === null && s.candidateConfiguration === null &&
        !fs.existsSync(path.join(root, `generation-done-${retiredReleaseId}.json`)), 'CLEANUP_PHASE_OR_REUSE');
      const old = committedGeneration(retiredReleaseId, revision), stable = committedGeneration(s.stableReleaseId, revision);
      need(observation.nginx?.configHash === stable.nginxRecovery.afterHash, 'STABLE_NGINX_HASH_MISMATCH');
      const record = createGenerationCleanup(s,
        { releaseId: old.stableReleaseId, slot: old.stable, configuration: old.stableConfiguration },
        { releaseId: stable.stableReleaseId, slot: stable.stable, configuration: stable.stableConfiguration }, observation, hash(JSON.stringify(s)), time(s.updatedAt));
      try {
        fault('cleanup_before_intent'); writeCleanup(record, true); stopReader(s).assertClear(); checkForwardDeadline(s, false);
      } catch { latch(lock); throw new Error('GENERATION_CLEANUP_UNCERTAIN'); }
      const receipt = Object.freeze({ mode: 'local-generation-model', executionAllowed: false });
      cleanupReceipts.set(receipt, { record, lock, configLock, finished: false }); return receipt;
    },
    checkGenerationCleanup(receipt, observation) {
      try { const { h, observedAt } = cleanupContext(receipt, observation); return checkGenerationCleanup(h.record, observation, observedAt); }
      catch { const h = cleanupReceipts.get(receipt); if (h && !h.finished) latch(h.lock); throw new Error('GENERATION_CLEANUP_REJECTED'); }
    },
    advanceGenerationCleanup(receipt, event, observation) {
      const h = cleanupReceipts.get(receipt); need(h && !h.finished, 'ORIGINAL_CLEANUP_RECEIPT_REQUIRED');
      try {
        const { s, observedAt } = cleanupContext(receipt, observation);
        const next = confirmGenerationCleanup(h.record, event, observation, observedAt);
        fault('cleanup_before_confirmation'); stopReader(s).assertClear(); checkForwardDeadline(s, false);
        writeCleanup(next, false); h.record = next;
        stopReader(s).assertClear(); checkForwardDeadline(s, false);
        if (next.phase === 'removed') {
          const done = path.join(root, `generation-done-${next.target.releaseId}.json`);
          need(!fs.existsSync(done), 'CLEANUP_ALREADY_FINISHED');
          fs.renameSync(path.join(root, 'generation-cleanup.json'), done); syncLocalDirectory(root);
          stopReader(s).assertClear(); checkForwardDeadline(s, false);
          need(readSnapshot(root).revision === s.revision, 'CLEANUP_FINAL_READBACK_FAILED'); h.finished = true;
          return { status: 'mock_removal_confirmed', executionAllowed: false, slotAvailable: true, port: next.target.slot.port };
        }
        return { status: 'mock_stop_confirmed', executionAllowed: false, slotAvailable: false };
      } catch { latch(h.lock); throw new Error('GENERATION_CLEANUP_UNCERTAIN'); }
    },
    markIncident(lock, reason) {
      assertLocalLock(lock, root); need(reason === 'INTEGRATION_OUTCOME_UNCERTAIN', 'INVALID_INCIDENT_REASON');
      // 時計を取得できない事故でも、日時を捏造せず事故ラッチを残す。
      try { writeExclusiveLocal(path.join(root, 'incident.json'), JSON.stringify({ reason })); syncLocalDirectory(root); }
      catch { retainLocalLock(lock); throw new Error('INCIDENT_RECORD_UNCERTAIN'); }
      return { status: 'incident_recorded', executionAllowed: false };
    },
    consume(lock, revision, releaseId) {
      const s = expected(lock, revision); stopReader(s).assertClear();
      need(['idle', 'committed'].includes(s.phase) && typeof releaseId === 'string' && idPattern.test(releaseId) && !s.consumedIds.includes(releaseId), 'RELEASE_REUSE_OR_INVALID_PHASE');
      // 模擬配信を予約した時点で消費。失敗してもIDを戻さない。本人承認を証明しない。
      return save(lock, { ...s, revision: s.revision + 1, updatedAt: time(s.updatedAt), phase: 'preparing', previous: s.stable, candidate: null,
        activeReleaseId: releaseId, consumedIds: [...s.consumedIds, releaseId], nginxRecovery: null,
        ...(s.schemaVersion === 3 ? { previousConfiguration: s.stableConfiguration, candidateConfiguration: null } : {}) }, releaseId);
    },
    saveCandidateConfiguration(lock, revision, candidate, receipt) {
      const s = expected(lock, revision); stopReader(s).assertClear();
      need(s.schemaVersion === 3 && s.phase === 'preparing' && s.candidate === null && s.candidateConfiguration === null, 'EXPLICIT_CONFIGURATION_STATE_REQUIRED');
      const saved = takeContainerConfiguration(receipt, candidate, s.activeReleaseId);
      return save(lock, { ...s, revision: s.revision + 1, updatedAt: time(s.updatedAt), candidate, candidateConfiguration: saved });
    },
    checkpoint(lock, revision, phase, candidate = null) {
      const s = expected(lock, revision);
      if (phase !== 'incident') stopReader(s).assertClear();
      need(!['switching', 'verifying', 'committing', 'committed', 'rolling_back'].includes(phase), 'RECORDED_NGINX_TRANSITION_REQUIRED');
      const edges = { preparing: ['candidate_starting', 'incident'], candidate_starting: ['candidate_checking', 'incident'], candidate_checking: ['candidate_ready', 'incident'],
        candidate_ready: ['switching', 'incident'], switching: ['verifying', 'rolling_back', 'incident'], verifying: ['committing', 'rolling_back', 'incident'],
        committing: ['committed', 'incident'], rolling_back: ['incident'] };
      need(edges[s.phase]?.includes(phase), 'INVALID_PERSISTENT_TRANSITION');
      const selected = candidate ?? s.candidate;
      if (selected !== null) {
        validateNextSlot(selected);
        need(selected.port === (s.previous.port === 3101 ? 3102 : 3101) && selected.container !== s.previous.container && selected.image.startsWith('ghcr.io/syucream02/siteflow@'), 'INVALID_PERSISTENT_CANDIDATE');
        need(s.candidate === null || sameSlot(selected, s.candidate), 'CANDIDATE_CHANGED');
      }
      const stable = phase === 'committed' ? selected : s.stable;
      return save(lock, { ...s, revision: s.revision + 1, updatedAt: time(s.updatedAt), phase, candidate: selected, stable, lastKnownGood: stable,
        incident: phase === 'incident' ? 'MANUAL_REVIEW_REQUIRED' : null }, null, phase === 'incident');
    },
    checkBeforeEffect(lock, operation) {
      need(['docker_pull', 'docker_create', 'docker_start', 'candidate_check', 'nginx_install', 'nginx_reload', 'public_check', 'commit'].includes(operation), 'INVALID_EFFECT_OPERATION');
      const s = read(lock); need(s.schemaVersion >= 2 && s.phase !== 'incident', 'INCIDENT_OR_LEGACY_STATE');
      stopReader(s).assertClear();
      return { status: 'fresh_local_stop_check_only', operation, executionAllowed: false };
    },
    prepareNginxRecovery(lock, configLock, revision, plan, backupBytes) {
      const s = expected(lock, revision); assertLocalConfigLock(configLock, root); stopReader(s).assertClear();
      need(s.phase === 'candidate_ready' && s.nginxRecovery === null && validReleaseId(s.stableReleaseId) &&
        plan?.mode === 'local-plan' && plan.executionAllowed === false && plan.phase === 'candidate_ready' &&
        sameSlot(plan.previous, s.stable) && sameSlot(plan.candidate, s.candidate) && plan.configPath === '/etc/nginx/conf.d/siteflow.conf', 'NGINX_PREPARATION_MISMATCH');
      need(backupBytes instanceof Uint8Array && backupBytes.length > 0 && backupBytes.length <= 65536, 'INVALID_NGINX_BACKUP_BYTES');
      const bytes = Buffer.from(backupBytes), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const from = `proxy_pass http://127.0.0.1:${s.stable.port};`, to = `proxy_pass http://127.0.0.1:${s.candidate.port};`;
      need(text.split(from).length === 2 && hash(bytes) === plan.expectedHash && hash(text.replace(from, to)) === plan.nextHash, 'NGINX_BACKUP_HASH_MISMATCH');
      const recovery = { version: 1, releaseId: s.activeReleaseId, previousReleaseId: s.stableReleaseId, previous: s.stable, candidate: s.candidate,
        configPath: plan.configPath, beforeHash: plan.expectedHash, afterHash: plan.nextHash, backupFile: `nginx-backup-${s.activeReleaseId}.json`, backupBytes: bytes.length, planPhase: plan.phase, operation: 'prepared' };
      let saved;
      try {
        fault('before_backup_write');
        writeExclusiveLocal(path.join(root, recovery.backupFile), JSON.stringify({ version: 1, workspaceId: s.workspaceId, releaseId: s.activeReleaseId, base64: bytes.toString('base64') }));
        syncLocalDirectory(root); fault('after_backup_write');
        saved = save(lock, { ...s, revision: s.revision + 1, updatedAt: time(s.updatedAt), nginxRecovery: recovery });
        verifyBackup(root, read(lock));
      } catch { latch(lock); throw new Error('NGINX_PREPARATION_UNCERTAIN'); }
      let latestRevision = saved.revision;
      const receipt = Object.freeze({ mode: 'local-test-only', executionAllowed: false });
      function fresh(planToCheck) {
        assertLocalConfigLock(configLock, root);
        const current = read(lock), r = current.nginxRecovery;
        need(current.revision === latestRevision && r && r.releaseId === recovery.releaseId && r.planPhase === planToCheck.phase &&
          r.beforeHash === planToCheck.expectedHash && r.afterHash === planToCheck.nextHash && r.configPath === planToCheck.configPath &&
          sameSlot(r.previous, planToCheck.previous) && sameSlot(r.candidate, planToCheck.candidate), 'STALE_OR_DIFFERENT_NGINX_PLAN');
        return current;
      }
      receipts.set(receipt, {
        read(p) { const current = fresh(p); return { stop: stopReader(current).read(), executionAllowed: false }; },
        record(p, event, next) {
          let current = fresh(p);
          validateRecordedEdge(p, event, next);
          const rollback = p.phase.startsWith('rollback') || p.phase === 'rolling_back';
          fault('nginx_before_record');
          const stop = stopReader(current).read();
          if (!rollback && stop.status !== 'clear' && !['rolling_back', 'incident'].includes(next.phase)) {
            next = { ...next, phase: 'incident', requiredAction: 'manual_review', reason: 'STOP_BEFORE_RECORD' };
          }
          need(nginxPhases.includes(next.phase) && next.executionAllowed === false && sameSlot(next.previous, recovery.previous) &&
            sameSlot(next.candidate, recovery.candidate) && next.expectedHash === recovery.beforeHash && next.nextHash === recovery.afterHash, 'INVALID_RECORDED_NGINX_RESULT');
          const incident = ['rolling_back', 'rollback_validating', 'rollback_reloading', 'rollback_verifying', 'incident'].includes(next.phase);
          const phase = incident ? 'incident' : next.phase === 'committed' ? 'committed' : next.phase === 'commit_pending' ? 'committing' :
            next.phase === 'verifying' ? 'verifying' : ['install_pending', 'installed', 'reload_pending'].includes(next.phase) ? 'switching' : 'candidate_ready';
          const updated = { ...current, revision: current.revision + 1, updatedAt: time(current.updatedAt), phase,
            stable: phase === 'committed' ? current.candidate : current.stable, lastKnownGood: phase === 'committed' ? current.candidate : current.stable,
            stableReleaseId: phase === 'committed' ? current.activeReleaseId : current.stableReleaseId,
            ...(current.schemaVersion === 3 ? { stableConfiguration: phase === 'committed' ? current.candidateConfiguration : current.stableConfiguration } : {}),
            nginxRecovery: { ...current.nginxRecovery, planPhase: next.phase, operation: stop.status !== 'clear' && !rollback ? 'stop_observed' : event.type },
            incident: incident ? 'NGINX_RECOVERY_REQUIRES_REVIEW' : null };
          save(lock, updated, null, incident || rollback);
          current = read(lock); need(current.revision === updated.revision, 'NGINX_RECORD_READBACK_FAILED');
          latestRevision = current.revision;
          return next;
        },
      });
      return receipt;
    },
  });
}
