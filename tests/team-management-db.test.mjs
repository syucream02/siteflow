import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

describe('チーム・所属・招待：専用MySQLと実HTTP', { skip: process.env.SITEFLOW_TEAM_CHECK !== '1', concurrency: false }, () => {
  let api, owner, peer, ownerCookie, peerCookie; const extraUsers = [];
  const call = (path, method = 'GET', body, cookie = ownerCookie, extraHeaders = {}) => fetch(api.origin + '/api/' + path, { method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: api.origin, 'Content-Type': 'application/json' } : {}), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function login(user) { const r = await call('auth/sign-in/email', 'POST', { email: user.email, password: user.password }, null); assert.equal(r.status, 200); return r.headers.getSetCookie().find(v => v.includes('session_token=')).split(';')[0]; }
  async function newTeam() { const r = await call('teams', 'POST', { name: '架空の管理試験 ' + randomUUID() }); assert.equal(r.status, 201); const t = (await r.json()).team; owner.teamIds.push(t.id); return t.id; }
  const version = async id => (await api.prisma.team.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  const mutate = async (id, suffix, body = {}, method = 'POST', cookie = ownerCookie) => call(`teams/${id}${suffix}`, method, { expectedVersion: await version(id), ...body }, cookie);
  async function invite(id, user = peer, cookie = ownerCookie) { const r = await mutate(id, '/invitations', { email: user.email }, 'POST', cookie); assert.equal(r.status, 200); return (await r.json()).invitation; }
  async function join(id, user = peer, cookie = peerCookie) { const i = await invite(id, user); const r = await call(`me/invitations/${i.id}/accept`, 'POST', {}, cookie); assert.equal(r.status, 200); return i; }
  before(async () => {
    const { startAuthCheckServer } = await import('../examples/mysql/auth-check.ts');
    const { createLocalWorkspaceData } = await import('../examples/mysql/local-workspace-data.ts');
    const { readSchemaCheckSettings } = await import('../examples/mysql/schema-check-settings.mjs');
    api = await startAuthCheckServer(0); const [actual] = await api.prisma.$queryRawUnsafe('SELECT DATABASE() db,CURRENT_USER() principal'), s = readSchemaCheckSettings();
    assert.ok(actual.db === s.database && actual.principal.split('@')[0] === s.user, '専用DBだけ');
    owner = await createLocalWorkspaceData(api.prisma); peer = await createLocalWorkspaceData(api.prisma); ownerCookie = await login(owner); peerCookie = await login(peer);
  });
  after(async () => { const { removeLocalWorkspaceData } = await import('../examples/mysql/local-workspace-data.ts');
    try { if (owner) await removeLocalWorkspaceData(api.prisma, owner); if (peer) await removeLocalWorkspaceData(api.prisma, peer); if (extraUsers.length) await api.prisma.user.deleteMany({ where: { id: { in: extraUsers } } }); } finally { if (api) await api.close(); } });
  it('作成APIを再利用し、版番号1・本人管理者・slug不変で改名する', async () => {
    const id = await newTeam(), before = await api.prisma.team.findUniqueOrThrow({ where: { id } }); assert.equal(before.version, 1);
    assert.equal((await mutate(id, '/settings', { name: '改名した架空チーム' }, 'PATCH')).status, 200);
    const after = await api.prisma.team.findUniqueOrThrow({ where: { id } }); assert.equal(after.name, '改名した架空チーム'); assert.equal(after.slug, before.slug); assert.equal(after.version, 2);
    assert.equal((await call(`teams/${id}/settings`, 'PATCH', { name: '古い版', expectedVersion: 1 })).status, 409);
  });
  it('未認証・他チーム・不正本文・Origin・標準Organization入口を拒否する', async () => {
    const id = await newTeam();
    assert.equal((await call(`teams/${id}/settings`, 'GET', undefined, null)).status, 401);
    assert.equal((await call(`teams/${id}/settings`, 'GET', undefined, peerCookie)).status, 403);
    assert.equal((await call(`teams/${id}/settings`, 'PATCH', { name: 'x', expectedVersion: 1 }, ownerCookie, { Origin: 'https://example.invalid' })).status, 403);
    assert.equal((await mutate(id, '/settings', { name: 'x', userId: peer.userId }, 'PATCH')).status, 400);
    assert.equal((await call('auth/organization/remove-member', 'POST', {})).status, 404);
    assert.equal((await call('users?email=probe@example.invalid')).status, 404);
  });
  it('一般メンバーは一覧を読めるが改名・招待・自己昇格・他人解除はできない', async () => {
    const id = await newTeam(); await join(id);
    assert.equal((await call(`teams/${id}/members`, 'GET', undefined, peerCookie)).status, 200);
    for (const [suffix, body, method] of [['/settings', { name: '不可' }, 'PATCH'], ['/invitations', { email: 'no@example.invalid' }, 'POST'], ['/members/' + peer.userId, { role: 'admin' }, 'PATCH'], ['/members/' + owner.userId, {}, 'DELETE']]) {
      assert.equal((await mutate(id, suffix, body, method, peerCookie)).status, 403);
    }
    assert.equal((await mutate(id, '/members/' + peer.userId, { role: 'owner' }, 'PATCH')).status, 400);
  });
  it('登録済みかどうかで招待成功を変えず、アカウントは新規作成しない', async () => {
    const id = await newTeam(); const registered = await invite(id), email = randomUUID() + '@example.invalid', unknown = await invite(id, { email });
    assert.deepEqual(Object.keys(registered).sort(), Object.keys(unknown).sort());
    assert.equal(await api.prisma.user.count({ where: { email } }), 0);
    assert.equal((await mutate(id, '/invitations', { email: peer.email })).status, 409);
    assert.equal((await call(`me/invitations/${registered.id}/accept`, 'POST', {}, ownerCookie)).status, 404);
    assert.equal((await call(`me/invitations/${registered.id}/accept`, 'POST', { email: peer.email }, peerCookie)).status, 400);
    const saved = await api.prisma.invitation.findUniqueOrThrow({ where: { id: registered.id } }); assert.equal(saved.role, 'member'); assert.equal(saved.expiresAt.getTime() - saved.createdAt.getTime(), 7 * 86400000);
  });
  it('本人の現在メール・認証済み状態を照合し、DBのアクセント同一視を信用しない', async () => {
    const id = await newTeam(); peer.email = 'recipient-' + randomUUID() + '@example.invalid'; await api.prisma.user.update({ where: { id: peer.userId }, data: { email: peer.email } });
    const exact = await invite(id), accent = await invite(id, { email: peer.email.replace('recipient', 'récipient') });
    const r = await call('me/invitations?limit=50', 'GET', undefined, peerCookie); const items = (await r.json()).items;
    assert.ok(items.some(i => i.id === exact.id)); assert.equal(items.some(i => i.id === accent.id), false);
    assert.equal((await call(`me/invitations/${accent.id}/accept`, 'POST', {}, peerCookie)).status, 404);
    await api.prisma.user.update({ where: { id: peer.userId }, data: { emailVerified: false } });
    assert.notEqual((await call(`me/invitations/${exact.id}/accept`, 'POST', {}, peerCookie)).status, 200);
    await api.prisma.user.update({ where: { id: peer.userId }, data: { emailVerified: true } });
  });
  it('期限切れ・取消後・辞退後・未知状態を拒否し、再招待は新しい記録にする', async () => {
    const { createTeamInvitation } = await import('../examples/mysql/team-invitation-service.ts');
    const id = await newTeam(); const expired = await createTeamInvitation(api.prisma, owner.userId, id, peer.email, await version(id), new Date(Date.now() - 8 * 86400000)); assert.ok(expired.ok);
    assert.equal((await call(`me/invitations/${expired.invitation.id}/accept`, 'POST', {}, peerCookie)).status, 409);
    const canceled = await invite(id); assert.equal((await mutate(id, '/invitations/' + canceled.id + '/cancel')).status, 200);
    assert.equal((await call(`me/invitations/${canceled.id}/accept`, 'POST', {}, peerCookie)).status, 409);
    const declined = await invite(id); assert.equal((await call(`me/invitations/${declined.id}/decline`, 'POST', {}, peerCookie)).status, 200);
    assert.equal((await call(`me/invitations/${declined.id}/accept`, 'POST', {}, peerCookie)).status, 409);
    const unknown = await invite(id); await api.prisma.invitation.update({ where: { id: unknown.id }, data: { status: 'unknown-legacy' } });
    assert.equal((await call(`me/invitations/${unknown.id}/accept`, 'POST', {}, peerCookie)).status, 409);
  });
  it('同時承認は一方だけ成功し、同じ招待を再利用できない', async () => {
    const id = await newTeam(), i = await invite(id);
    const results = await Promise.all([1, 2].map(() => call(`me/invitations/${i.id}/accept`, 'POST', {}, peerCookie)));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(await api.prisma.teamMembership.count({ where: { teamId: id, userId: peer.userId } }), 1);
  });
  it('承認と取消が競合しても所属と招待の状態が矛盾しない', async () => {
    const id = await newTeam(), i = await invite(id), v = await version(id);
    const results = await Promise.all([call(`me/invitations/${i.id}/accept`, 'POST', {}, peerCookie), call(`teams/${id}/invitations/${i.id}/cancel`, 'POST', { expectedVersion: v })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const saved = await api.prisma.invitation.findUniqueOrThrow({ where: { id: i.id } }), count = await api.prisma.teamMembership.count({ where: { teamId: id, userId: peer.userId } });
    assert.equal(count, saved.status === 'accepted' ? 1 : 0);
  });
  it('最後の管理者の降格・退出・解除を拒否し、同時退出でも1人を保持する', async () => {
    const id = await newTeam(); assert.equal((await mutate(id, '/leave')).status, 409); assert.equal((await mutate(id, '/members/' + owner.userId, { role: 'member' }, 'PATCH')).status, 409);
    assert.equal((await mutate(id, '/members/' + owner.userId, {}, 'DELETE')).status, 409);
    await join(id); assert.equal((await mutate(id, '/members/' + peer.userId, { role: 'admin' }, 'PATCH')).status, 200);
    const v = await version(id), results = await Promise.all([call(`teams/${id}/leave`, 'POST', { expectedVersion: v }), call(`teams/${id}/leave`, 'POST', { expectedVersion: v }, peerCookie)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(await api.prisma.teamMembership.count({ where: { teamId: id, role: 'admin' } }), 1);
  });
  it('降格・解除・退出で発行した保留招待を取消し、他チームとセッションは保つ', async () => {
    const id = await newTeam(); await join(id); await mutate(id, '/members/' + peer.userId, { role: 'admin' }, 'PATCH');
    const i = await invite(id, { email: randomUUID() + '@example.invalid' });
    assert.equal((await mutate(id, '/members/' + owner.userId, { role: 'member' }, 'PATCH', peerCookie)).status, 200);
    assert.equal((await api.prisma.invitation.findUniqueOrThrow({ where: { id: i.id } })).status, 'canceled');
    assert.equal((await mutate(id, '/leave')).status, 200);
    assert.equal((await call(`teams/${id}/settings`)).status, 403);
    assert.equal((await call(`teams/${owner.teamIds[0]}/projects`)).status, 200);
    assert.equal((await call('auth/get-session')).status, 200);
  });
  it('主副担当・進行役・保管案件の未対応事項を全件から検査する', async () => {
    const { startMeetingForUser } = await import('../examples/mysql/meeting-service.ts');
    const { saveMeetingRecord } = await import('../examples/mysql/meeting-record-service.ts');
    const id = await newTeam(); await join(id);
    const p = await call(`teams/${id}/projects`, 'POST', { name: '解除を妨げる案件', dueDate: '2026-12-31', primaryUserId: peer.userId, supportUserIds: [owner.userId] }); assert.equal(p.status, 201); const project = (await p.json()).project;
    const m = await startMeetingForUser(api.prisma, owner.userId, id, peer.userId); assert.ok(m.ok);
    const entry = await api.prisma.meetingProject.findFirstOrThrow({ where: { meetingId: m.meeting.id } });
    assert.ok((await saveMeetingRecord(api.prisma, peer.userId, id, m.meeting.id, { action: 'create_action', entryId: entry.id, expectedVersion: 1, content: '未対応事項', assigneeUserId: peer.userId, dueDate: null })).ok);
    let check = await (await call(`teams/${id}/members/${peer.userId}/removal-check`)).json(); assert.deepEqual(check.blockers.counts, { projects: 1, meetings: 1, actions: 1 });
    assert.equal((await mutate(id, '/members/' + peer.userId, {}, 'DELETE')).status, 409);
    await api.prisma.project.update({ where: { id: project.id }, data: { archivedAt: new Date() } });
    check = await (await call(`teams/${id}/members/${peer.userId}/removal-check`)).json(); assert.equal(check.blockers.counts.projects, 0); assert.equal(check.blockers.counts.actions, 1);
  });
  it('担当者追加と所属解除が競合しても両方を確定しない', async () => {
    const id = await newTeam(); await join(id); const v = await version(id);
    const results = await Promise.all([call(`teams/${id}/projects`, 'POST', { name: '競合案件', dueDate: '2026-12-31', primaryUserId: peer.userId, supportUserIds: [] }),
      call(`teams/${id}/members/${peer.userId}`, 'DELETE', { expectedVersion: v })]);
    assert.ok((results[0].status === 201 && results[1].status === 409) || (results[0].status === 400 && results[1].status === 200));
    assert.equal((await api.prisma.project.count({ where: { teamId: id } })) + (await api.prisma.teamMembership.count({ where: { teamId: id, userId: peer.userId } })), results[0].status === 201 ? 2 : 0);
  });
  it('所属解除で過去記録を変えず、再参加は人物を再利用し旧管理者権限を復活させない', async () => {
    const { startMeetingForUser, actOnMeetingForUser } = await import('../examples/mysql/meeting-service.ts'); const { saveMeetingRecord } = await import('../examples/mysql/meeting-record-service.ts');
    const id = await newTeam(); await join(id); await mutate(id, '/members/' + peer.userId, { role: 'admin' }, 'PATCH');
    const p = await call(`teams/${id}/projects`, 'POST', { name: '過去記録用', dueDate: '2026-12-31', primaryUserId: peer.userId, supportUserIds: [] }); const project = (await p.json()).project;
    const m = await startMeetingForUser(api.prisma, owner.userId, id, owner.userId), entry = await api.prisma.meetingProject.findFirstOrThrow({ where: { meetingId: m.meeting.id } });
    await saveMeetingRecord(api.prisma, owner.userId, id, m.meeting.id, { action: 'save_notes', entryId: entry.id, expectedVersion: 1, consultation: '保存する過去メモ', decision: '決定' });
    await saveMeetingRecord(api.prisma, owner.userId, id, m.meeting.id, { action: 'create_action', entryId: entry.id, expectedVersion: 2, content: '完了事項', assigneeUserId: peer.userId, dueDate: null });
    const a = await api.prisma.meetingActionItem.findFirstOrThrow({ where: { teamId: id } });
    await saveMeetingRecord(api.prisma, owner.userId, id, m.meeting.id, { action: 'update_action', entryId: entry.id, expectedVersion: 3, actionId: a.id, itemVersion: 1, content: a.content, assigneeUserId: peer.userId, dueDate: null, status: 'DONE' });
    await actOnMeetingForUser(api.prisma, owner.userId, id, m.meeting.id, { action: 'finish', expectedVersion: 4, allowUnconfirmed: true });
    await api.prisma.project.update({ where: { id: project.id }, data: { progress: 100, status: 'DONE' } });
    const before = { person: await api.prisma.teamParticipant.findUniqueOrThrow({ where: { teamId_userId: { teamId: id, userId: peer.userId } } }), note: await api.prisma.meetingProjectNote.findFirst({ where: { teamId: id } }), snapshot: await api.prisma.meetingActionSnapshot.findFirst({ where: { teamId: id } }), history: await api.prisma.projectAssignmentHistory.findMany({ where: { teamId: id } }) };
    assert.equal((await mutate(id, '/members/' + peer.userId, {}, 'DELETE')).status, 200); await join(id);
    assert.equal((await api.prisma.teamMembership.findUniqueOrThrow({ where: { teamId_userId: { teamId: id, userId: peer.userId } } })).role, 'member');
    assert.deepEqual(await api.prisma.teamParticipant.findUniqueOrThrow({ where: { teamId_userId: { teamId: id, userId: peer.userId } } }), before.person);
    assert.deepEqual(await api.prisma.meetingProjectNote.findFirst({ where: { teamId: id } }), before.note); assert.deepEqual(await api.prisma.meetingActionSnapshot.findFirst({ where: { teamId: id } }), before.snapshot); assert.deepEqual(await api.prisma.projectAssignmentHistory.findMany({ where: { teamId: id } }), before.history);
  });
  it('本体版の保存失敗なら所属作成と招待承認も全取消になる', async () => {
    const { answerTeamInvitation } = await import('../examples/mysql/team-invitation-service.ts'); const id = await newTeam(), i = await invite(id), v = await version(id);
    const failing = { invitation: api.prisma.invitation, $transaction: (callback, options) => api.prisma.$transaction(tx => callback(new Proxy(tx, { get(t, key) { return key === 'team' ? { ...t.team, update: async () => { throw new Error('TEST_TEAM_WRITE_FAILURE'); } } : Reflect.get(t, key); } })), options) };
    await assert.rejects(answerTeamInvitation(failing, peer.userId, i.id, 'accept'), /TEST_TEAM_WRITE_FAILURE/);
    assert.equal(await api.prisma.teamMembership.count({ where: { teamId: id, userId: peer.userId } }), 0); assert.equal((await api.prisma.invitation.findUniqueOrThrow({ where: { id: i.id } })).status, 'pending'); assert.equal(await version(id), v);
  });
  it('20件超のメンバーと招待を取得でき、画面外の管理者も解除判定に含める', async () => {
    const id = await newTeam(), users = Array.from({ length: 24 }, () => ({ id: randomUUID(), name: '架空の一覧候補', emailVerified: true })); extraUsers.push(...users.map(u => u.id));
    await api.prisma.user.createMany({ data: users.map(u => ({ ...u, email: u.id + '@example.invalid' })) }); await api.prisma.teamMembership.createMany({ data: users.map(u => ({ id: randomUUID(), teamId: id, userId: u.id, role: 'member', createdAt: new Date() })) });
    const first = await (await call(`teams/${id}/members`)).json(), second = await (await call(`teams/${id}/members?cursor=${first.page.nextCursor}`)).json(); assert.equal(first.items.length, 20); assert.equal(second.items.length, 5);
    const nextAdmin = [...first.items, ...second.items].filter(m => m.userId !== owner.userId).at(-1); assert.equal((await mutate(id, '/members/' + nextAdmin.userId, { role: 'admin' }, 'PATCH')).status, 200);
    for (let n = 0; n < 21; n++) await invite(id, { email: `${randomUUID()}@example.invalid` });
    const invites = await (await call(`teams/${id}/invitations`)).json(); assert.equal(invites.items.length, 20); assert.equal(invites.page.hasMore, true);
    assert.equal((await mutate(id, '/leave')).status, 200);
  });
  it('不在進行役を検出するが管理者が通常会議操作を代行・自動復旧しない', async () => {
    const { startMeetingForUser } = await import('../examples/mysql/meeting-service.ts'); const id = await newTeam(); await join(id);
    await call(`teams/${id}/projects`, 'POST', { name: '不在の検出用', dueDate: '2026-12-31', primaryUserId: owner.userId, supportUserIds: [] });
    const m = await startMeetingForUser(api.prisma, owner.userId, id, peer.userId); await api.prisma.teamMembership.delete({ where: { teamId_userId: { teamId: id, userId: peer.userId } } });
    const settings = await (await call(`teams/${id}/settings`)).json(); assert.equal(settings.orphanedCount, 1);
    assert.equal((await call(`teams/${id}/meetings/${m.meeting.id}`, 'PATCH', { action: 'facilitator', expectedVersion: 1, facilitatorUserId: owner.userId })).status, 403);
    assert.equal((await api.prisma.meeting.findUniqueOrThrow({ where: { id: m.meeting.id } })).version, 1);
  });
  it('管理者の退出と他の管理者による解除でも、発行済み保留招待を取消す', async () => {
    for (const leave of [true, false]) {
      const id = await newTeam(); await join(id); await mutate(id, '/members/' + peer.userId, { role: 'admin' }, 'PATCH');
      const issued = await invite(id, { email: randomUUID() + '@example.invalid' });
      const response = leave ? await mutate(id, '/leave') : await mutate(id, '/members/' + owner.userId, {}, 'DELETE', peerCookie);
      assert.equal(response.status, 200); assert.equal((await api.prisma.invitation.findUniqueOrThrow({ where: { id: issued.id } })).status, 'canceled');
    }
  });
  it('ロック待ちの間に期限切れになった招待を承認しない', async () => {
    const { Prisma } = await import('../examples/mysql/generated/integrated/client.ts');
    const id = await newTeam(), i = await invite(id);
    await api.prisma.invitation.update({ where: { id: i.id }, data: { expiresAt: new Date(Date.now() + 300) } });
    let ready, release; const locked = new Promise(r => { ready = r; }), released = new Promise(r => { release = r; });
    const holder = api.prisma.$transaction(async tx => { await tx.$queryRaw(Prisma.sql`SELECT userId FROM TeamMembership WHERE teamId=${id} ORDER BY userId FOR UPDATE`); ready(); await released; });
    await locked;
    try { const response = call(`me/invitations/${i.id}/accept`, 'POST', {}, peerCookie); await new Promise(r => setTimeout(r, 600)); release(); await holder;
      assert.equal((await response).status, 409);
      assert.equal(await api.prisma.teamMembership.count({ where: { teamId: id, userId: peer.userId } }), 0);
      assert.equal((await api.prisma.invitation.findUniqueOrThrow({ where: { id: i.id } })).status, 'pending');
    } finally { release(); await holder; }
  });
});
