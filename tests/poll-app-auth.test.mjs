import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { inspect } from 'node:util';
import { createAppJwt, createMockAppAuth } from '../deploy/poll/app-auth.mjs';
import { createMockTransport } from '../deploy/poll/transport.mjs';

// 一度限りのメモリ内テスト鍵。保存・出力・実Appへの登録はしない。
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NOW = 1700000000;
const permissions = () => ({ contents: 'read', actions: 'read', environments: 'read', metadata: 'read' });
function fixture() {
  const installation = { id: 22, app_id: 11, account: { login: 'syucream02' },
    repository_selection: 'selected', suspended_at: null, permissions: permissions() };
  const result = { token: 'fixture.installation-token-not-real', expires_at: new Date((NOW + 3600) * 1000).toISOString(),
    permissions: permissions(), repository_selection: 'selected', repositories: [{ id: 33, full_name: 'syucream02/siteflow' }] };
  const transport = { mode: 'mock-only', async getJson() { return installation; }, async issueToken() { return result; } };
  return { installation, result, config: { appId: '11', installationId: '22', repositoryId: 33,
    privateKey: keys.privateKey, transport, now: () => NOW } };
}
test('RS256 JWTの署名と発行時刻・期限を独立に検査', () => {
  const c = createAppJwt({ appId: '11', privateKey: keys.privateKey, now: NOW });
  const parts = c.authorization(NOW).slice(7).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(parts[1], 'base64url')), { iss: '11', iat: NOW - 60, exp: NOW + 300 });
  assert.equal(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), keys.publicKey, Buffer.from(parts[2], 'base64url')), true);
  const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
  assert.equal(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), keys.publicKey, signature), false);
  assert.throws(() => c.authorization(NOW + 300), /EXPIRED/);
  assert.equal(JSON.stringify(c).includes(parts[2]), false);
  assert.equal(inspect(c).includes(parts[2]), false);
});
for (const change of [{ appId: '0' }, { appId: 11 }, { appId: '../11' }, { now: -1 },
  { now: 1.2 }, { ttlSeconds: 601 }, { ttlSeconds: 0 }, { privateKey: 'NOT A PRIVATE KEY' }]) {
  test(`不正JWT設定は固定エラーで拒否: ${Object.keys(change)[0]} ${String(Object.values(change)[0])}`, () => {
    assert.throws(() => createAppJwt({ appId: '11', privateKey: keys.privateKey, now: NOW, ...change }), /^Error: APP_JWT_REJECTED$/);
  });
}
test('JWT期限の整数オーバーフローを拒否', () => {
  assert.throws(() => createAppJwt({ appId: '11', privateKey: keys.privateKey, now: Number.MAX_SAFE_INTEGER }), /APP_JWT_REJECTED/);
});
test('弱いRSA鍵・RSA以外の鍵を拒否', () => {
  for (const key of [generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey,
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey]) {
    assert.throws(() => createAppJwt({ appId: '11', privateKey: key, now: NOW }), /APP_JWT_REJECTED/);
  }
});
test('模擬installationを照合して短期credentialを取得、期限後は拒否', async () => {
  const f = fixture(), auth = createMockAppAuth(f.config), c = await auth.getCredential();
  assert.equal(auth.executionAllowed, false);
  assert.ok(c.authorization(NOW).startsWith('Bearer '));
  assert.throws(() => c.authorization(NOW + 3600), /EXPIRED/);
  assert.equal(JSON.stringify(c).includes(f.result.token), false);
  assert.equal(inspect(c).includes(f.result.token), false);
});
for (const [name, mutate] of [
  ['App ID不一致', f => { f.installation.app_id = 99; }],
  ['installation ID不一致', f => { f.installation.id = 99; }],
  ['別アカウント', f => { f.installation.account.login = 'other'; }],
  ['全repoインストール', f => { f.installation.repository_selection = 'all'; }],
  ['停止済みinstallation', f => { f.installation.suspended_at = '2026-01-01T00:00:00Z'; }],
  ['権限不足', f => { delete f.result.permissions.actions; }],
  ['過剰権限', f => { f.result.permissions.contents = 'write'; }],
  ['管理権限追加', f => { f.installation.permissions.administration = 'read'; }],
  ['別repo', f => { f.result.repositories[0].id = 99; }],
  ['複数repo', f => { f.result.repositories.push({ id: 34, full_name: 'other/repo' }); }],
  ['期限切れ', f => { f.result.expires_at = new Date(NOW * 1000).toISOString(); }],
  ['長すぎるtoken期限', f => { f.result.expires_at = new Date((NOW + 3601) * 1000).toISOString(); }],
  ['改行token', f => { f.result.token = 'fixture\r\nAuthorization: value'; }],
  ['JWT期限切れ中の取得', f => { let calls = 0; f.config.now = () => NOW + (calls++ ? 301 : 0); }],
]) {
  test(`模擬認証異常を拒否: ${name}`, async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(createMockAppAuth(f.config).getCredential(), /^Error: MOCK_APP_AUTH_REJECTED$/);
  });
}
test('通信例外の秘密文字列を例外へ含めない', async () => {
  const f = fixture(); f.config.transport.issueToken = async () => { throw new Error(f.result.token); };
  await assert.rejects(createMockAppAuth(f.config).getCredential(), e => e.message === 'MOCK_APP_AUTH_REJECTED');
});

// 3回の時計読取は、開始・token要求前・応答受信時を表す。実通信はしない。
function delayedFixture({ requested = NOW + 2, received = NOW + 5, expires = NOW + 3604 } = {}) {
  const f = fixture(), times = [NOW, requested, received]; let index = 0;
  f.config.now = () => times[Math.min(index++, times.length - 1)];
  f.result.expires_at = new Date(expires * 1000).toISOString();
  return f;
}
test('通信に数秒かかり、要求と受信の間に発行されたtokenを受け入れる', async () => {
  const f = delayedFixture(), auth = createMockAppAuth(f.config), c = await auth.getCredential();
  assert.equal(auth.executionAllowed, false);
  assert.equal(c.expiresAt, NOW + 3604); // 開始時刻からの上限へ切り詰めない。
  assert.ok(c.authorization(NOW + 5).startsWith('Bearer '));
  assert.throws(() => c.authorization(NOW + 3604), /^Error: CREDENTIAL_EXPIRED$/);
  assert.equal(JSON.stringify(c).includes(f.result.token), false);
  assert.equal(inspect(c).includes(f.result.token), false);
});
test('既存の模擬HTTP処理を通す通信遅延でもtoken取得が成功する', async () => {
  const f = fixture(); let clock = NOW; const methods = [];
  f.result.expires_at = new Date((NOW + 3604) * 1000).toISOString();
  f.config.now = () => clock;
  f.config.transport = createMockTransport({ now: () => clock, exchange: async request => {
    methods.push(request.method);
    const installationRequest = request.method === 'GET';
    clock += installationRequest ? 2 : 3;
    return { status: installationRequest ? 200 : 201, headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(installationRequest ? f.installation : f.result)) };
  } });
  const auth = createMockAppAuth(f.config), c = await auth.getCredential();
  assert.deepEqual(methods, ['GET', 'POST']); assert.equal(clock, NOW + 5);
  assert.equal(c.expiresAt, NOW + 3604); assert.equal(auth.executionAllowed, false);
  assert.equal(JSON.stringify(c).includes(f.result.token), false);
});
for (const delay of [1, 5, 299]) test(`受信時点+1時間の上限を受け入れる: 遅延${delay}秒`, async () => {
  const f = delayedFixture({ requested: NOW, received: NOW + delay, expires: NOW + delay + 3600 });
  const c = await createMockAppAuth(f.config).getCredential();
  assert.equal(c.expiresAt, NOW + delay + 3600);
});
test('受信時点で残り1秒のtokenも期限を延長せず、期限ちょうどで拒否する', async () => {
  const f = delayedFixture({ expires: NOW + 6 }), c = await createMockAppAuth(f.config).getCredential();
  assert.equal(c.expiresAt, NOW + 6); assert.ok(c.authorization(NOW + 5).startsWith('Bearer '));
  assert.throws(() => c.authorization(NOW + 6), /CREDENTIAL_EXPIRED/);
});
test('受信時計が発行側より進んで見えても、残存期限内なら延長せず受け入れる', async () => {
  const f = delayedFixture({ received: NOW + 10, expires: NOW + 3600 });
  assert.equal((await createMockAppAuth(f.config).getCredential()).expiresAt, NOW + 3600);
});
for (const [name, settings] of [
  ['受信時点で期限ちょうど', { expires: NOW + 5 }],
  ['通信中に期限切れ', { expires: NOW + 4 }],
  ['受信から1時間を1秒超える', { expires: NOW + 3606 }],
  ['受信から1時間を1ミリ秒超える', { expires: NOW + 3605.001 }],
  ['開始後に時計が逆行', { requested: NOW - 1 }],
  ['要求後に時計が逆行', { requested: NOW + 4, received: NOW + 3 }],
  ['JWT期限ちょうどに受信', { received: NOW + 300 }],
  ['JWT期限後に受信', { received: NOW + 301 }],
  ['要求時計の型が不正', { requested: '1700000002' }],
  ['受信時計が非整数', { received: NOW + 5.5 }],
  ['受信時計が不明', { received: null }],
]) test(`通信遅延後も安全側で拒否: ${name}`, async () => {
  const f = delayedFixture(settings);
  await assert.rejects(createMockAppAuth(f.config).getCredential(), e => {
    assert.equal(e.message.includes(f.result.token), false);
    return e.message === 'MOCK_APP_AUTH_REJECTED';
  });
});
test('通信遅延があっても不正なexpires_atと権限不足を拒否する', async () => {
  for (const mutate of [f => { f.result.expires_at = 'invalid'; }, f => { f.result.expires_at = 1700003600; }, f => { delete f.result.permissions.actions; }]) {
    const f = delayedFixture(); mutate(f);
    await assert.rejects(createMockAppAuth(f.config).getCredential(), /^Error: MOCK_APP_AUTH_REJECTED$/);
  }
});
