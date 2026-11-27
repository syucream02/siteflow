import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebApiHandler } from '../examples/mysql/web-api-handler.ts';
import { escapeSearchLiteral } from '../examples/mysql/project-search.ts';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const teamId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const projectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function fixture({ session = true, member = true, cursor = true } = {}) {
  const calls = [];
  const row = { id: projectId, name: '架空の橋梁', code: null, dueDate: new Date('2026-12-01'), progress: 20, status: 'IN_PROGRESS', archivedAt: null, version: 1, primaryParticipant: { id: userId, user: { name: '架空の担当' } } };
  const project = {
    findFirst: async input => { calls.push(['cursor', input]); return cursor ? row : null; },
    count: async input => { calls.push(['count', input]); return input.where.AND ? 2 : 5; },
    findMany: async input => { calls.push(['list', input]); const value = { ...row, archivedAt: input.where.AND[0].AND[0].archivedAt ? new Date('2026-11-24') : null }; return [value, { ...value, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }]; },
  };
  const prisma = {
    teamMembership: { findUnique: async () => member ? { userId, teamId, role: 'member', team: { id: teamId, name: '架空チーム' } } : null },
    $transaction: async (body, options) => { calls.push(['transaction', options]); return body({ project }); },
  };
  const handler = createWebApiHandler({ prisma, origin: 'http://127.0.0.1:5000', host: '127.0.0.1:5000', getSession: async () => session ? { user: { id: userId } } : null, authHandler: async () => new Response(null, { status: 404 }) });
  const call = (query = '', collection = 'projects') => handler(new Request(`http://127.0.0.1:5000/api/teams/${teamId}/${collection}${query ? '?' + query : ''}`, { headers: { Host: '127.0.0.1:5000' } }));
  return { call, calls };
}
test('模擬API: 一覧・件数・カーソルは同じ条件と現在所属で制限する', async () => {
  const { call, calls } = fixture();
  const response = await call(`limit=1&q=%25_%5C&status=IN_PROGRESS&primaryUserId=${userId}&supportUserId=${userId}&progressMin=0&progressMax=40&cursor=${projectId}`);
  assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.total, 2); assert.equal(data.collectionTotal, 5); assert.equal(data.items.length, 1); assert.equal(data.page.hasMore, true);
  const where = calls.find(x => x[0] === 'count')[1].where;
  const scope = where.AND[0]; assert.equal(scope.teamId, teamId); assert.equal(scope.archivedAt, null);
  assert.equal(scope.team.teammemberships.some.userId, userId);
  assert.deepEqual(where.AND[1], { OR: [{ name: { contains: '\\%\\_\\\\' } }, { code: { contains: '\\%\\_\\\\' } }] });
  assert.deepEqual(where.AND[2], { primaryParticipant: { teamId, userId } });
  assert.deepEqual(where.AND[3], { supportMembers: { some: { teamId, participant: { teamId, userId } } } });
  assert.deepEqual(where.AND[4], { status: 'IN_PROGRESS' }); assert.deepEqual(where.AND[5], { progress: { gte: 0, lte: 40 } });
  assert.deepEqual(calls.find(x => x[0] === 'cursor')[1].where.AND, [where, { id: projectId }]);
  const list = calls.find(x => x[0] === 'list')[1]; assert.deepEqual(list.where.AND[0], where); assert.equal(list.take, 2);
  assert.deepEqual(calls[0], ['transaction', { isolationLevel: 'RepeatableRead' }]);
});
test('模擬API: 通常と保管を同時には検索しない', async () => {
  const { call, calls } = fixture(); assert.equal((await call('', 'archived-projects')).status, 200);
  assert.deepEqual(calls.find(x => x[0] === 'count')[1].where.AND[0].archivedAt, { not: null });
});
for (const [label, settings, query, code] of [
  ['未ログイン', { session: false }, '', 401], ['所属なし', { member: false }, '', 403],
  ['不正条件', {}, 'unknown=x', 400], ['他条件のカーソル', { cursor: false }, 'cursor=' + projectId, 400],
]) test(`模擬API: ${label}は一覧・総件数を取得しない`, async () => {
  const { call, calls } = fixture(settings); assert.equal((await call(query)).status, code);
  assert.equal(calls.filter(x => ['count', 'list'].includes(x[0])).length, 0);
});
test('LIKEの記号だけをエスケープし、日本語・引用符を変更しない', () => {
  assert.equal(escapeSearchLiteral("橋梁 O'Reilly%_\\"), "橋梁 O'Reilly\\%\\_\\\\");
});
