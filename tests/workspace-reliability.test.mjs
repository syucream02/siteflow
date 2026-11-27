import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, request, message, resultUnknown, invalidateRequests, REQUEST_TIMEOUT_MS } from '../components/siteflow/workspace-api.ts';
import { sameSelection } from '../components/siteflow/draft-guard.ts';

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.window; });
for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
  test(`HTTP ${status}: status survives and untrusted error text is hidden`, async () => {
    globalThis.fetch = async () => Response.json({ message: 'SENSITIVE_INTERNAL_DETAIL', code: 'EXPECTED_CODE' }, { status });
    await assert.rejects(request('teams/team/projects', undefined, {}), e => e instanceof ApiError && e.status === status && !e.message.includes('SENSITIVE') && e.uncertain === (status >= 500));
  });
}
for (const status of [200, 400, 401, 403, 409, 429, 500]) {
  test(`Malformed JSON ${status}: retains HTTP status and conservative write result`, async () => {
    globalThis.fetch = async () => new Response('<html>INTERNAL</html>', { status });
    await assert.rejects(request('teams/team/projects', undefined, {}), e => e instanceof ApiError && e.status === status && e.kind === 'parse' && e.uncertain === (status === 200 || status >= 500) && !e.message.includes('INTERNAL'));
  });
}
test('network write/read errors are distinguished without automatic retry', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('PRIVATE_URL'); };
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) await assert.rejects(request('teams/t/settings', undefined, {}, method), e => e.kind === 'network' && resultUnknown(e) && !e.message.includes('PRIVATE'));
  await assert.rejects(request('teams/t/settings'), e => e.kind === 'network' && !e.uncertain);
  assert.equal(calls, 5);
});
test('15 second deadline covers stalled fetch and marks write uncertain', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort'))));
  const pending = request('teams/t/settings', undefined, {});
  const rejected = assert.rejects(pending, e => e.kind === 'timeout' && e.uncertain);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS); await rejected;
});
test('deadline covers response body while keeping known HTTP status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = async (_, options) => ({ status: 200, ok: true, json: () => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort')))) });
  const pending = request('teams/t/settings', undefined, {});
  const rejected = assert.rejects(pending, e => e.kind === 'timeout' && e.status === 200 && e.uncertain);
  await Promise.resolve(); t.mock.timers.tick(REQUEST_TIMEOUT_MS); await rejected;
});
test('caller cancellation is not described as DB rollback', async () => {
  const c = new AbortController();
  globalThis.fetch = (_, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(new Error('abort'))));
  const pending = request('teams/t/settings', c.signal, {}); c.abort();
  await assert.rejects(pending, e => e.kind === 'cancelled' && e.uncertain);
});
test('caller cancellation during body parsing preserves status and uncertainty', async () => {
  const c = new AbortController(); let reading;
  const started = new Promise(resolve => { reading = resolve; });
  globalThis.fetch = async (_, o) => ({ status: 200, ok: true, json: () => new Promise((_, reject) => { reading(); o.signal.addEventListener('abort', () => reject(new Error('abort'))); }) });
  const pending = request('teams/t/settings', c.signal, {}); await started; c.abort();
  await assert.rejects(pending, e => e.kind === 'cancelled' && e.status === 200 && e.uncertain);
});
test('malformed 401 still emits expiration, login failure does not', async () => {
  const events = []; globalThis.window = { dispatchEvent: e => events.push(e.type) };
  globalThis.fetch = async () => new Response('bad', { status: 401 });
  await assert.rejects(request('teams/t/settings')); assert.deepEqual(events, ['siteflow-session-expired']);
  await assert.rejects(request('auth/sign-in/email', undefined, {})); assert.equal(events.length, 1);
});
test('membership loss invalidates delayed team responses but operation denial does not', async () => {
  const events = []; globalThis.window = { dispatchEvent: e => events.push(e.type) };
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = request('teams/t/projects');
  globalThis.fetch = async () => Response.json({ code: 'TEAM_ACCESS_DENIED' }, { status: 403 });
  await assert.rejects(request('teams/t/settings')); finish(Response.json({ items: ['PRIVATE'] }));
  await assert.rejects(pending, e => e.kind === 'cancelled'); assert.deepEqual(events, ['siteflow-team-access-denied']);
  globalThis.fetch = async () => Response.json({ code: 'MEETING_ACCESS_DENIED' }, { status: 403 });
  await assert.rejects(request('teams/t/meetings')); assert.equal(events.length, 1);
});
test('session invalidation prevents prior account data returning', async () => {
  let finish; globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = request('teams/t/projects'); invalidateRequests(); finish(Response.json({ items: ['OLD_ACCOUNT'] }));
  await assert.rejects(pending, e => e.kind === 'cancelled');
});
test('safe fallback never displays arbitrary exceptions', () => {
  assert.ok(!message(new Error('PRIVATE_SQL')).includes('PRIVATE_SQL'));
});
test('assignee selection ignores order and rejects a missing or duplicate person', () => {
  assert.equal(sameSelection(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameSelection(['a', 'b'], ['a']), false);
  assert.equal(sameSelection(['a', 'b'], ['a', 'a']), false);
});
