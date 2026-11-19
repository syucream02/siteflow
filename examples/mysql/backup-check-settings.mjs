import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';

export function isLocalDockerEndpoint(endpoint, platform) {
  return platform === 'win32'
    ? /^npipe:\/+\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint ?? '')
    : /^unix:\/\/\/[^\0\r\n]+$/.test(endpoint ?? '');
}

// 任意のDB名・接続先を受け付けない。復元試験の一時DB専用。
export function backupRunSettings(env, localPort) {
  const tag = env.SITEFLOW_BACKUP_TAG;
  const password = env.SITEFLOW_BACKUP_PASSWORD;
  const port = Number(env.SITEFLOW_BACKUP_PORT);
  if (env.SITEFLOW_BACKUP_CHECK !== '1' || !/^[a-f0-9]{16}$/.test(tag ?? '')
    || !/^[a-f0-9]{48}$/.test(password ?? '') || !Number.isInteger(port)
    || port < 1 || port > 65535 || port !== localPort) throw new Error('INVALID_BACKUP_CHECK_SETTINGS');
  return { source: `siteflow_backup_check_${tag}_source`, restore: `siteflow_backup_check_${tag}_restore`,
    user: `sfbackup_${tag}`, password, port };
}

export function restoreTarget(settings, target) {
  if (!/^siteflow_backup_check_[a-f0-9]{16}_restore$/.test(target)
    || target !== settings.restore || target === settings.source) throw new Error('INVALID_RESTORE_TARGET');
  return target;
}

export async function backupFingerprint(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('INVALID_BACKUP_FILE');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { bytes: info.size, sha256: hash.digest('hex') };
}

// ハッシュは今回生成したものと照合する。改ざんに対する署名や暗号化の代用ではない。
export async function verifyBackup(file, expected) {
  const actual = await backupFingerprint(file);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error('BACKUP_CHECKSUM_MISMATCH');
}
