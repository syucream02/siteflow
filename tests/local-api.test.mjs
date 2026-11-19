import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyLocalApi } from '../lib/siteflow/local-api.ts';
const team = '10000000-0000-4000-8000-000000000001';
const base = 'http://127.0.0.1:5173';
const config = { environment: 'development', backendOrigin: 'http://127.0.0.1:5175' };
const request = (path, options = {}) => new Request(`${base}/api/siteflow/${path}`, options);
const post = (body = {}, extra = {}) => ({ method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
const forbiddenFetch = async () => { throw new Error('should not fetch'); };

test('担当候補GETと案件登録POSTを限定して中継し、作成者や権限ヘッダーを追加しない', async () => {
  const path = `teams/${team}/members?limit=20`;
  assert.equal((await proxyLocalApi(request(path), ['teams', team, 'members'], { ...config, fetcher: async url => { assert.equal(url, `${config.backendOrigin}/api/${path}`); return Response.json({ items: [] }); } })).status, 200);
  const body = { name: '架空の案件', notes: 'あ'.repeat(2000) };
  const response = await proxyLocalApi(request(`teams/${team}/projects`, post(body)), ['teams', team, 'projects'], { ...config, fetcher: async (url, options) => {
    assert.equal(options.method, 'POST'); assert.deepEqual(JSON.parse(options.body), body); assert.equal(options.headers.get('origin'), config.backendOrigin); assert.equal(options.headers.has('x-role'), false);
    return Response.json({ project: { id: 'fiction' } }, { status: 201 });
  } });
  assert.equal(response.status, 201);
  const denied = await proxyLocalApi(request(`teams/${team}/projects`, post()), ['teams', team, 'projects'], { ...config, fetcher: async () => Response.json({ message: '担当を選び直してください。' }, { status: 400 }) });
  assert.equal(denied.status, 400); assert.equal((await denied.json()).message, '担当を選び直してください。');
});

test('案件本文は32768バイトまでに限定し、所属の更新や不正Originは許可しない', async () => {
  const route = `teams/${team}/projects`;
  assert.equal((await proxyLocalApi(request(route, post({ notes: 'x'.repeat(32769) })), route.split('/'), { ...config, fetcher: forbiddenFetch })).status, 413);
  assert.equal((await proxyLocalApi(request(route, post({}, { Origin: 'https://example.invalid' })), route.split('/'), { ...config, fetcher: forbiddenFetch })).status, 403);
  const members = `teams/${team}/members`;
  assert.equal((await proxyLocalApi(request(members, post()), members.split('/'), { ...config, fetcher: forbiddenFetch })).status, 405);
});

test('本番と未指定環境では中継を公開しない', async () => {
  for (const environment of ['production', 'test', undefined]) assert.equal((await proxyLocalApi(request('teams'), ['teams'], { ...config, environment, fetcher: forbiddenFetch })).status, 404);
});
test('ループバック以外の接続元Hostを拒否する', async () => {
  const req = new Request('http://example.invalid/api/siteflow/teams');
  assert.equal((await proxyLocalApi(req, ['teams'], { ...config, fetcher: forbiddenFetch })).status, 403);
  for (const host of ['example.invalid:5173', '127.0.0.1:9999', 'localhost:5173@evil.invalid']) assert.equal((await proxyLocalApi(request('teams', { headers: { Host: host } }), ['teams'], { ...config, fetcher: forbiddenFetch })).status, 403);
});

test('Next.js内部URLとブラウザーHostのループバック表記が違っても同一Originを検査できる', async () => {
  const req = new Request('http://localhost:5173/api/siteflow/auth/sign-out', post({}, { Host: '127.0.0.1:5173' }));
  assert.equal((await proxyLocalApi(req, ['auth', 'sign-out'], { ...config, fetcher: async () => Response.json({ success: true }) })).status, 200);
  const bad = new Request('http://localhost:5173/api/siteflow/auth/sign-out', post({}, { Host: '127.0.0.1:5173', Origin: 'http://localhost:5173' }));
  assert.equal((await proxyLocalApi(bad, ['auth', 'sign-out'], { ...config, fetcher: forbiddenFetch })).status, 403);
});
test('公開する操作だけを中継し、未知のURLと対象外メソッドを拒否する', async () => {
  for (const path of ['auth/sign-up/email', 'teams/other/projects', `teams/${team}/projects/id`, 'auth/../teams']) assert.equal((await proxyLocalApi(request(path), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 404);
  const response = await proxyLocalApi(request('teams', post()), ['teams'], { ...config, fetcher: forbiddenFetch }); assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
});
test('更新のOrigin必須・偽のOrigin・クロスサイト要求を拒否する', async () => {
  for (const headers of [{ 'Content-Type': 'application/json' }, { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, { Origin: base, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }]) {
    const req = request('auth/sign-out', { method: 'POST', headers, body: '{}' });
    assert.equal((await proxyLocalApi(req, ['auth', 'sign-out'], { ...config, fetcher: forbiddenFetch })).status, 403);
  }
});

test('UUIDの詳細・関連GETを中継し、対象外メソッドと未知の子URLを拒否する', async () => {
  const project = '20000000-0000-4000-8000-000000000001';
  for (const suffix of ['', '/support-members', '/progress-history', '/assignment-history']) {
    const path = `teams/${team}/projects/${project}${suffix}`;
    const response = await proxyLocalApi(request(path), path.split('/'), { ...config, fetcher: async url => { assert.equal(url, `${config.backendOrigin}/api/${path}`); return Response.json({ ok: true }); } });
    assert.equal(response.status, 200);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'].filter(method => suffix !== '' || method !== 'PATCH')) assert.equal((await proxyLocalApi(request(path, { method }), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 405);
  }
  for (const path of [`teams/${team}/projects/not-a-uuid`, `teams/${team}/projects/${project}/support-members/extra`, `teams/${team}/archived-projects/not-a-uuid`]) assert.equal((await proxyLocalApi(request(path), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 404);
});

test('基本PATCH・担当PUT・進捗PATCHだけを追加し、Cookieと本文を保って中継する', async () => {
  const project = '20000000-0000-4000-8000-000000000001';
  for (const [suffix, method] of [['', 'PATCH'], ['/assignees', 'PUT'], ['/progress', 'PATCH']]) {
    const path = `teams/${team}/projects/${project}${suffix}`;
    const response = await proxyLocalApi(request(path, { ...post({ expectedVersion: 1, notes: 'あ'.repeat(2000) }), method }), path.split('/'), { ...config, fetcher: async (url, options) => { assert.equal(options.method, method); assert.equal(JSON.parse(options.body).expectedVersion, 1); assert.equal(options.headers.get('origin'), config.backendOrigin); return Response.json({ code: 'PROJECT_VERSION_CONFLICT' }, { status: 409 }); } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'PROJECT_VERSION_CONFLICT');
  }
});

test('更新の異なるOrigin・本文上限・未知の更新経路を拒否する', async () => {
  const project = '20000000-0000-4000-8000-000000000001'; const path = `teams/${team}/projects/${project}/progress`;
  assert.equal((await proxyLocalApi(request(path, { ...post({}, { Origin: 'https://example.invalid' }), method: 'PATCH' }), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 403);
  assert.equal((await proxyLocalApi(request(path, { ...post({ comment: 'x'.repeat(32769) }), method: 'PATCH' }), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 413);
  for (const suffix of ['archive/extra', 'restore/extra']) { const route = `teams/${team}/projects/${project}/${suffix}`; assert.equal((await proxyLocalApi(request(route, post()), route.split('/'), { ...config, fetcher: forbiddenFetch })).status, 404); }
});

test('保管詳細と関連GETを公開し、保管中の更新や未知の子URLは中継しない', async () => {
  const id = '20000000-0000-4000-8000-000000000001';
  for (const suffix of ['', '/support-members', '/progress-history', '/assignment-history']) {
    const path = `teams/${team}/archived-projects/${id}${suffix}?limit=20`;
    const route = path.split('?')[0].split('/');
    assert.equal((await proxyLocalApi(request(path), route, { ...config, fetcher: async url => { assert.equal(url, config.backendOrigin + '/api/' + path); return Response.json({ ok: true }); } })).status, 200);
    for (const method of ['POST','PATCH','PUT','DELETE']) assert.equal((await proxyLocalApi(request(path, { method }), route, { ...config, fetcher: forbiddenFetch })).status, 405);
  }
  const path = `teams/${team}/archived-projects/${id}/progress`;assert.equal((await proxyLocalApi(request(path, post()), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 404);
});

test('保管と担当付き復元は通常案件URLへのPOSTだけに限定し、Originと本文上限を維持する', async () => {
  const id = '20000000-0000-4000-8000-000000000001';
  for (const action of ['archive','restore']) {
    const path = `teams/${team}/projects/${id}/${action}`; const body = { expectedVersion: 2, ...(action === 'restore' ? { primaryUserId: id, supportUserIds: [] } : {}) };
    assert.equal((await proxyLocalApi(request(path, post(body)), path.split('/'), { ...config, fetcher: async (url, options) => { assert.equal(options.method, 'POST'); assert.deepEqual(JSON.parse(options.body), body); assert.equal(options.headers.get('origin'), config.backendOrigin); return Response.json({ changed: true }); } })).status, 200);
    for (const method of ['GET','PATCH','PUT','DELETE']) assert.equal((await proxyLocalApi(request(path, { method }), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 405);
    assert.equal((await proxyLocalApi(request(path, post(body, { Origin: 'https://example.invalid' })), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 403);
    assert.equal((await proxyLocalApi(request(path, post({ notes: 'x'.repeat(32769) })), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 413);
  }
});

test('状態PATCHは版と理由を転送し、別メソッド・別Origin・本文超過を拒否する', async () => {
  const path = `teams/${team}/projects/20000000-0000-4000-8000-000000000001/status`;
  const body = { expectedVersion: 2, status: 'IN_PROGRESS', comment: '架空の再開理由' };
  const response = await proxyLocalApi(request(path, { ...post(body), method: 'PATCH' }), path.split('/'), { ...config, fetcher: async (url, options) => { assert.equal(options.method, 'PATCH'); assert.deepEqual(JSON.parse(options.body), body); assert.equal(options.headers.get('origin'), config.backendOrigin); return Response.json({ project: { status: 'IN_PROGRESS' } }); } });
  assert.equal(response.status, 200);
  for (const method of ['GET','POST','PUT','DELETE']) assert.equal((await proxyLocalApi(request(path, { method }), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 405);
  assert.equal((await proxyLocalApi(request(path, { ...post(body, { Origin: 'https://example.invalid' }), method: 'PATCH' }), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 403);
  assert.equal((await proxyLocalApi(request(path, { ...post({ ...body, comment: 'x'.repeat(32769) }), method: 'PATCH' }), path.split('/'), { ...config, fetcher: forbiddenFetch })).status, 413);
});
test('接続先は明示した127.0.0.1のHTTPポートだけを許可する', async () => {
  for (const backendOrigin of [undefined, 'http://example.invalid:5175', 'http://localhost:5175', 'https://127.0.0.1:5175', 'http://user@127.0.0.1:5175', 'http://127.0.0.1:5175/path', 'http://127.0.0.1:5175?x=1']) assert.equal((await proxyLocalApi(request('teams'), ['teams'], { ...config, backendOrigin, fetcher: forbiddenFetch })).status, 503);
});
test('一覧の条件とCookieだけを転送し、role等の任意ヘッダーを転送しない', async () => {
  const req = request(`teams/${team}/projects?limit=2`, { headers: { Cookie: 'test-cookie=opaque', 'X-Role': 'admin' } });
  const response = await proxyLocalApi(req, ['teams', team, 'projects'], { ...config, fetcher: async (url, options) => {
    assert.equal(url, `http://127.0.0.1:5175/api/teams/${team}/projects?limit=2`); assert.equal(options.headers.get('cookie'), 'test-cookie=opaque'); assert.equal(options.headers.has('x-role'), false); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    return Response.json({ items: [], page: { hasMore: false, nextCursor: null } });
  } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('ログイン成功の秘密値を返さず、複数のCookieのHttpOnlyと中継用Pathを保持する', async () => {
  const response = await proxyLocalApi(request('auth/sign-in/email', post({ email: 'fiction@example.invalid', password: 'test-only-input' })), ['auth', 'sign-in', 'email'], { ...config, fetcher: async (url, options) => {
    assert.equal(options.headers.get('origin'), config.backendOrigin);
    const headers = new Headers(); headers.append('Set-Cookie', 'session=opaque; Path=/; HttpOnly; SameSite=Lax'); headers.append('Set-Cookie', 'other=value; Path=/; HttpOnly');
    return Response.json({ token: 'never-return-this', user: { id: 'u' } }, { headers });
  } });
  assert.deepEqual(await response.json(), { ok: true }); assert.equal(response.headers.getSetCookie().length, 2);
  for (const cookie of response.headers.getSetCookie()) { assert.match(cookie, /Path=\/api\/siteflow/); assert.match(cookie, /HttpOnly/); }
});
test('セッションは本人の表示用項目だけ返し、ログアウトCookieも同じPathで消せる', async () => {
  const response = await proxyLocalApi(request('auth/get-session'), ['auth', 'get-session'], { ...config, fetcher: async () => Response.json({ user: { id: 'u', name: '架空ユーザー', email: 'fiction@example.invalid', extra: 'omit' }, session: { token: 'secret' } }) });
  assert.deepEqual(await response.json(), { user: { id: 'u', name: '架空ユーザー', email: 'fiction@example.invalid' } });
  const out = await proxyLocalApi(request('auth/sign-out', post()), ['auth', 'sign-out'], { ...config, fetcher: async () => Response.json({ success: true }, { headers: { 'Set-Cookie': 'session=; Max-Age=0; Path=/; HttpOnly' } }) });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0; Path=\/api\/siteflow/);
});
test('JSON・Content-Type・本文4096バイト上限を中継前に検査する', async () => {
  for (const [options, status] of [[{ ...post(), body: '{' }, 400], [post({}, { 'Content-Type': 'text/plain' }), 415], [post({ password: 'x'.repeat(4100) }), 413]]) assert.equal((await proxyLocalApi(request('auth/sign-in/email', options), ['auth', 'sign-in', 'email'], { ...config, fetcher: forbiddenFetch })).status, status);
});
test('通信障害や不正な上流応答は内部の情報を出さず503とする', async () => {
  for (const fetcher of [async () => { throw new Error('private detail'); }, async () => new Response('private detail'), async () => Response.json({ private: 'detail' }, { status: 500 })]) {
    const response = await proxyLocalApi(request('teams'), ['teams'], { ...config, fetcher }); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('private'));
  }
});
