import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockTransport, decodeStrictJson, MOCK_DOWNLOAD_HOST } from '../deploy/poll/transport.mjs';
const c = { authorization() { return 'Bearer fixture-not-real'; } };
const json = body => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) });
const client = exchange => createMockTransport({ exchange, now: () => 1700000000 });
test('固定操作だけをHTTPSで要求し、模擬結果は配信許可にしない', async () => {
  const requests = [], t = client(async r => { requests.push(r); return json({ id: 1 }); });
  assert.deepEqual(await t.getJson('repository', {}, c), { id: 1 });
  assert.equal(t.executionAllowed, false);
  assert.equal(requests[0].url, 'https://api.github.com/repos/syucream02/siteflow');
  assert.equal(requests[0].redirect, 'manual');
  assert.ok(requests[0].headers.Authorization.startsWith('Bearer '));
  assert.throws(() => t.getJson('https://evil.invalid', {}, c), /UNKNOWN_API_OPERATION/);
  assert.throws(() => t.getJson('content', { path: '../secret', sha: 'a'.repeat(40) }, c));
});
test('token発行POSTは対象repoと読み取り権限に限定', async () => {
  const t = client(async r => {
    assert.equal(r.method, 'POST'); assert.ok(r.url.endsWith('/app/installations/22/access_tokens'));
    const b = JSON.parse(r.body); assert.deepEqual(b.repository_ids, [33]);
    assert.ok(Object.values(b.permissions).every(v => v === 'read'));
    return { ...json({ token: 'fixture' }), status: 201 };
  });
  await t.issueToken('22', 33, c);
});
for (const status of [301, 302, 401, 403, 429, 500]) {
  test(`APIステータス${status}を拒否`, async () => {
    await assert.rejects(client(async () => ({ ...json({ secret: 'do-not-echo' }), status })).getJson('repository', {}, c), /^Error: MOCK_HTTP_REJECTED$/);
  });
}
test('レート制限・不正Content-Type・不正JSON・巨大応答を拒否', async () => {
  const bad = [
    { ...json({}), headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' } },
    { ...json({}), headers: { 'content-type': 'text/html' } },
    { ...json({}), body: Buffer.from('{invalid secret') },
    { ...json({}), body: Buffer.alloc(262145) },
    { ...json({}), headers: { 'content-type': 'application/json', 'content-length': '9999999' } },
    { ...json({}), headers: { 'content-type': 'application/json', 'content-length': '10' } },
    { ...json({}), headers: { 'content-type': 'application/json', 'Content-Type': 'text/html' } },
  ];
  for (const r of bad) await assert.rejects(client(async () => r).getJson('repository', {}, c), /MOCK_HTTP_REJECTED/);
});
test('chunk応答も上限を超えれば拒否', async () => {
  async function* chunks() { yield Buffer.alloc(200000); yield Buffer.alloc(100000); }
  await assert.rejects(client(async () => ({ ...json({}), body: chunks() })).getJson('repository', {}, c));
});
test('タイムアウトでAbortし、秘密を含む通信例外を固定エラーにする', async () => {
  let signal;
  const t = createMockTransport({ now: () => 1, timeoutMs: 5, exchange: async r => { signal = r.signal; return new Promise(() => {}); } });
  await assert.rejects(t.getJson('repository', {}, c), /MOCK_HTTP_REJECTED/); assert.equal(signal.aborted, true);
  await assert.rejects(client(async () => { throw new Error('fixture-not-real'); }).getJson('repository', {}, c), e => !e.message.includes('fixture-not-real'));
});
test('body読取中の停止もタイムアウト対象とし、期限切れcredentialは送信しない', async () => {
  async function* body() { yield Buffer.from('{'); await new Promise(() => {}); }
  const t = createMockTransport({ now: () => 1, timeoutMs: 5, exchange: async () => ({ ...json({}), body: body() }) });
  await assert.rejects(t.getJson('repository', {}, c), /MOCK_HTTP_REJECTED/);
  let calls = 0;
  const expired = { authorization() { throw new Error('fixture-secret-expired'); } };
  await assert.rejects(client(async () => { calls++; return json({}); }).getJson('repository', {}, expired), /MOCK_HTTP_REJECTED/);
  assert.equal(calls, 0);
});
test('許可した模擬ZIPホストへだけredirectし、Authorizationを送らない', async () => {
  const seen = [], t = client(async r => {
    seen.push(r);
    return seen.length === 1 ? { status: 302, headers: { location: `https://${MOCK_DOWNLOAD_HOST}/opaque?signature=fixture` } } :
      { status: 200, headers: { 'content-type': 'application/zip' }, body: Buffer.from('zip') };
  });
  await t.downloadArtifact('202', c);
  assert.ok(seen[0].headers.Authorization); assert.equal(Object.hasOwn(seen[1].headers, 'Authorization'), false);
});
for (const location of ['http://siteflow-artifacts.invalid/zip', 'https://evil.invalid/zip',
  'https://127.0.0.1/zip', 'https://169.254.169.254/zip', 'https://api.github.com/zip',
  'https://user:pass@siteflow-artifacts.invalid/zip', 'https://siteflow-artifacts.invalid:444/zip']) {
  test(`危険なredirectを拒否: ${new URL(location).hostname}`, async () => {
    await assert.rejects(client(async () => ({ status: 302, headers: { location } })).downloadArtifact('202', c), /MOCK_HTTP_REJECTED/);
  });
}
test('2回目のredirectと巨大ZIPを拒否', async () => {
  for (const second of [{ status: 302, headers: { location: `https://${MOCK_DOWNLOAD_HOST}/again` } },
    { status: 200, headers: { 'content-type': 'application/zip' }, body: Buffer.alloc(131073) }]) {
    let count = 0;
    await assert.rejects(client(async () => ++count === 1 ? { status: 302, headers: { location: `https://${MOCK_DOWNLOAD_HOST}/zip` } } : second).downloadArtifact('202', c));
  }
});
test('厳密UTF-8・重複キー・深いJSON・BOM・不正構文を拒否', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{"x":1,"x":2}'),
    Buffer.from('{"x":1,"\\u0078":2}'), Buffer.from('['.repeat(33) + '0' + ']'.repeat(33)),
    Buffer.from('\ufeff{}'), Buffer.from('{')]) assert.throws(() => decodeStrictJson(bytes), /JSON_REJECTED/);
  assert.deepEqual(decodeStrictJson(Buffer.from('{"nested":{"a":1},"a":2}')), { nested: { a: 1 }, a: 2 });
});
