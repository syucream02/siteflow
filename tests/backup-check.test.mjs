import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backupRunSettings, restoreTarget, backupFingerprint, verifyBackup, isLocalDockerEndpoint } from '../examples/mysql/backup-check-settings.mjs';

test('Dockerの接続はPC内のソケットに限り、TCPやSSHのリモート環境を拒否する', () => {
  assert.equal(isLocalDockerEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine', 'win32'), true);
  assert.equal(isLocalDockerEndpoint('unix:///var/run/docker.sock', 'linux'), true);
  for (const endpoint of ['ssh://ec2-user@example.invalid', 'tcp://127.0.0.1:2375', 'npipe:////remote/pipe/docker', undefined]) {
    assert.equal(isLocalDockerEndpoint(endpoint, 'win32'), false);
    assert.equal(isLocalDockerEndpoint(endpoint, 'linux'), false);
  }
});

const env = { SITEFLOW_BACKUP_CHECK: '1', SITEFLOW_BACKUP_TAG: '1234567890abcdef', SITEFLOW_BACKUP_PASSWORD: 'a'.repeat(48), SITEFLOW_BACKUP_PORT: '3307' };
test('一時DB名は実行タグから生成し、既存DB名や接続URLを受け取らない', () => {
  const settings = backupRunSettings(env, 3307);
  assert.notEqual(settings.source, settings.restore);
  assert.equal(restoreTarget(settings, settings.restore), settings.restore);
  for (const target of [settings.source, 'mysql', 'siteflow', 'siteflow_check_existing_12345678', settings.restore + ';DROP DATABASE mysql', settings.restore.replace('1234', '5678')]) assert.throws(() => restoreTarget(settings, target));
});
test('明示フラグ・タグ・秘密値・ローカルポートが不正なら処理前に拒否する', () => {
  for (const changes of [{ SITEFLOW_BACKUP_CHECK: undefined }, { SITEFLOW_BACKUP_TAG: '../source' },
    { SITEFLOW_BACKUP_TAG: 'A'.repeat(16) }, { SITEFLOW_BACKUP_PASSWORD: 'short' },
    { SITEFLOW_BACKUP_PORT: '3306' }, { SITEFLOW_BACKUP_PORT: '0' }]) assert.throws(() => backupRunSettings({ ...env, ...changes }, 3307));
});
test('保存後の内容変更・欠落・空ファイルを復元前に検出する', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'siteflow-backup-test-'));
  const file = path.join(directory, 'backup.sql');
  try {
    await writeFile(file, 'SELECT 1;\n');
    const fingerprint = await backupFingerprint(file);
    await verifyBackup(file, fingerprint);
    await writeFile(file, 'SELECT 2;\n');
    await assert.rejects(verifyBackup(file, fingerprint), /CHECKSUM_MISMATCH/);
    await writeFile(file, '');
    await assert.rejects(verifyBackup(file, fingerprint), /INVALID_BACKUP_FILE/);
    await assert.rejects(verifyBackup(path.join(directory, 'missing.sql'), fingerprint));
  } finally {
    // このテストで生成したファイルだけを削除し、再帰削除は使わない。
    await rm(file, { force: true }); await rmdir(directory);
  }
});
