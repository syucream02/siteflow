import path from 'node:path';
import { exactFields, need } from './contract.mjs';

// 第6段階: Linuxコマンド/ファイル操作なし。すべて呼び出し元の模擬観測。
// UUID/serial一致は暗号化の証明ではない。encryptedのAWS由来確認も実機では別途必要。
export function assertLinuxPath(value) {
  need(typeof value === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(value) && value !== '/' &&
    path.posix.normalize(value) === value && !value.endsWith('/') &&
    !value.split('/').some(p => p === '.' || p === '..'), 'UNSAFE_LINUX_PATH');
  return value;
}
export const beneath = (value, parent) => value.startsWith(`${parent}/`);
export function pathChain(target) {
  assertLinuxPath(target);
  const parts = target.split('/').filter(Boolean);
  return ['/', ...parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];
}
export function validateStoragePolicy(p) {
  exactFields(p, ['mount', 'uuid', 'volumeId', 'stateDirectory', 'mysqlDataDirectory', 'minFreeBytes'], 'INVALID_STORAGE_POLICY');
  need(p.mount === '/srv/siteflow-mysql' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.uuid) &&
    /^vol-[a-f0-9]{17}$/.test(p.volumeId), 'UNSET_STORAGE_IDENTITY');
  assertLinuxPath(p.stateDirectory); assertLinuxPath(p.mysqlDataDirectory);
  need(beneath(p.stateDirectory, p.mount) && beneath(p.mysqlDataDirectory, p.mount) &&
    p.stateDirectory !== p.mysqlDataDirectory && !beneath(p.stateDirectory, p.mysqlDataDirectory) &&
    !beneath(p.mysqlDataDirectory, p.stateDirectory), 'CD_MYSQL_PATH_COLLISION');
  need(Number.isSafeInteger(p.minFreeBytes) && p.minFreeBytes >= 256 * 1024 * 1024, 'UNSAFE_STORAGE_RESERVE');
}
export function validateRootChain(target, entries, terminalMode = 0o700) {
  const required = pathChain(target);
  need(Array.isArray(entries) && entries.length === required.length, 'INCOMPLETE_PATH_CHAIN');
  for (let i = 0; i < required.length; i++) {
    const e = entries[i];
    exactFields(e, ['path', 'realPath', 'type', 'uid', 'gid', 'mode', 'symlink', 'deviceId'], 'INVALID_PATH_METADATA');
    need(e.path === required[i] && e.realPath === e.path && e.type === 'directory' && e.symlink === false &&
      e.uid === 0 && e.gid === 0 && Number.isInteger(e.mode) && e.mode >= 0 && e.mode <= 0o777 &&
      (e.mode & 0o022) === 0 && Number.isSafeInteger(e.deviceId) && e.deviceId > 0, 'UNSAFE_ROOT_PATH_CHAIN');
    if (i === required.length - 1) need(e.mode === terminalMode, 'UNSAFE_TERMINAL_MODE');
  }
}
export function assessLinuxStorage(policy, observation) {
  validateStoragePolicy(policy);
  exactFields(observation, ['querySucceeded', 'mount', 'entries', 'mysqlDataRealPath', 'freeBytes', 'freeInodes', 'writeProbeSucceeded'], 'INVALID_STORAGE_OBSERVATION');
  need(observation.querySucceeded === true, 'STORAGE_QUERY_FAILED');
  const m = observation.mount;
  exactFields(m, ['target', 'realPath', 'source', 'uuid', 'volumeId', 'fstype', 'options', 'deviceId', 'mounted', 'encrypted'], 'INVALID_MOUNT_OBSERVATION');
  need(m.mounted === true && m.target === policy.mount && m.realPath === policy.mount && m.fstype === 'xfs' &&
    /^\/dev\/nvme[0-9]+n[0-9]+$/.test(m.source) && m.uuid === policy.uuid && m.volumeId === policy.volumeId &&
    m.encrypted === true && Array.isArray(m.options) && m.options.includes('rw') && !m.options.includes('ro') &&
    Number.isSafeInteger(m.deviceId) && m.deviceId > 0, 'MOUNT_IDENTITY_OR_ENCRYPTION_MISMATCH');
  validateRootChain(policy.stateDirectory, observation.entries);
  need(m.deviceId !== observation.entries[0].deviceId, 'ROOT_FILESYSTEM_FALLBACK');
  need(observation.entries.filter(e => e.path === policy.mount || beneath(e.path, policy.mount)).every(e => e.deviceId === m.deviceId), 'STATE_ON_DIFFERENT_FILESYSTEM');
  need(observation.mysqlDataRealPath === policy.mysqlDataDirectory, 'MYSQL_DATA_PATH_UNCERTAIN');
  need(Number.isSafeInteger(observation.freeBytes) && observation.freeBytes >= policy.minFreeBytes &&
    Number.isSafeInteger(observation.freeInodes) && observation.freeInodes >= 128 && observation.writeProbeSucceeded === true, 'STORAGE_READ_ONLY_OR_FULL');
  return { status: 'mock_storage_consistent', executionAllowed: false, stateDirectory: policy.stateDirectory,
    pendingChecks: ['actual_findmnt_nvme_identity', 'aws_encryption_attribute', 'lstat_open_no_follow_race', 'linux_fsync_and_powerloss'] };
}
