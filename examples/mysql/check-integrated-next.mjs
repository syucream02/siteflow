import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/integrated/client.ts';
import { readSchemaCheckSettings } from './schema-check-settings.mjs';
import { createLocalWorkspaceData, removeLocalWorkspaceData } from './local-workspace-data.ts';

// 検証用DBと一時データだけを使う。別APIサーバーは起動しない。
const root = fileURLToPath(new URL('../../', import.meta.url));
let base;
const output = path.join(root, 'work/integrated-next'); fs.mkdirSync(output, { recursive: true });
const settings = readSchemaCheckSettings();
const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ host: '127.0.0.1', port: settings.port, database: settings.database, user: settings.user, password: settings.password, connectionLimit: 2 }) });
const log = fs.openSync(path.join(output, 'next.log'), 'w');
let child, data, extraUser, cookie = '', phase = 'setup';
const checks = [];
const call = (suffix, options = {}) => fetch(base + '/api/siteflow/' + suffix, {
  ...options, headers: { Cookie: cookie, ...(options.method && options.method !== 'GET' ? { Origin: base, 'Content-Type': 'application/json' } : {}), ...options.headers },
});
const post = (suffix, body) => call(suffix, { method: 'POST', body: JSON.stringify(body) });
try {
  // 他の開発サーバーを停止せず、ポートが使われていれば検証を中断する。
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port; base = `http://127.0.0.1:${port}`;
  await new Promise(resolve => probe.close(resolve));
  phase = 'fixtures'; data = await createLocalWorkspaceData(prisma);
  fs.writeFileSync(path.join(root, 'work/integrated-tsconfig.json'), JSON.stringify({ extends: '../tsconfig.json', include: ['../app/**/*.ts', '../app/**/*.tsx', '../components/**/*.tsx', '../lib/**/*.ts', '../next-env.d.ts'] }));
  phase = 'next-start';
  child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: root, env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', SITEFLOW_LOCAL_CHECK: '1', SITEFLOW_WORKSPACE_MODE: 'integrated', SITEFLOW_INTEGRATED_ORIGIN: base, SITEFLOW_LOCAL_API_ORIGIN: 'http://127.0.0.1:1' },
    windowsHide: true, stdio: ['ignore', log, log],
  });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw Error('NEXT_START_FAILED');
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* 起動待ち */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  phase = 'login';
  const login = await post('auth/sign-in/email', { email: data.email, password: data.password });
  assert.equal(login.status, 200); assert.deepEqual(await login.json(), { ok: true });
  const sessionCookie = login.headers.getSetCookie().find(value => value.includes('session_token='));
  assert.ok(sessionCookie); assert.match(sessionCookie, /HttpOnly/i); cookie = sessionCookie.split(';')[0];
  const session = await (await call('auth/get-session')).json();
  assert.equal(session.user.id, data.userId); assert.equal('session' in session, false);
  checks.push('Next.js単独でログイン・HttpOnly Cookie・トークン非公開');

  phase = 'create-edit-conflict';
  const teamId = data.teamIds[0], collection = `teams/${teamId}/projects`;
  const response = await post(collection, { name: '統合検証の架空案件', dueDate: '2026-12-31', primaryUserId: data.userId });
  assert.equal(response.status, 201); const projectId = (await response.json()).project.id;
  assert.equal(response.headers.get('location'), `/api/siteflow/${collection}/${projectId}`);
  const detail = `${collection}/${projectId}`;
  const edit = name => call(detail, { method: 'PATCH', body: JSON.stringify({ expectedVersion: 1, name }) });
  const simultaneous = await Promise.all([edit('架空の変更A'), edit('架空の変更B')]);
  assert.deepEqual(simultaneous.map(r => r.status).sort(), [200, 409]);
  let project = (await (await call(detail)).json()).project;
  assert.equal(project.version, 2); assert.equal(project.canArchive, true);
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).name, project.name);
  checks.push('案件登録・実DB保存・再取得・同時編集の409');

  phase = 'permissions';
  extraUser = crypto.randomUUID();
  await prisma.user.create({ data: { id: extraUser, name: '架空の別担当', email: `${extraUser}@example.invalid`, emailVerified: true } });
  await prisma.teamMembership.create({ data: { id: crypto.randomUUID(), teamId, userId: extraUser, role: 'member', createdAt: new Date() } });
  const memberWhere = { teamId_userId: { teamId, userId: data.userId } };
  await prisma.teamMembership.update({ where: memberWhere, data: { role: 'member' } });
  assert.equal((await call(detail + '/assignees', { method: 'PUT', body: JSON.stringify({ expectedVersion: 2, primaryUserId: extraUser, supportUserIds: [data.userId] }) })).status, 200);
  project = (await (await call(detail)).json()).project;
  assert.equal(project.canArchive, false); assert.equal((await post(detail + '/archive', { expectedVersion: 3 })).status, 403);
  const deniedBefore = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(deniedBefore.archivedAt, null); assert.equal(deniedBefore.version, 3);
  await prisma.teamMembership.update({ where: memberWhere, data: { role: 'admin' } });
  assert.equal((await post(detail + '/archive', { expectedVersion: 3 })).status, 200);
  await prisma.teamMembership.update({ where: memberWhere, data: { role: 'member' } });
  assert.equal((await post(detail + '/restore', { expectedVersion: 4, primaryUserId: data.userId, supportUserIds: [] })).status, 403);
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).version, 4);
  await prisma.teamMembership.update({ where: memberWhere, data: { role: 'admin' } });
  assert.equal((await post(detail + '/restore', { expectedVersion: 4 })).status, 200);
  await prisma.teamMembership.update({ where: memberWhere, data: { role: 'member' } });
  const own = `${collection}/${data.projectIds[0]}`;
  assert.equal((await post(own + '/archive', { expectedVersion: 1 })).status, 200);
  assert.equal((await post(own + '/restore', { expectedVersion: 2 })).status, 200);
  checks.push('管理者・主担当は保管と復元可、副担当は403・自己昇格も拒否・データ不変');

  phase = 'boundaries';
  assert.equal((await call(`teams/${crypto.randomUUID()}/projects`)).status, 403);
  assert.equal((await call('teams', { headers: { Cookie: '' } })).status, 401);
  assert.equal((await call('teams', { headers: { Origin: 'https://example.invalid' } })).status, 403);
  // fetchはHostを接続先へ補正するため、生のHTTPで偽装Hostを検証する。
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(base + '/api/siteflow/teams', { headers: { Cookie: cookie, Host: 'example.invalid', 'x-forwarded-host': new URL(base).host } }, response => { response.resume(); resolve(response.statusCode); });
    outgoing.once('error', reject); outgoing.end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await call('auth/sign-in/email', { method: 'POST', body: ' '.repeat(4097) })).status, 413);
  assert.equal((await call('auth/sign-in/email', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await call('auth/sign-up/email', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(base + '/workspace')).status, 200);
  assert.equal((await fetch(base + '/')).status, 200);
  checks.push('チーム境界・未認証・Host/Origin・本文上限・自由登録停止・両画面のHTTP応答');
  assert.equal((await post('auth/sign-out', {})).status, 200);
  assert.equal(await (await call('auth/get-session')).json(), null);
  checks.push('ログアウト後は旧Cookieでセッションを取得できない');

  if (process.argv.includes('--browser')) {
    phase = 'browser';
    const browserLog = fs.openSync(path.join(output, 'browser.log'), 'w');
    try {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'check-workspace-browser.mjs'], { cwd: fileURLToPath(new URL('./', import.meta.url)), env: { ...process.env, SITEFLOW_BROWSER_ORIGIN: base }, windowsHide: true, stdio: ['ignore', browserLog, browserLog] });
      assert.equal(result.status, 0, 'BROWSER_REGRESSION_FAILED');
      checks.push('既存のブラウザー操作テストをNext.js統合モードで確認');
    } finally { fs.closeSync(browserLog); }
  }
  if (process.argv.includes('--meeting-browser')) {
    phase = 'meeting-browser';
    const browserLog = fs.openSync(path.join(output, 'meeting-browser.log'), 'w');
    try {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'check-meeting-browser.mjs'], { cwd: fileURLToPath(new URL('./', import.meta.url)), env: { ...process.env, SITEFLOW_BROWSER_ORIGIN: base }, windowsHide: true, stdio: ['ignore', browserLog, browserLog] });
      assert.equal(result.status, 0, 'MEETING_BROWSER_FAILED');
      checks.push('会議の開始・確認・取消・再開・終了をNext.js統合画面で確認');
    } finally { fs.closeSync(browserLog); }
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ status: 'passed', checks }, null, 2));
  console.info(JSON.stringify({ status: 'passed', checks }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', phase, code: error?.code ?? error?.name })); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  if (data) await removeLocalWorkspaceData(prisma, data);
  if (extraUser) await prisma.user.deleteMany({ where: { id: extraUser } });
  await prisma.$disconnect(); fs.closeSync(log);
}
