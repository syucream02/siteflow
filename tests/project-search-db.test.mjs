import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

// 専用の明示実行だけが接続する。認証情報・API応答全文は出力しない。
describe('案件検索のローカルMySQL・HTTP試験', { skip: process.env.SITEFLOW_SEARCH_CHECK !== '1', concurrency: false }, () => {
  let prisma, api, data, outsider, other, cookie;
  const extraUsers = [];
  let normalIds, archivedId;
  async function call(path, headers = {}) { return fetch(api.origin + '/api/' + path, { headers: { Host: new URL(api.origin).host, Cookie: cookie, ...headers } }); }
  const list = query => call(`teams/${data.teamIds[0]}/projects${query ? '?' + query : ''}`);
  before(async () => {
    const require = createRequire(new URL('../examples/mysql/package.json', import.meta.url));
    const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
    const { PrismaClient } = await import('../examples/mysql/generated/integrated/client.ts');
    const { readSchemaCheckSettings, readSchemaCheckConnectionOptions } = await import('../examples/mysql/schema-check-settings.mjs');
    const { createLocalWorkspaceData } = await import('../examples/mysql/local-workspace-data.ts');
    const { startApiServer } = await import('../examples/mysql/api-server.ts');
    const s = readSchemaCheckSettings();
    prisma = new PrismaClient({ adapter: new PrismaMariaDb({ ...readSchemaCheckConnectionOptions(), connectionLimit: 3, connectTimeout: 3000 }) });
    const actual = await prisma.$queryRawUnsafe('SELECT DATABASE() AS db, CURRENT_USER() AS principal');
    assert.ok(actual[0].db === s.database && actual[0].principal.split('@')[0] === s.user, '検証DB・専用ユーザーの実接続先一致');
    data = await createLocalWorkspaceData(prisma);
    outsider = await createLocalWorkspaceData(prisma);
    normalIds = data.projectIds;
    const names = ['橋梁 100%確認', '橋梁 100X確認', '橋梁 A_B', '橋梁 AXB', '橋梁 C\\D', "橋梁 O'Reilly", '橋梁 通常'];
    for (let i = 0; i < names.length; i++) await prisma.project.update({ where: { id: normalIds[i] }, data: { name: names[i], code: i === 0 ? 'SPECIAL-001' : null, progress: i * 10, status: i === 0 ? 'REVIEW' : 'IN_PROGRESS' } });
    await prisma.project.update({ where: { id: normalIds[19] }, data: { name: '検索 ÉCOLE', code: 'CaseProbe-A' } });
    archivedId = normalIds[20]; await prisma.project.update({ where: { id: archivedId }, data: { archivedAt: new Date(), name: '橋梁 保管', progress: 100, status: 'DONE' } });
    // 2ページ目の検索対象を用意。ユーザーの既存データは変更しない。
    const template = await prisma.project.findUniqueOrThrow({ where: { id: normalIds[7] } });
    for (let i = 0; i < 5; i++) {
      const id = randomUUID(); normalIds.push(id);
      await prisma.project.create({ data: { id, teamId: data.teamIds[0], name: '橋梁 追加' + i, primaryParticipantId: template.primaryParticipantId, createdByParticipantId: template.createdByParticipantId, createdByNameSnapshot: '架空ユーザー', dueDate: new Date('2026-12-31'), progress: 40, status: 'IN_PROGRESS' } });
    }
    other = randomUUID(); extraUsers.push(other);
    await prisma.user.create({ data: { id: other, name: '架空の副担当', email: other + '@example.invalid', emailVerified: true } });
    await prisma.teamMembership.create({ data: { id: randomUUID(), teamId: data.teamIds[0], userId: other, role: 'member', createdAt: new Date() } });
    const participant = await prisma.teamParticipant.create({ data: { teamId: data.teamIds[0], userId: other } });
    await prisma.projectSupportMember.create({ data: { teamId: data.teamIds[0], projectId: normalIds[0], participantId: participant.id } });
    api = await startApiServer({ prisma, authSecret: randomBytes(32).toString('hex'), secureCookies: false, port: 0 });
    const login = await fetch(api.origin + '/api/auth/sign-in/email', { method: 'POST', headers: { Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: data.email, password: data.password }) });
    assert.equal(login.status, 200, '架空アカウントのログイン');
    cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  });
  after(async () => {
    if (prisma) {
      const { removeLocalWorkspaceData } = await import('../examples/mysql/local-workspace-data.ts');
      if (data) await removeLocalWorkspaceData(prisma, data);
      if (outsider) await removeLocalWorkspaceData(prisma, outsider);
      for (const id of extraUsers) await prisma.user.delete({ where: { id } });
      if (api) await api.close(); else await prisma.$disconnect();
    }
  });
  it('名前・番号のOR、条件のAND、0％をMySQLで検索する', async () => {
    for (const [q, expected] of [['100%', 1], ['A_B', 1], ['C\\D', 1], ["O'Reilly", 1], ['SPECIAL-001', 1], ['存在しない', 0]]) {
      const r = await list(new URLSearchParams({ q })); assert.equal(r.status, 200);
      const body = await r.json(); assert.equal(body.total, expected, '文字列をワイルドカードとして扱わない');
    }
    const body = await (await list(new URLSearchParams({ q: '橋梁', primaryUserId: data.userId, supportUserId: other, status: 'REVIEW', progressMin: '0', progressMax: '0' }))).json();
    assert.equal(body.total, 1); assert.equal(body.items[0].id, normalIds[0]);
  });
  it('検索条件付きの総件数・カーソル・通常／保管を分離する', async () => {
    const first = await (await list('limit=2&q=' + encodeURIComponent('橋梁'))).json();
    assert.equal(first.total, 12); assert.equal(first.collectionTotal, 25); assert.equal(first.items.length, 2); assert.equal(first.page.hasMore, true);
    const second = await (await list('limit=2&q=' + encodeURIComponent('橋梁') + '&cursor=' + first.page.nextCursor)).json();
    assert.equal(second.total, first.total); assert.ok(second.items.every(x => !first.items.some(y => y.id === x.id)));
    assert.equal((await list('status=NOT_STARTED&cursor=' + first.items[0].id)).status, 400);
    assert.equal((await list('cursor=' + archivedId)).status, 400);
    const archive = await (await call(`teams/${data.teamIds[0]}/archived-projects?q=${encodeURIComponent('橋梁')}`)).json();
    assert.equal(archive.total, 1); assert.equal(archive.items[0].id, archivedId);
  });
  it('他チームの情報・担当条件・カーソル・未ログインを拒否する', async () => {
    assert.equal((await call(`teams/${outsider.teamIds[0]}/projects?q=x`)).status, 403);
    assert.equal((await list('cursor=' + outsider.projectIds[0])).status, 400);
    const none = await (await list('primaryUserId=' + outsider.userId)).json(); assert.equal(none.total, 0); assert.equal(none.items.length, 0);
    assert.equal((await call(`teams/${data.teamIds[0]}/projects`, { Cookie: '' })).status, 401);
    assert.equal((await list('progressMin=101')).status, 400);
    assert.equal((await list('q=a&q=b')).status, 400);
  });
  it('空チームと検索0件を区別する', async () => {
    const empty = await (await call(`teams/${data.teamIds[1]}/projects?q=x`)).json(); assert.equal(empty.total, 0); assert.equal(empty.collectionTotal, 0);
    const filtered = await (await list('q=not-found')).json(); assert.equal(filtered.total, 0); assert.equal(filtered.collectionTotal, 25);
  });
  it('実列のunicode_ci照合順序で大小・アクセントを同一視する', async () => {
    const columns = await prisma.$queryRawUnsafe("SELECT COLUMN_NAME AS fieldName, COLLATION_NAME AS collationName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Project' AND COLUMN_NAME IN ('name','code')");
    assert.equal(columns.length, 2);
    assert.ok(columns.every(column => column.collationName === 'utf8mb4_unicode_ci'), '既存ローカル検証列の照合順序');
    for (const q of ['ECOLE', 'école', 'ecole', 'caseprobe-a']) {
      const result = await (await list(new URLSearchParams({ q }))).json();
      assert.equal(result.total, 1); assert.equal(result.items[0].id, normalIds[19]);
    }
  });
  it('所属失効後は件数も取得できない', async () => {
    const key = { teamId_userId: { teamId: data.teamIds[0], userId: data.userId } };
    const saved = await prisma.teamMembership.findUniqueOrThrow({ where: key });
    await prisma.teamMembership.delete({ where: key });
    try { assert.equal((await list('q=x')).status, 403); }
    finally { await prisma.teamMembership.create({ data: saved }); }
  });
});
