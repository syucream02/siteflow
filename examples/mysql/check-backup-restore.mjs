import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/integrated/client.ts';
import { readDevelopmentSettings } from './schema-check-settings.mjs';
import { startMeetingForUser, actOnMeetingForUser } from './meeting-service.ts';
import { backupRunSettings, restoreTarget, backupFingerprint, verifyBackup, isLocalDockerEndpoint } from './backup-check-settings.mjs';
import { createLocalWorkspaceData } from './local-workspace-data.ts';
import { updateProjectProgressForUser, changeProjectAssigneesForUser } from './project-service.ts';
import { changeProjectArchiveForUser } from './project-archive-service.ts';
import { startApiServer } from './api-server.ts';

// 任意の既存DBをバックアップ/上書きするツールではなく、使い捨てDBでの復元訓練。
const root = fileURLToPath(new URL('../../', import.meta.url));
const cwd = fileURLToPath(new URL('./', import.meta.url));
const development = readDevelopmentSettings();
const env = { ...process.env, SITEFLOW_BACKUP_CHECK: '1', SITEFLOW_BACKUP_TAG: randomBytes(8).toString('hex'), SITEFLOW_BACKUP_PASSWORD: randomBytes(24).toString('hex'), SITEFLOW_BACKUP_PORT: development.MYSQL_PORT ?? '3307' };
const settings = backupRunSettings(env, Number(development.MYSQL_PORT ?? '3307'));
const docker = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DockerDesktop/resources/bin/docker.exe') : 'docker';
execFileSync('git', ['check-ignore', '--quiet', '--', 'work/backup-restore/'], { cwd: root, stdio: 'pipe', windowsHide: true });
const output = path.join(root, 'work/backup-restore'); fs.mkdirSync(output, { recursive: true });
const dumpFile = path.join(output, `${env.SITEFLOW_BACKUP_TAG}.sql`);
const damagedFile = path.join(output, `${env.SITEFLOW_BACKUP_TAG}-damaged.sql`);
const checks = [], durations = {};
let container, source, restored, sourceApi, restoredApi, data;
let sourceCreated = false, restoreCreated = false, userCreated = false, phase = 'docker', failed = false;
let report = {};
const tool = args => execFileSync(docker, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30000 });
const mysqlArgs = database => ['exec', '-i', container, 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --protocol=socket --user=root --batch --skip-column-names "$@"', '--', ...(database ? [database] : [])];
function rootSql(sql) {
  return execFileSync(docker, mysqlArgs(), { cwd: root, input: sql, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30000 }).trim();
}
function connect(database) {
  return new PrismaClient({ adapter: new PrismaMariaDb({ host: '127.0.0.1', port: settings.port, database, user: settings.user, password: settings.password, connectionLimit: 2, connectTimeout: 5000, acquireTimeout: 5000 }) });
}
function migrate(stage) {
  execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--config', 'prisma-backup-check.config.ts'], {
    cwd, env: { ...env, SITEFLOW_BACKUP_STAGE: stage }, stdio: 'pipe', windowsHide: true, timeout: 60000,
  });
}
async function mysqlIO(args, input, outputStream) {
  const child = spawn(docker, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // SQLエラーには入力が含まれることがあるので、本文をログに出さない。
  child.stderr.resume();
  const exited = new Promise((resolve, reject) => { child.once('error', () => reject(new Error('MYSQL_TOOL_FAILED'))); child.once('close', code => code === 0 ? resolve() : reject(new Error('MYSQL_TOOL_FAILED'))); });
  const writing = input ? pipeline(input, child.stdin) : Promise.resolve(child.stdin.end());
  const reading = outputStream ? pipeline(child.stdout, outputStream) : Promise.resolve(child.stdout.resume());
  try { await Promise.all([exited, writing, reading]); }
  catch { child.kill(); await exited.catch(() => {}); throw new Error('MYSQL_TOOL_FAILED'); }
}
async function snapshot(client) {
  const names = await client.$queryRaw`SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name`;
  const tables = [];
  for (const { name } of names) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('INVALID_TABLE_NAME');
    const rows = await client.$queryRawUnsafe(`SELECT * FROM \`${name}\``);
    const sorted = rows.map(row => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? value.toString() : value)).sort();
    tables.push({ table: name, rows: rows.length, digest: createHash('sha256').update(sorted.join('\n')).digest('hex') });
  }
  return tables;
}
async function restore(file, expected, target) {
  restoreTarget(settings, target);
  await verifyBackup(file, expected);
  const [{ currentDatabase }] = await restored.$queryRaw`SELECT DATABASE() AS currentDatabase`;
  assert.equal(currentDatabase, target);
  if ((await snapshot(restored)).length !== 0) throw new Error('RESTORE_TARGET_NOT_EMPTY');
  await mysqlIO(mysqlArgs(target), fs.createReadStream(file));
}
async function login(api) {
  const response = await fetch(api.origin + '/api/auth/sign-in/email', { method: 'POST', headers: { Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: data.email, password: data.password }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().find(value => value.includes('session_token='));
  assert.ok(cookie); return cookie.split(';')[0];
}
try {
  const endpoint = tool(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).trim();
  if (!isLocalDockerEndpoint(endpoint, process.platform)
    || (process.env.DOCKER_HOST && !isLocalDockerEndpoint(process.env.DOCKER_HOST, process.platform))) throw new Error('REMOTE_DOCKER_NOT_ALLOWED');
  container = tool(['compose', '--env-file', path.join(root, '.env.mysql.local'), '-f', path.join(root, 'compose.dev.yaml'), 'ps', '-q', 'mysql']).trim();
  if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('LOCAL_MYSQL_NOT_RUNNING');
  const existing = rootSql(`SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name IN ('${settings.source}','${settings.restore}');`);
  if (existing !== '0') throw new Error('DATABASE_ALREADY_EXISTS');
  phase = 'prepare-disposable-databases';
  rootSql(`CREATE DATABASE \`${settings.source}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`); sourceCreated = true;
  rootSql(`CREATE DATABASE \`${settings.restore}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`); restoreCreated = true;
  rootSql(`CREATE USER '${settings.user}'@'%' IDENTIFIED BY '${settings.password}';`); userCreated = true;
  rootSql([settings.source, settings.restore].map(database => `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON \`${database}\`.* TO '${settings.user}'@'%';`).join('\n'));
  migrate('source'); source = connect(settings.source); restored = connect(settings.restore);
  phase = 'fixture';
  data = await createLocalWorkspaceData(source);
  const teamId = data.teamIds[0], projectId = data.projectIds[0];
  const other = await source.user.create({ data: { id: randomUUID(), name: '架空の引継先', email: `${randomUUID()}@example.invalid`, emailVerified: true } });
  await source.teamMembership.create({ data: { id: randomUUID(), teamId, userId: other.id, role: 'member', createdAt: new Date() } });
  await source.teamMembership.update({ where: { teamId_userId: { teamId: data.teamIds[1], userId: data.userId } }, data: { role: 'member' } });
  const otherTeamParticipant = await source.teamParticipant.create({ data: { id: randomUUID(), teamId: data.teamIds[1], userId: data.userId } });
  assert.equal((await updateProjectProgressForUser(source, data.userId, teamId, projectId, { expectedVersion: 1, progress: 40, comment: '架空の復元確認' })).ok, true);
  assert.equal((await changeProjectAssigneesForUser(source, data.userId, teamId, projectId, { expectedVersion: 2, primaryUserId: other.id, supportUserIds: [data.userId] })).ok, true);
  assert.equal((await changeProjectArchiveForUser(source, data.userId, teamId, projectId, { expectedVersion: 3, archived: true })).ok, true);
  const meeting = await startMeetingForUser(source, data.userId, teamId, null); assert.equal(meeting.ok, true);
  const entry = await source.meetingProject.findFirstOrThrow({ where: { meetingId: meeting.meeting.id } });
  for (const [index, action] of ['confirm', 'unconfirm', 'confirm'].entries()) {
    assert.equal((await actOnMeetingForUser(source, data.userId, teamId, meeting.meeting.id, { action, expectedVersion: index + 1, entryId: entry.id })).ok, true);
  }
  assert.equal((await actOnMeetingForUser(source, data.userId, teamId, meeting.meeting.id, { action: 'finish', expectedVersion: 4, allowUnconfirmed: true })).ok, true);
  const authSecret = randomBytes(32).toString('hex');
  sourceApi = await startApiServer({ prisma: source, authSecret, secureCookies: false, port: 0 });
  const oldCookie = await login(sourceApi);
  await sourceApi.close(); sourceApi = undefined;
  const before = await snapshot(source);
  assert.ok(before.find(row => row.table === '_prisma_migrations' && row.rows > 0));
  assert.ok(before.find(row => row.table === 'session' && row.rows > 0));
  assert.equal(before.find(row => row.table === 'MeetingConfirmation').rows, 2);

  phase = 'dump'; let started = performance.now();
  const dumpArgs = ['exec', '-i', container, 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump "$@"', '--',
    '--protocol=socket', '--user=root', '--single-transaction', '--quick', '--no-tablespaces', '--set-gtid-purged=OFF', '--column-statistics=0', '--hex-blob', '--skip-add-drop-table', '--default-character-set=utf8mb4', settings.source];
  await mysqlIO(dumpArgs, undefined, fs.createWriteStream(dumpFile, { flags: 'wx', mode: 0o600 }));
  const fingerprint = await backupFingerprint(dumpFile); durations.backupMs = Math.round(performance.now() - started);
  phase = 'reject-corrupt-backup';
  fs.copyFileSync(dumpFile, damagedFile); fs.appendFileSync(damagedFile, '\n-- damaged\n');
  await assert.rejects(restore(damagedFile, fingerprint, settings.restore), /CHECKSUM_MISMATCH/);
  assert.equal((await snapshot(restored)).length, 0);
  await assert.rejects(restore(dumpFile, fingerprint, settings.source), /INVALID_RESTORE_TARGET/);
  checks.push('破損ファイル・元DBへの復元を拒否し、復元先を変更しない');

  phase = 'restore'; started = performance.now();
  await restore(dumpFile, fingerprint, settings.restore);
  const after = await snapshot(restored);
  assert.deepEqual(after, before); durations.restoreAndCompareMs = Math.round(performance.now() - started);
  await assert.rejects(restore(dumpFile, fingerprint, settings.restore), /RESTORE_TARGET_NOT_EMPTY/);
  assert.deepEqual(await snapshot(restored), before);
  checks.push('全テーブルの件数・全行の内容・認証情報・所属・担当/進捗履歴・保管状態が一致');
  checks.push('既存テーブルがある復元先への上書きを拒否し、データを保持');
  phase = 'migration-history'; migrate('restore'); assert.deepEqual(await snapshot(restored), before);
  checks.push('Prismaの適用履歴を復元し、migrate deploy再実行で内容が変わらない');

  phase = 'constraints';
  await assert.rejects(restored.teamMembership.create({ data: { id: randomUUID(), teamId, userId: data.userId, role: 'member', createdAt: new Date() } }), error => error.code === 'P2002');
  await assert.rejects(restored.project.update({ where: { id: projectId }, data: { primaryParticipantId: otherTeamParticipant.id } }), error => error.code === 'P2003');
  const saved = await restored.project.findUniqueOrThrow({ where: { id: data.projectIds[1] } });
  await assert.rejects(restored.$transaction(async tx => { await tx.project.update({ where: { id: saved.id }, data: { progress: 99 } }); throw new Error('RESTORE_CHECK_ABORT'); }), /RESTORE_CHECK_ABORT/);
  assert.deepEqual(await restored.project.findUniqueOrThrow({ where: { id: saved.id } }), saved);
  checks.push('復元後も重複所属・別チーム参照を拒否し、途中失敗の更新を取り消す');

  phase = 'restored-auth-and-api';
  restoredApi = await startApiServer({ prisma: restored, authSecret, secureCookies: false, port: 0 });
  const call = (suffix, options = {}) => fetch(restoredApi.origin + '/api/' + suffix, { ...options, headers: { Cookie: oldCookie, ...options.headers } });
  assert.equal((await (await call('auth/get-session')).json()).user.id, data.userId);
  await restored.session.deleteMany();
  assert.equal(await (await call('auth/get-session')).json(), null);
  const cookie = await login(restoredApi);
  assert.equal((await call(`teams/${teamId}/projects/${saved.id}`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await call(`teams/${randomUUID()}/projects`, { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await call(`teams/${teamId}/projects/${saved.id}`, { method: 'PATCH', headers: { Cookie: cookie, Origin: restoredApi.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: saved.version, name: '復元後の架空更新' }) })).status, 200);
  checks.push('復元したセッションの無効化・再ログイン・案件取得/保存・チーム境界をHTTPで確認');
  await restored.teamMembership.update({ where: { teamId_userId: { teamId, userId: data.userId } }, data: { role: 'member' } });
  const archivedBefore = await restored.project.findUniqueOrThrow({ where: { id: projectId } });
  const archivedDetail = await (await call(`teams/${teamId}/archived-projects/${projectId}`, { headers: { Cookie: cookie } })).json();
  assert.equal(archivedDetail.project.canArchive, false);
  for (const action of ['archive', 'restore']) {
    const body = action === 'restore' ? { expectedVersion: archivedBefore.version, primaryUserId: data.userId, supportUserIds: [] } : { expectedVersion: archivedBefore.version };
    assert.equal((await call(`teams/${teamId}/projects/${projectId}/${action}`, { method: 'POST', headers: { Cookie: cookie, Origin: restoredApi.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
  }
  assert.deepEqual(await restored.project.findUniqueOrThrow({ where: { id: projectId } }), archivedBefore);
  checks.push('復元後も副担当の保管/復元と自己昇格を拒否し、案件を変更しない');
  phase = 'source-unchanged'; assert.deepEqual(await snapshot(source), before);
  checks.push('復元試験と復元先の更新が、バックアップ元の全行を変更していない');
  const [{ version }] = await restored.$queryRaw`SELECT VERSION() AS version`;
  report = { status: 'passed', mysqlVersion: version, fixtureProjects: data.projectIds.length, backupBytes: fingerprint.bytes, tables: before.map(({ table, rows }) => ({ table, rows })), durations, checks };
} catch (error) {
  failed = true; report = { status: 'failed', phase, code: error?.code ?? error?.name ?? 'CHECK_FAILED' };
} finally {
  const cleanupFailures = [];
  const cleanups = [
    ['source-api', () => sourceApi?.close()], ['restore-api', () => restoredApi?.close()],
    ['source-client', () => source?.$disconnect()], ['restore-client', () => restored?.$disconnect()],
    // この実行で作成に成功した、一意な名前のDB/ユーザーだけを片付ける。
    ['restore-database', () => { if (restoreCreated) rootSql(`DROP DATABASE \`${restoreTarget(settings, settings.restore)}\`;`); }],
    ['source-database', () => { if (sourceCreated) rootSql(`DROP DATABASE \`${settings.source}\`;`); }],
    ['database-user', () => { if (userCreated) rootSql(`DROP USER '${settings.user}'@'%';`); }],
    ...[dumpFile, damagedFile].map((file, index) => [`temporary-file-${index}`, () => {
      if (path.dirname(path.resolve(file)) !== path.resolve(output)) throw new Error('INVALID_CLEANUP_PATH');
      fs.rmSync(file, { force: true });
    }]),
    ['cleanup-verification', () => {
      for (const database of [sourceCreated ? settings.source : null, restoreCreated ? settings.restore : null].filter(Boolean)) assert.equal(rootSql(`SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${database}';`), '0');
      if (userCreated) assert.equal(rootSql(`SELECT COUNT(*) FROM mysql.user WHERE User='${settings.user}';`), '0');
      assert.ok(!fs.existsSync(dumpFile) && !fs.existsSync(damagedFile));
    }],
  ];
  for (const [name, cleanup] of cleanups) { try { await cleanup(); } catch { cleanupFailures.push(name); } }
  report.cleanup = cleanupFailures.length ? 'failed' : 'completed';
  if (cleanupFailures.length) { failed = true; report.status = 'failed'; report.cleanupFailures = cleanupFailures; }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.info(JSON.stringify({ ...report, tables: report.tables?.length }));
  if (failed) process.exitCode = 1;
}
