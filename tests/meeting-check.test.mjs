import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

describe('専用MySQLとHTTPで会議の保存・権限・競合を検証', { skip: process.env.SITEFLOW_MEETING_CHECK !== '1', concurrency: false }, () => {
  let api, data, outsider, cookie;
  const collection = () => `teams/${data.teamIds[0]}/meetings`;
  const call = (path, method = 'GET', body, headers = {}) => fetch(api.origin + '/api/' + path, { method,
    headers: { Cookie: cookie, ...(method !== 'GET' ? { Origin: api.origin, 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const start = async (facilitatorUserId = null) => { const response = await call(collection(), 'POST', { facilitatorUserId }); assert.equal(response.status, 201); return (await response.json()).meeting.id; };
  const read = async id => { const response = await call(`${collection()}/${id}`); assert.equal(response.status, 200); return (await response.json()).meeting; };
  const act = (id, body) => call(`${collection()}/${id}`, 'PATCH', body);
  before(async () => {
    const { startAuthCheckServer } = await import('../examples/mysql/auth-check.ts');
    const { createLocalWorkspaceData } = await import('../examples/mysql/local-workspace-data.ts');
    api = await startAuthCheckServer(0); data = await createLocalWorkspaceData(api.prisma); outsider = await createLocalWorkspaceData(api.prisma);
    const response = await call('auth/sign-in/email', 'POST', { email: data.email, password: data.password }); assert.equal(response.status, 200);
    cookie = response.headers.getSetCookie().find(value => value.includes('session_token=')).split(';')[0];
  });
  after(async () => {
    const { removeLocalWorkspaceData } = await import('../examples/mysql/local-workspace-data.ts');
    try { if (data) await removeLocalWorkspaceData(api.prisma, data); if (outsider) await removeLocalWorkspaceData(api.prisma, outsider); } finally { if (api) await api.close(); }
  });
  it('通常一覧20件の次ページを含む21件を対象にし、開始時は確認記録を作らない', async () => {
    const id = await start(), meeting = await read(id);
    assert.deepEqual(meeting.counts, { total: 21, confirmed: 0, unconfirmed: 21 });
    assert.equal(meeting.entries.every(entry => entry.confirmation === null), true);
    assert.equal(await api.prisma.meetingConfirmation.count({ where: { entry: { meetingId: id } } }), 0);
  });
  it('保管を除外し、開始後に増えた案件は同じ会議へ混ぜない', async () => {
    await api.prisma.project.update({ where: { id: data.projectIds[20] }, data: { archivedAt: new Date() } });
    try { const id = await start(); assert.equal((await read(id)).counts.total, 20);
      await api.prisma.project.update({ where: { id: data.projectIds[20] }, data: { archivedAt: null } });
      assert.equal((await read(id)).counts.total, 20);
    } finally { await api.prisma.project.update({ where: { id: data.projectIds[20] }, data: { archivedAt: null } }); }
  });
  it('確認時の最新値を保存し、以後の進捗更新と再取得で書き換えない', async () => {
    const id = await start(), entry = (await read(id)).entries[0];
    await api.prisma.project.update({ where: { id: entry.projectId }, data: { progress: 40, status: 'IN_PROGRESS', version: { increment: 1 } } });
    assert.equal((await act(id, { action: 'confirm', expectedVersion: 1, entryId: entry.id })).status, 200);
    await api.prisma.project.update({ where: { id: entry.projectId }, data: { progress: 60, version: { increment: 1 } } });
    const resumed = await read(id), saved = resumed.entries[0];
    assert.equal(saved.confirmation.progress, 40); assert.equal(saved.confirmation.status, 'IN_PROGRESS'); assert.equal(saved.project.progress, 60);
    assert.ok(saved.confirmation.confirmedAt); assert.equal(saved.confirmation.confirmedByNameSnapshot, 'ローカル体験ユーザー');
    assert.equal(resumed.counts.confirmed, 1);
    assert.equal((await act(id, { action: 'confirm', expectedVersion: 2, entryId: entry.id })).status, 200);
    assert.equal((await read(id)).version, 2); assert.equal(await api.prisma.meetingConfirmation.count({ where: { entryId: entry.id } }), 1);
  });
  it('取消記録を残し、再確認は最新値の新しい記録として保存', async () => {
    const id = await start(), entry = (await read(id)).entries[0];
    await act(id, { action: 'confirm', expectedVersion: 1, entryId: entry.id });
    assert.equal((await act(id, { action: 'unconfirm', expectedVersion: 2, entryId: entry.id })).status, 200);
    assert.equal((await read(id)).entries[0].confirmation, null);
    const old = await api.prisma.meetingConfirmation.findFirstOrThrow({ where: { entryId: entry.id } });
    assert.ok(old.revokedAt); assert.ok(old.revokedByParticipantId); assert.ok(old.revokedByNameSnapshot);
    await api.prisma.project.update({ where: { id: entry.projectId }, data: { progress: 73, version: { increment: 1 } } });
    await act(id, { action: 'confirm', expectedVersion: 3, entryId: entry.id });
    const resumed = await read(id); assert.equal(resumed.entries[0].confirmation.progress, 73); assert.equal(resumed.entries[0].auditCount, 2);
  });
  it('未確認の終了は明示確認が必要で、終了後の確認・取消・進行役変更を拒否', async () => {
    const id = await start(), entry = (await read(id)).entries[0];
    assert.equal((await act(id, { action: 'finish', expectedVersion: 1, allowUnconfirmed: false })).status, 409);
    assert.equal((await read(id)).version, 1);
    assert.equal((await act(id, { action: 'finish', expectedVersion: 1, allowUnconfirmed: true })).status, 200);
    const ended = await read(id); assert.ok(ended.endedAt); assert.equal(ended.counts.unconfirmed, 21);
    for (const body of [{ action: 'confirm', entryId: entry.id }, { action: 'unconfirm', entryId: entry.id }, { action: 'facilitator', facilitatorUserId: null }]) assert.equal((await act(id, { expectedVersion: 2, ...body })).status, 409);
    const next = await read(await start()); assert.equal(next.counts.confirmed, 0);
  });
  it('指定された進行役以外は管理者でも進行できず、進行役は交代・解除できる', async () => {
    await api.prisma.teamMembership.create({ data: { id: randomUUID(), userId: outsider.userId, teamId: data.teamIds[0], role: 'member', createdAt: new Date() } });
    const id = await start(outsider.userId), meeting = await read(id);
    assert.equal(meeting.canOperate, false);
    assert.equal((await act(id, { action: 'confirm', expectedVersion: 1, entryId: meeting.entries[0].id })).status, 403);
    const own = await start(data.userId);
    assert.equal((await act(own, { action: 'facilitator', expectedVersion: 1, facilitatorUserId: null })).status, 200);
    assert.equal((await read(own)).facilitator, null);
    await api.prisma.teamMembership.update({ where: { teamId_userId: { teamId: data.teamIds[0], userId: data.userId } }, data: { role: 'member' } });
    assert.equal((await read(own)).canOperate, true);
    assert.equal((await act(own, { action: 'facilitator', expectedVersion: 2, facilitatorUserId: outsider.userId })).status, 200);
    assert.equal((await read(own)).canOperate, false);
    await api.prisma.teamMembership.update({ where: { teamId_userId: { teamId: data.teamIds[0], userId: data.userId } }, data: { role: 'admin' } });
    await api.prisma.teamMembership.delete({ where: { teamId_userId: { teamId: data.teamIds[0], userId: outsider.userId } } });
    assert.equal((await call(collection(), 'POST', { facilitatorUserId: outsider.userId })).status, 400);
  });
  it('同時確認は1回だけ成功し、古い版を409にして二重記録しない', async () => {
    const id = await start(), entry = (await read(id)).entries[0];
    const responses = await Promise.all([1, 2].map(() => act(id, { action: 'confirm', expectedVersion: 1, entryId: entry.id })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(await api.prisma.meetingConfirmation.count({ where: { entryId: entry.id } }), 1);
  });
  it('会議の最後の版更新が失敗したら、先に保存した確認記録も戻す', async () => {
    const { actOnMeetingForUser } = await import('../examples/mysql/meeting-service.ts');
    const id = await start(), entry = (await read(id)).entries[0];
    const broken = api.prisma.$extends({ query: { meeting: { async updateMany() { throw Error('test-only-final-save-failure'); } } } });
    await assert.rejects(actOnMeetingForUser(broken, data.userId, data.teamIds[0], id, { action: 'confirm', expectedVersion: 1, entryId: entry.id }));
    assert.equal(await api.prisma.meetingConfirmation.count({ where: { entryId: entry.id } }), 0);
    assert.equal((await read(id)).version, 1);
  });
  it('別チーム・別会議の対象ID、未認証、Origin偽装、入力改ざんを拒否', async () => {
    const id = await start(), other = await start(), foreignEntry = (await read(other)).entries[0];
    assert.equal((await act(id, { action: 'confirm', expectedVersion: 1, entryId: foreignEntry.id })).status, 404);
    assert.equal((await call(`teams/${outsider.teamIds[0]}/meetings`)).status, 403);
    assert.equal((await call(`teams/${data.teamIds[1]}/meetings/${id}`)).status, 404);
    assert.equal((await call(collection(), 'GET', undefined, { Cookie: '' })).status, 401);
    assert.equal((await call(collection(), 'POST', {}, { Origin: 'https://example.invalid' })).status, 403);
    assert.equal((await call(collection(), 'POST', { projectIds: [] })).status, 400);
    assert.equal((await act(id, { action: 'confirm', expectedVersion: 1, entryId: foreignEntry.id, progress: 100 })).status, 400);
    assert.equal((await call(`${collection()}/${id}?limit=1`)).status, 400);
    assert.equal((await call(`${collection()}/${id}`, 'DELETE')).status, 405);
    assert.equal((await call(`teams/${data.teamIds[1]}/meetings`, 'POST', {})).status, 409);
    // APIを通さない誤関連付けも、チームを含むDB外部キーで拒否する。
    for (const input of [
      { teamId: outsider.teamIds[0], meetingId: id, projectId: outsider.projectIds[0] },
      { teamId: data.teamIds[0], meetingId: id, projectId: outsider.projectIds[0] },
    ]) await assert.rejects(api.prisma.meetingProject.create({ data: { id: randomUUID(), ...input, position: 999, nameSnapshot: '拒否される架空の関連' } }), error => error.code === 'P2003');
  });
  it('会議一覧をページ分割し、他チームのカーソルを受け付けない', async () => {
    const page = await (await call(collection() + '?limit=2')).json(); assert.equal(page.items.length, 2); assert.equal(page.page.hasMore, true);
    const second = await (await call(collection() + '?limit=2&cursor=' + page.page.nextCursor)).json();
    assert.equal(second.items.some(item => page.items.some(previous => item.id === previous.id)), false);
    assert.equal((await call(collection() + '?cursor=' + randomUUID())).status, 400);
    assert.equal((await call(collection() + '?limit=2&limit=2')).status, 400);
  });
  it('対象501件は切り捨てず拒否して、会議も途中作成しない', async () => {
    const source = await api.prisma.project.findUniqueOrThrow({ where: { id: data.projectIds[0] } });
    const ids = Array.from({ length: 480 }, () => randomUUID());
    const before = await api.prisma.meeting.count({ where: { teamId: data.teamIds[0] } });
    try {
      await api.prisma.project.createMany({ data: ids.map(id => ({ id, teamId: data.teamIds[0], name: '上限検証の架空案件', dueDate: source.dueDate,
        primaryParticipantId: source.primaryParticipantId, createdByParticipantId: source.createdByParticipantId, createdByNameSnapshot: source.createdByNameSnapshot })) });
      const response = await call(collection(), 'POST', {}); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'MEETING_TARGET_COUNT');
      assert.equal(await api.prisma.meeting.count({ where: { teamId: data.teamIds[0] } }), before);
    } finally { await api.prisma.project.deleteMany({ where: { id: { in: ids } } }); }
  });
});
