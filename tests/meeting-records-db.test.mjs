import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

describe('会議の相談・決定・引き継ぎ：専用MySQLと実HTTP', { skip: process.env.SITEFLOW_MEETING_RECORDS_CHECK !== '1', concurrency: false }, () => {
  let api, data, outsider, cookie;
  const collection = () => `teams/${data.teamIds[0]}/meetings`;
  const call = (path, method = 'GET', body, override = cookie) => fetch(api.origin + '/api/' + path, { method,
    headers: { ...(override ? { Cookie: override } : {}), ...(method !== 'GET' ? { Origin: api.origin, 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function meeting(facilitatorUserId = data.userId) {
    const response = await call(collection(), 'POST', { facilitatorUserId }); assert.equal(response.status, 201);
    const id = (await response.json()).meeting.id;
    return read(id);
  }
  async function read(id) { const r = await call(`${collection()}/${id}`); assert.equal(r.status, 200); return (await r.json()).meeting; }
  async function records(m, candidates = false, query = '') {
    const r = await call(`${collection()}/${m.id}/entries/${m.entries[0].id}/${candidates ? 'carry-candidates' : 'records'}${query}`);
    assert.equal(r.status, 200); return r.json();
  }
  const patch = (m, extra) => call(`${collection()}/${m.id}`, 'PATCH', { expectedVersion: m.version, entryId: m.entries[0].id, ...extra });
  async function apply(m, extra, expected = 200) { const r = await patch(m, extra); assert.equal(r.status, expected); return read(m.id); }
  async function create(m, content = '現地で寸法を確認する', assigneeUserId = data.userId) {
    const next = await apply(m, { action: 'create_action', content, assigneeUserId, dueDate: '2026-12-31' });
    return { m: next, item: (await records(next)).items.find(item => item.content === content) };
  }
  async function finish(m) { const r = await call(`${collection()}/${m.id}`, 'PATCH', { action: 'finish', expectedVersion: m.version, allowUnconfirmed: true }); assert.equal(r.status, 200); return read(m.id); }
  before(async () => {
    const { startAuthCheckServer } = await import('../examples/mysql/auth-check.ts');
    const { createLocalWorkspaceData } = await import('../examples/mysql/local-workspace-data.ts');
    const { readSchemaCheckSettings } = await import('../examples/mysql/schema-check-settings.mjs');
    api = await startAuthCheckServer(0);
    const [target] = await api.prisma.$queryRawUnsafe('SELECT DATABASE() AS db, CURRENT_USER() AS principal');
    const settings = readSchemaCheckSettings();
    assert.ok(target.db === settings.database && target.principal.split('@')[0] === settings.user, '専用DBと専用ユーザーのみ');
    data = await createLocalWorkspaceData(api.prisma); outsider = await createLocalWorkspaceData(api.prisma);
    const r = await call('auth/sign-in/email', 'POST', { email: data.email, password: data.password }); assert.equal(r.status, 200);
    cookie = r.headers.getSetCookie().find(value => value.includes('session_token=')).split(';')[0];
  });
  after(async () => {
    const { removeLocalWorkspaceData } = await import('../examples/mysql/local-workspace-data.ts');
    try { if (data) await removeLocalWorkspaceData(api.prisma, data); if (outsider) await removeLocalWorkspaceData(api.prisma, outsider); } finally { if (api) await api.close(); }
  });
  it('初回は記録なし。相談・決定の保存・編集・版管理と終了後の不変性', async () => {
    let m = await meeting(); assert.equal((await records(m)).note, null);
    m = await apply(m, { action: 'save_notes', consultation: '相談A', decision: '決定B' });
    const first = (await records(m)).note; assert.ok(first.createdByNameSnapshot); assert.equal(m.version, 2);
    m = await apply(m, { action: 'save_notes', consultation: '相談C', decision: '' });
    const saved = (await records(m)).note; assert.equal(saved.createdAt, first.createdAt); assert.equal(saved.consultation, '相談C');
    m = await finish(m); await apply(m, { action: 'save_notes', consultation: '上書き禁止', decision: '' }, 409);
    assert.deepEqual((await records(m)).note, saved);
  });
  it('本体と会議記録を分離し、対応完了でも案件進捗を自動変更しない', async () => {
    let { m, item } = await create(await meeting()); const project = m.entries[0].project;
    m = await apply(m, { action: 'update_action', actionId: item.actionId, itemVersion: item.itemVersion, content: '寸法を確認した', assigneeUserId: data.userId, dueDate: null, status: 'DONE' });
    item = (await records(m)).items[0]; assert.equal(item.status, 'DONE');
    assert.equal(m.entries[0].project.progress, project.progress); assert.equal(m.entries[0].project.status, project.status);
    await apply(m, { action: 'update_action', actionId: item.actionId, itemVersion: item.itemVersion, content: '復活禁止', assigneeUserId: data.userId, dueDate: null, status: 'OPEN' }, 409);
  });
  it('未認証・他チーム・進行役以外・別会議のentryを拒否', async () => {
    const m = await meeting();
    assert.equal((await call(`${collection()}/${m.id}`, 'PATCH', { action: 'save_notes', expectedVersion: 1, entryId: m.entries[0].id, consultation: '', decision: '' }, null)).status, 401);
    assert.equal((await call(`teams/${outsider.teamIds[0]}/meetings/${m.id}`)).status, 403);
    await api.prisma.teamMembership.create({ data: { id: randomUUID(), teamId: data.teamIds[0], userId: outsider.userId, role: 'member', createdAt: new Date() } });
    const denied = await meeting(outsider.userId);
    await apply(denied, { action: 'save_notes', consultation: '管理者でも不可', decision: '' }, 403);
    const other = await meeting(); await apply(m, { action: 'save_notes', entryId: other.entries[0].id, consultation: '', decision: '' }, 404);
  });
  it('未対応を選択して引き継ぎ、重複・元記録の偽造を拒否する', async () => {
    const { m: initial, item } = await create(await meeting(), '選択引き継ぎ'); const closed = await finish(initial);
    const saved = await records(closed); let next = await meeting();
    assert.equal((await records(next)).items.length, 0);
    const candidate = (await records(next, true)).items.find(row => row.actionId === item.actionId); assert.ok(candidate);
    await apply(next, { action: 'carry_action', actionId: item.actionId, itemVersion: 1, sourceSnapshotId: randomUUID(), assigneeUserId: data.userId }, 409);
    next = await apply(next, { action: 'carry_action', actionId: item.actionId, itemVersion: 1, sourceSnapshotId: candidate.sourceSnapshotId, assigneeUserId: data.userId });
    const copied = (await records(next)).items[0]; assert.equal(copied.sourceMeetingId, closed.id); assert.equal(copied.sourceEntryId, closed.entries[0].id);
    await apply(next, { action: 'carry_action', actionId: item.actionId, itemVersion: 1, sourceSnapshotId: candidate.sourceSnapshotId, assigneeUserId: data.userId }, 409);
    next = await apply(next, { action: 'update_action', actionId: item.actionId, itemVersion: 1, content: '完了', assigneeUserId: data.userId, dueDate: null, status: 'DONE' });
    assert.deepEqual(await records(closed), saved);
    assert.equal((await records(await meeting(), true)).items.some(row => row.actionId === item.actionId), false);
  });
  it('取消済みの古い元記録を再採用して復活させない', async () => {
    let { m, item } = await create(await meeting(), '取消対象');
    m = await apply(m, { action: 'update_action', actionId: item.actionId, itemVersion: 1, content: item.content, assigneeUserId: data.userId, dueDate: null, status: 'CANCELLED' });
    m = await finish(m); const target = await meeting();
    await apply(target, { action: 'carry_action', actionId: item.actionId, itemVersion: 2, sourceSnapshotId: (await records(m)).items[0].id, assigneeUserId: data.userId }, 409);
  });
  it('同じ本体を扱う複数会議の更新を検出し、明示的な再確認まで終了できない', async () => {
    let { m, item } = await create(await meeting(), '同時会議用'); m = await finish(m);
    let a = await meeting(), b = await meeting();
    const sourceSnapshotId = (await records(m)).items[0].id;
    a = await apply(a, { action: 'carry_action', actionId: item.actionId, itemVersion: 1, sourceSnapshotId, assigneeUserId: data.userId });
    b = await apply(b, { action: 'carry_action', actionId: item.actionId, itemVersion: 1, sourceSnapshotId, assigneeUserId: data.userId });
    await apply(a, { action: 'update_action', actionId: item.actionId, itemVersion: 1, content: '変更後', assigneeUserId: data.userId, dueDate: null, status: 'OPEN' });
    assert.equal((await records(b)).items[0].stale, true);
    await apply(b, { action: 'update_action', actionId: item.actionId, itemVersion: 2, content: '古い会議から上書き', assigneeUserId: data.userId, dueDate: null, status: 'DONE' }, 409);
    const denied = await call(`${collection()}/${b.id}`, 'PATCH', { action: 'finish', expectedVersion: b.version, allowUnconfirmed: true }); assert.equal(denied.status, 409);
    b = await apply(b, { action: 'refresh_action', actionId: item.actionId, itemVersion: 2 }); assert.equal((await records(b)).items[0].content, '変更後');
    await finish(b);
  });
  it('会議終了と更新が同時でも一方だけ成功し、終了後に記録を変更しない', async () => {
    const m = await meeting();
    const results = await Promise.all([patch(m, { action: 'save_notes', consultation: '同時保存', decision: '' }),
      call(`${collection()}/${m.id}`, 'PATCH', { action: 'finish', expectedVersion: 1, allowUnconfirmed: true })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  });
  it('改名しても過去名は保持し、退会担当者を現在の所属者に再割当できる', async () => {
    let { m, item } = await create(await meeting(), '退会担当者用', outsider.userId); m = await finish(m);
    const saved = (await records(m)).items[0].assigneeName;
    await api.prisma.user.update({ where: { id: outsider.userId }, data: { name: '改名後' } });
    await api.prisma.teamMembership.deleteMany({ where: { teamId: data.teamIds[0], userId: outsider.userId } });
    assert.equal((await records(m)).items[0].assigneeName, saved);
    const next = await meeting(), candidate = (await records(next, true)).items.find(row => row.actionId === item.actionId);
    await apply(next, { action: 'carry_action', actionId: item.actionId, itemVersion: 1, sourceSnapshotId: candidate.sourceSnapshotId, assigneeUserId: outsider.userId }, 400);
    const adopted = await apply(next, { action: 'carry_action', actionId: item.actionId, itemVersion: 1, sourceSnapshotId: candidate.sourceSnapshotId, assigneeUserId: data.userId });
    assert.equal((await records(adopted)).items[0].assigneeUserId, data.userId);
    assert.equal((await records(m)).items[0].assigneeName, saved);
  });
  it('対応事項と候補のページ分割を行い、終了済み会議は現在値を返さない', async () => {
    let m = await meeting();
    for (let i = 0; i < 3; i++) ({ m } = await create(m, `ページ分割-${i}`));
    const first = await records(m, false, '?limit=2'); assert.equal(first.items.length, 2); assert.equal(first.page.hasMore, true);
    const second = await records(m, false, '?limit=2&cursor=' + first.page.nextCursor); assert.equal(second.items.length, 1);
    m = await finish(m); assert.equal((await records(m)).items.every(row => row.currentVersion === null && row.currentStatus === null), true);
  });
  it('スナップショット保存途中の例外で本体・会議版も全てロールバック', async () => {
    const { saveMeetingRecord } = await import('../examples/mysql/meeting-record-service.ts');
    const m = await meeting(), before = await api.prisma.meetingActionItem.count({ where: { teamId: data.teamIds[0] } });
    const failing = { $transaction: (callback, options) => api.prisma.$transaction(tx => callback(new Proxy(tx, {
      get(target, key) { return key === 'meetingActionSnapshot' ? { ...target.meetingActionSnapshot, create: async () => { throw new Error('TEST_SNAPSHOT_FAILURE'); } } : Reflect.get(target, key); },
    })), options) };
    await assert.rejects(saveMeetingRecord(failing, data.userId, data.teamIds[0], m.id, { action: 'create_action', entryId: m.entries[0].id, expectedVersion: 1, content: '取消試験', assigneeUserId: data.userId, dueDate: null }), /TEST_SNAPSHOT_FAILURE/);
    assert.equal(await api.prisma.meetingActionItem.count({ where: { teamId: data.teamIds[0] } }), before);
    assert.equal((await read(m.id)).version, 1); assert.equal((await records(m)).items.length, 0);
  });
  it('DBの複合外部キーも別チームの会議記録との関連付けを拒否する', async () => {
    const m = await meeting();
    const person = await api.prisma.teamParticipant.findFirstOrThrow({ where: { teamId: outsider.teamIds[0] } });
    await assert.rejects(api.prisma.meetingProjectNote.create({ data: { id: randomUUID(), teamId: outsider.teamIds[0], entryId: m.entries[0].id,
      consultation: '誤参照', decision: '', createdByParticipantId: person.id, createdByNameSnapshot: '架空', updatedByParticipantId: person.id, updatedByNameSnapshot: '架空' } }));
    assert.equal((await records(m)).note, null);
  });
  it('同じ担当者が改名しても過去名を保ち、新会議には採用時の現在名を記録する', async () => {
    let { m, item } = await create(await meeting(), '改名後も同じ担当者'); m = await finish(m);
    const historical = (await records(m)).items[0];
    await api.prisma.user.update({ where: { id: data.userId }, data: { name: '改名した架空の担当者' } });
    const next = await meeting(), candidate = (await records(next, true)).items.find(row => row.actionId === item.actionId);
    assert.equal(candidate.assigneeName, '改名した架空の担当者');
    const adopted = await apply(next, { action: 'carry_action', actionId: item.actionId, itemVersion: 1, sourceSnapshotId: candidate.sourceSnapshotId, assigneeUserId: data.userId });
    assert.equal((await records(adopted)).items[0].assigneeName, '改名した架空の担当者');
    assert.equal((await records(m)).items[0].assigneeName, historical.assigneeName);
    assert.equal((await records(adopted)).items[0].itemVersion, 2);
  });
});
