import test from 'node:test';
import assert from 'node:assert/strict';
import { browserAuthResponse, handleIntegratedApi, integratedOrigin } from '../lib/siteflow/integrated-api.ts';
import { readWorkspaceConnection, workspacePageEnabled } from '../lib/siteflow/workspace-connection.ts';
import { readJsonBody } from '../examples/mysql/json-body.ts';

const origin = 'http://127.0.0.1:5173';
const env = { NODE_ENV: 'development', SITEFLOW_WORKSPACE_MODE: 'integrated', SITEFLOW_INTEGRATED_ORIGIN: origin };
const request = (options = {}) => new Request(origin + '/api/siteflow/teams', { headers: { Host: '127.0.0.1:5173' }, ...options });

test('ログイン・セッションのJSONから秘密値を除き、複数のHttpOnly Cookieは保持する', async () => {
  const headers = new Headers();
  headers.append('Set-Cookie', 'better-auth.session_token=test-token; Path=/; HttpOnly; SameSite=Lax');
  headers.append('Set-Cookie', 'better-auth.other=test-other; Path=/; HttpOnly; SameSite=Lax');
  const login = await browserAuthResponse(Response.json({ token: 'private' }, { headers }), '/api/siteflow/auth/sign-in/email');
  assert.deepEqual(await login.json(), { ok: true });
  assert.equal(login.headers.getSetCookie().length, 2);
  const session = await browserAuthResponse(Response.json({ session: { token: 'private' }, user: { id: 'u', name: '架空', email: 'u@example.invalid', private: 'hidden' } }), '/api/siteflow/auth/get-session');
  assert.deepEqual(await session.json(), { user: { id: 'u', name: '架空', email: 'u@example.invalid' } });
});

test('統合は開発環境と明示したPC内Originだけで有効、本番・設定不足では閉じる', () => {
  const connection = readWorkspaceConnection(env);
  assert.equal(connection.mode, 'integrated');
  assert.equal(workspacePageEnabled(connection, '127.0.0.1:5173'), true);
  assert.equal(workspacePageEnabled(connection, 'example.invalid'), false);
  for (const values of [{ ...env, NODE_ENV: 'production' }, { ...env, SITEFLOW_INTEGRATED_ORIGIN: undefined },
    { ...env, SITEFLOW_INTEGRATED_ORIGIN: 'https://example.invalid' }, { ...env, SITEFLOW_INTEGRATED_ORIGIN: origin + '/path' }]) {
    assert.equal(integratedOrigin(values), null);
    assert.equal(readWorkspaceConnection(values).mode, 'invalid');
  }
});

test('不正Host・Origin・cross-site・無設定ではDB生成より前に拒否する', async () => {
  let calls = 0;
  const load = async () => { calls++; return async () => Response.json({ ok: true }); };
  assert.equal((await handleIntegratedApi(request(), env, load)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await handleIntegratedApi(new Request('http://localhost:5173/api/siteflow/teams', { headers: { Host: '127.0.0.1:5173' } }), env, load)).status, 200);
  assert.equal(calls, 2);
  const rejected = [request({ headers: { Host: 'evil.invalid', 'x-forwarded-host': '127.0.0.1:5173' } }),
    request({ headers: { Host: '127.0.0.1:5173', Origin: 'https://evil.invalid' } }),
    request({ headers: { Host: '127.0.0.1:5173', 'Sec-Fetch-Site': 'cross-site' } }),
    request({ method: 'POST', body: '{}' })];
  for (const input of rejected) assert.equal((await handleIntegratedApi(input, env, load)).status, 403);
  assert.equal((await handleIntegratedApi(request(), { ...env, NODE_ENV: 'production' }, load)).status, 503);
  assert.equal(calls, 2);
});

test('DB初期化失敗は秘密値を返さず、再試行できる503を返す', async () => {
  const result = await handleIntegratedApi(request(), env, async () => { throw new Error('private connection string'); });
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.ok(!(await result.text()).includes('private connection string'));
});

test('本文上限は文字数ではなくUTF-8バイト数で検査し、不正JSONも拒否する', async () => {
  const input = body => new Request(origin, { method: 'POST', body });
  assert.deepEqual(await readJsonBody(input('{"name":"架空"}'), 32), { value: { name: '架空' } });
  assert.equal((await readJsonBody(input('"ああ"'), 7)).tooLarge, true);
  assert.equal((await readJsonBody(input('{'), 32)).invalid, true);
});
