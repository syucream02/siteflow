import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { handlePublicIntegratedApi } from '../lib/siteflow/public-integrated-api.ts';
import { readWorkspaceConnection, workspacePageEnabled } from '../lib/siteflow/workspace-connection.ts';
import { publicProxyOrigin } from '../lib/siteflow/proxy-origins.ts';
import { readPublicApiSettings } from '../examples/mysql/public-api-settings.ts';
import { publicDatabaseOptions } from '../examples/mysql/public-database.ts';

const env = { NODE_ENV: 'production', SITEFLOW_WORKSPACE_MODE: 'public-integrated', SITEFLOW_PUBLIC_ORIGIN: 'https://13.237.188.172',
  SITEFLOW_AUTH_SECRET: 'ab'.repeat(32), SITEFLOW_DB_HOST: 'mysql.internal', SITEFLOW_DB_PORT: '3306', SITEFLOW_DB_NAME: 'siteflow_public_demo',
  SITEFLOW_DB_USER: 'siteflow_app', SITEFLOW_DB_PASSWORD: 'fictional-password-only', SITEFLOW_DB_TLS: 'required' };
const request = (options = {}) => new Request('http://localhost:3000/api/siteflow/teams', { headers: { Host: '13.237.188.172' }, ...options });

test('公開用統合は明示設定とHTTPS Originがそろった場合だけ選べる', () => {
  const connection = readWorkspaceConnection(env);
  assert.equal(connection.mode, 'public-integrated');
  assert.equal(workspacePageEnabled(connection, '13.237.188.172'), true);
  assert.equal(workspacePageEnabled(connection, '127.0.0.1:3000'), false);
  assert.equal(readWorkspaceConnection({ NODE_ENV: 'production' }).mode, 'disabled');
  for (const key of ['SITEFLOW_AUTH_SECRET','SITEFLOW_DB_TLS','SITEFLOW_DB_NAME']) assert.equal(readWorkspaceConnection({ ...env, [key]: undefined }).mode, 'invalid');
});
test('外部IPv4のHTTPSを許可し、PC内・プライベートIPや不正URLは拒否する', () => {
  assert.equal(publicProxyOrigin(env.SITEFLOW_PUBLIC_ORIGIN)?.host, '13.237.188.172');
  for (const value of ['https://127.0.0.1','https://10.0.0.1','https://192.168.1.1','https://172.16.0.1','https://169.254.1.1','https://0.0.0.0','https://224.0.0.1','http://13.237.188.172','https://13.237.188.172/path']) assert.equal(publicProxyOrigin(value), null);
});
test('Host/Origin/設定違反ではDB生成前に拒否し、ローカル中継へ戻さない', async () => {
  let calls = 0;
  const load = async () => { calls++; return async () => Response.json({ ok: true }); };
  assert.equal((await handlePublicIntegratedApi(request(), env, load)).status, 200);
  const bad = [request({ headers: { Host: 'evil.invalid', 'x-forwarded-host': '13.237.188.172' } }), request({ headers: { Host: '13.237.188.172', Origin: 'https://evil.invalid' } }), request({ method: 'POST', body: '{}' })];
  for (const input of bad) assert.equal((await handlePublicIntegratedApi(input, env, load)).status, 403);
  assert.equal((await handlePublicIntegratedApi(request(), { ...env, SITEFLOW_AUTH_SECRET: undefined }, load)).status, 503);
  assert.equal(calls, 1);
});
test('DB初期化失敗の例外・パスワード・CAパスをブラウザーへ出さない', async () => {
  const response = await handlePublicIntegratedApi(request(), env, async () => { throw Error('PRIVATE_PASSWORD_AND_PATH'); });
  assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!(await response.text()).includes('PRIVATE_PASSWORD'));
});

test('standaloneの固定内部URLを許可しても、偽装Hostや異なるポートは拒否する', async () => {
  const settings = { ...env, HOSTNAME: '0.0.0.0', PORT: '3000' };
  const make = (url, host = '13.237.188.172') => new Request(url, { headers: { Host: host } });
  const load = async () => async () => Response.json({ ok: true });
  assert.equal((await handlePublicIntegratedApi(make('http://0.0.0.0:3000/api/siteflow/teams'), settings, load)).status, 200);
  assert.equal((await handlePublicIntegratedApi(make('https://0.0.0.0:3000/api/siteflow/teams'), settings, load)).status, 200);
  for (const input of [make('http://0.0.0.0:3001/api/siteflow/teams'), make('http://evil.invalid:3000/api/siteflow/teams'), make('http://0.0.0.0:3000/api/siteflow/teams', 'evil.invalid')]) {
    assert.equal((await handlePublicIntegratedApi(input, settings, load)).status, 403);
  }
  assert.equal((await handlePublicIntegratedApi(make('http://0.0.0.0:3000/api/siteflow/teams'), env, load)).status, 403);
});
test('公開DBは証明書検証とTLS1.2以上を要求し、CA設定は絶対パスだけ受け取る', () => {
  const options = publicDatabaseOptions(readPublicApiSettings(env));
  assert.equal(options.ssl.rejectUnauthorized, true); assert.equal(options.ssl.minVersion, 'TLSv1.2');
  assert.equal(options.ssl.checkServerIdentity('localhost', { subjectaltname: 'DNS:mysql.internal' }), undefined);
  assert.ok(options.ssl.checkServerIdentity('mysql.internal', { subjectaltname: 'DNS:wrong.example.com' }) instanceof Error);
  assert.equal(options.connectionLimit, 2);
  assert.throws(() => readPublicApiSettings({ ...env, SITEFLOW_DB_CA_FILE: 'relative.pem' }), { field: 'SITEFLOW_DB_CA_FILE' });
  const file = path.resolve('work/nonexistent-public-check-ca.pem');
  const settings = readPublicApiSettings({ ...env, SITEFLOW_DB_CA_FILE: file });
  assert.throws(() => publicDatabaseOptions(settings), error => !error.message.includes(file));
});
