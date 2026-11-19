import test from 'node:test';
import assert from 'node:assert/strict';
import { canArchiveProject, parseProjectArchiveInput, planProjectArchiveChange } from '../lib/siteflow/domain.ts';

test('保管・復元は現在のチーム管理者か主担当に限り、副担当だけでは許可しない', () => {
  const membership = { userId: 'actor', teamId: 'team', role: 'member' };
  assert.equal(canArchiveProject('actor', 'team', membership, { primaryUserId: 'actor' }), true);
  assert.equal(canArchiveProject('actor', 'team', { ...membership, role: 'admin' }, { primaryUserId: 'other' }), true);
  assert.equal(canArchiveProject('actor', 'team', membership, { primaryUserId: 'other' }), false);
  assert.equal(canArchiveProject('actor', 'team', null, { primaryUserId: 'actor' }), false);
  assert.equal(canArchiveProject('actor', 'other-team', { ...membership, role: 'admin' }, { primaryUserId: 'actor' }), false);
});

test('アーカイブは版だけ、復元は版と任意の主副担当セットを検証する', () => {
  assert.deepEqual(parseProjectArchiveInput({ expectedVersion: 1 }, 'archive'), { expectedVersion: 1, archived: true });
  assert.deepEqual(parseProjectArchiveInput({ expectedVersion: 2147483646 }, 'restore'), { expectedVersion: 2147483646, archived: false });
  const input = Object.freeze({ expectedVersion: 1, primaryUserId: 'ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF', supportUserIds: Object.freeze([]) });
  assert.deepEqual(parseProjectArchiveInput(input, 'restore').assignees, { primaryUserId: input.primaryUserId.toLowerCase(), supportUserIds: [] });
  assert.equal(input.primaryUserId, 'ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF');
});
test('不正な版・追加属性・復元の片方だけの担当や重複と、アーカイブでの担当指定を拒否する', () => {
  for (const action of ['archive', 'restore']) for (const input of [null, [], {}, { expectedVersion: '1' }, { expectedVersion: 0 }, { expectedVersion: 2147483647 }, { expectedVersion: 1, archivedAt: null }, { expectedVersion: 1, status: 'DONE' }]) assert.equal(parseProjectArchiveInput(input, action), null);
  const body = { expectedVersion: 1, primaryUserId: '10000000-0000-4000-8000-000000000001', supportUserIds: [] };
  assert.equal(parseProjectArchiveInput(body, 'archive'), null);
  assert.equal(parseProjectArchiveInput({ expectedVersion: 1, primaryUserId: body.primaryUserId }, 'restore'), null);
  assert.equal(parseProjectArchiveInput({ expectedVersion: 1, supportUserIds: [] }, 'restore'), null);
  assert.equal(parseProjectArchiveInput({ ...body, supportUserIds: [body.primaryUserId] }, 'restore'), null);
});
test('アーカイブと復元は同じ状態なら変更なし、通常案件の担当だけの変更は拒否する', () => {
  for (const current of [true, false]) for (const archived of [true, false]) assert.deepEqual(planProjectArchiveChange(current, { expectedVersion: 1, archived }), { ok: true, changed: current !== archived });
  assert.deepEqual(planProjectArchiveChange(false, { expectedVersion: 1, archived: false, assignees: { primaryUserId: 'a', supportUserIds: [] } }), { ok: false, code: 'PROJECT_NOT_ARCHIVED' });
});
import { parseChangeProjectStatusInput } from '../lib/siteflow/domain.ts';
import { availableProjectStatusTargets, planProjectStatusChange, projectStatuses } from '../lib/siteflow/domain.ts';

test('画面の状態候補は業務判定と一致し、受け取った配列を変えても遷移表を壊さない', () => {
  for (const status of projectStatuses) {
    const candidates = availableProjectStatusTargets(status);
    const permitted = projectStatuses.filter(next => next !== status && planProjectStatusChange({ status, progress: 100 }, { expectedVersion: 1, status: next, comment: '架空の再開理由' }).ok);
    assert.deepEqual([...candidates].sort(), [...permitted].sort());
    candidates.push(status);
    assert.equal(availableProjectStatusTargets(status).includes(status), false);
  }
});

test('案件状態の全25通りで許可・拒否と変更なしを検証し、元の状態を変えない', () => {
  const allowed = { NOT_STARTED: ['IN_PROGRESS', 'ON_HOLD'], IN_PROGRESS: ['REVIEW', 'ON_HOLD'], REVIEW: ['IN_PROGRESS', 'ON_HOLD', 'DONE'], ON_HOLD: ['IN_PROGRESS'], DONE: ['IN_PROGRESS'] };
  for (const from of projectStatuses) for (const to of projectStatuses) {
    const current = Object.freeze({ status: from, progress: 100 });
    const result = planProjectStatusChange(current, { expectedVersion: 1, status: to, comment: from === 'DONE' && to !== from ? '再開の理由' : null });
    assert.equal(result.ok, from === to || allowed[from].includes(to), `${from} -> ${to}`);
    if (result.ok) { assert.equal(result.changed, from !== to); assert.equal(result.reopening, from === 'DONE' && to !== from); }
    assert.deepEqual(current, { status: from, progress: 100 });
  }
});
test('確認待ちからの完了には100％が必要で、100％でも進行中から直接完了できない', () => {
  for (const progress of [0, 99]) assert.deepEqual(planProjectStatusChange({ status: 'REVIEW', progress }, { expectedVersion: 1, status: 'DONE', comment: null }), { ok: false, code: 'PROGRESS_REQUIRED_FOR_COMPLETION' });
  assert.deepEqual(planProjectStatusChange({ status: 'IN_PROGRESS', progress: 100 }, { expectedVersion: 1, status: 'DONE', comment: null }), { ok: false, code: 'INVALID_STATUS_TRANSITION' });
});
test('完了から進行中への再開は理由が必要で、進捗100％を変更しない', () => {
  const current = Object.freeze({ status: 'DONE', progress: 100 });
  for (const comment of [null, '', '　 ']) assert.deepEqual(planProjectStatusChange(current, { expectedVersion: 1, status: 'IN_PROGRESS', comment }), { ok: false, code: 'REOPEN_REASON_REQUIRED' });
  assert.deepEqual(planProjectStatusChange(current, { expectedVersion: 1, status: 'IN_PROGRESS', comment: '追加作業' }), { ok: true, changed: true, reopening: true });
  assert.equal(current.progress, 100);
});
test('同じ状態はメモなしなら変更なし、メモ単独保存は拒否する', () => {
  assert.deepEqual(planProjectStatusChange({ status: 'REVIEW', progress: 40 }, { expectedVersion: 1, status: 'REVIEW', comment: null }), { ok: true, changed: false, reopening: false });
  assert.deepEqual(planProjectStatusChange({ status: 'REVIEW', progress: 40 }, { expectedVersion: 1, status: 'REVIEW', comment: 'メモ' }), { ok: false, code: 'COMMENT_WITHOUT_STATUS_CHANGE' });
});

test('案件の状態入力は5種類を受け付け、版とメモを検証して元入力を保持する', () => {
  for (const status of ['NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'ON_HOLD', 'DONE']) {
    const input = Object.freeze({ expectedVersion: 1, status, comment: '　変更理由\n続き　' });
    assert.deepEqual(parseChangeProjectStatusInput(input), { expectedVersion: 1, status, comment: '変更理由\n続き' });
    assert.equal(input.comment, '　変更理由\n続き　');
  }
  assert.deepEqual(parseChangeProjectStatusInput({ expectedVersion: 2147483646, status: 'DONE' }), { expectedVersion: 2147483646, status: 'DONE', comment: null });
});
test('案件の状態入力は不正な状態・版・メモと進捗や本人などの追加属性を拒否する', () => {
  const valid = { expectedVersion: 1, status: 'IN_PROGRESS' };
  for (const input of [null, [], {}, { ...valid, status: 'done' }, { ...valid, status: null }, { ...valid, expectedVersion: '1' },
    { ...valid, expectedVersion: 0 }, { ...valid, expectedVersion: 2147483647 }, { ...valid, comment: 'あ'.repeat(2001) }, { ...valid, comment: '\u0000' },
    { ...valid, progress: 100 }, { ...valid, userId: 'other' }, { ...valid, changedAt: '2026-11-15' }]) assert.equal(parseChangeProjectStatusInput(input), null);
});
import { parseUpdateProjectProgressInput, planProjectProgressUpdate } from '../lib/siteflow/domain.ts';

test('進捗は0〜100の整数、任意メモは整形し入力を変更しない', () => {
  for (const progress of [0, 1, 99, 100]) assert.deepEqual(parseUpdateProjectProgressInput({ expectedVersion: 1, progress }), { expectedVersion: 1, progress, comment: null });
  const input = Object.freeze({ expectedVersion: 2147483646, progress: 40, comment: '　説明\n続き　' });
  assert.equal(parseUpdateProjectProgressInput(input).comment, '説明\n続き'); assert.equal(input.comment, '　説明\n続き　');
  assert.equal(parseUpdateProjectProgressInput({ expectedVersion: 1, progress: 40, comment: '😀'.repeat(2000) }).comment.length, 4000);
  assert.equal(parseUpdateProjectProgressInput({ expectedVersion: 1, progress: 40, comment: '　 ' }).comment, null);
});
test('進捗の小数・範囲外・型違い・版不正・余分な属性や不正メモを拒否する', () => {
  const valid = { expectedVersion: 1, progress: 40 };
  for (const progress of [undefined, null, '40', -1, 101, 0.5, NaN, Infinity]) assert.equal(parseUpdateProjectProgressInput({ ...valid, progress }), null);
  for (const expectedVersion of [undefined, '1', 0, -1, 1.5, Infinity, 2147483647]) assert.equal(parseUpdateProjectProgressInput({ ...valid, expectedVersion }), null);
  for (const extra of [{ comment: 1 }, { comment: 'あ'.repeat(2001) }, { comment: '\u0000' }, { status: 'DONE' }, { userId: 'x' }, { previousProgress: 0 }, { changedAt: '2026-11-15' }]) assert.equal(parseUpdateProjectProgressInput({ ...valid, ...extra }), null);
  for (const value of [null, [], {}, '40']) assert.equal(parseUpdateProjectProgressInput(value), null);
});
test('進捗変更は100でも自動完了せず、減少と保留/確認待ちでも状態を保持する', () => {
  for (const status of ['NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'ON_HOLD']) {
    const current = Object.freeze({ progress: 40, status });
    for (const progress of [0, 100]) assert.deepEqual(planProjectProgressUpdate(current, { expectedVersion: 1, progress, comment: null }), { ok: true, changed: true });
    assert.deepEqual(current, { progress: 40, status });
  }
});
test('同じ進捗は書き込まず、メモだけの保存と完了済みの変更を拒否する', () => {
  assert.deepEqual(planProjectProgressUpdate({ progress: 40, status: 'IN_PROGRESS' }, { expectedVersion: 1, progress: 40, comment: null }), { ok: true, changed: false });
  assert.deepEqual(planProjectProgressUpdate({ progress: 40, status: 'IN_PROGRESS' }, { expectedVersion: 1, progress: 40, comment: 'メモ' }), { ok: false, code: 'COMMENT_WITHOUT_PROGRESS_CHANGE' });
  assert.deepEqual(planProjectProgressUpdate({ progress: 100, status: 'DONE' }, { expectedVersion: 1, progress: 40, comment: null }), { ok: false, code: 'PROJECT_COMPLETED' });
  assert.deepEqual(planProjectProgressUpdate({ progress: 100, status: 'DONE' }, { expectedVersion: 1, progress: 100, comment: null }), { ok: true, changed: false });
});
import { parseChangeProjectAssigneesInput, diffProjectAssignees } from '../lib/siteflow/domain.ts';
import { canEditProject, parseEditProjectInput, canCreateProject, parseCreateProjectInput, canCreateTeam, parseCreateTeamInput, parseListPageQuery, canReadTeam, changeStatus, validateIssue, isOverdue, completionRate } from '../lib/siteflow/domain.ts';

test('基本編集は指定項目だけを整え、省略項目と元入力を保持する', () => {
  const input = Object.freeze({ expectedVersion: 1, name: '  案件  ', notes: '　 ' });
  assert.deepEqual(parseEditProjectInput(input), { expectedVersion: 1, changes: { name: '案件', notes: null } });
  assert.equal(input.notes, '　 ');
  assert.deepEqual(parseEditProjectInput({ expectedVersion: 2147483646, dueDate: '2024-02-29', code: null }),
    { expectedVersion: 2147483646, changes: { dueDate: '2024-02-29', code: null } });
});
test('基本編集は空変更・不正な版・日付・長さ・制御文字・担当や状態の変更を拒否する', () => {
  for (const expectedVersion of [undefined, null, '1', 0, -1, 1.5, NaN, Infinity, 2147483647]) {
    assert.equal(parseEditProjectInput({ expectedVersion, name: '案件' }), null);
  }
  for (const changes of [{}, { name: null }, { name: undefined }, { name: '' }, { name: 'a'.repeat(201) },
    { dueDate: '2026-02-29' }, { dueDate: null }, { code: 'a\nb' }, { notes: 'a'.repeat(2001) },
    { progress: 100 }, { status: 'DONE' }, { primaryUserId: projectInput.primaryUserId }, { version: 2 }, { teamId: 'x' }]) {
    assert.equal(parseEditProjectInput({ expectedVersion: 1, ...changes }), null);
  }
});
test('編集は現在の管理者・主担当・副担当に許可し、単なる作成者や元所属者は拒否する', () => {
  const assignment = Object.freeze({ primaryUserId: 'primary', supportUserIds: Object.freeze(['support']) });
  for (const userId of ['primary', 'support', 'creator']) {
    assert.equal(canEditProject(userId, 't', { userId, teamId: 't', role: 'member' }, assignment), userId !== 'creator');
    assert.equal(canEditProject(userId, 't', { userId, teamId: 't', role: 'admin' }, assignment), true);
    assert.equal(canEditProject(userId, 't', null, assignment), false);
    assert.equal(canEditProject(userId, 't', { userId, teamId: 'other', role: 'admin' }, assignment), false);
    assert.equal(canEditProject(userId, 't', { userId: 'different', teamId: 't', role: 'admin' }, assignment), false);
    assert.equal(canEditProject(userId, 't', { userId, teamId: 't', role: 'owner' }, assignment), false);
  }
});
const issue = { id:'SF-001', projectId:'p1', title:'確認', location:'橋脚A', assignee:'山田 太郎', dueDate:'2026-10-01', priority:'normal', description:'', status:'open', response:'', history:[] };
const projectInput = { name: ' 架空の案件 ', dueDate: '2024-02-29', primaryUserId: '10000000-0000-4000-8000-000000000001' };

test('担当一覧の置換は主担当・副担当・版を必須にし、IDを正規化する', () => {
  const primaryUserId = 'ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF';
  const input = Object.freeze({ expectedVersion: 1, primaryUserId, supportUserIds: Object.freeze([projectInput.primaryUserId]) });
  assert.deepEqual(parseChangeProjectAssigneesInput(input), { expectedVersion: 1, primaryUserId: primaryUserId.toLowerCase(), supportUserIds: [projectInput.primaryUserId] });
  assert.equal(input.primaryUserId, primaryUserId);
  assert.deepEqual(parseChangeProjectAssigneesInput({ expectedVersion: 2147483646, primaryUserId, supportUserIds: [] }).supportUserIds, []);
  const supportUserIds = Array.from({ length: 50 }, (_, i) => `20000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
  assert.equal(parseChangeProjectAssigneesInput({ expectedVersion: 1, primaryUserId, supportUserIds }).supportUserIds.length, 50);
});
test('担当置換は欠落・重複・主副重複・不正な版・追加属性を拒否する', () => {
  const valid = { expectedVersion: 1, primaryUserId: projectInput.primaryUserId, supportUserIds: [] };
  for (const input of [null, [], {}, { ...valid, supportUserIds: undefined }, { ...valid, primaryUserId: null },
    { ...valid, expectedVersion: '1' }, { ...valid, expectedVersion: 0 }, { ...valid, expectedVersion: 1.5 }, { ...valid, expectedVersion: 2147483647 },
    { ...valid, supportUserIds: [valid.primaryUserId] }, { ...valid, supportUserIds: ['not-uuid'] }, { ...valid, supportUserIds: Array(51).fill(valid.primaryUserId) },
    { ...valid, supportUserIds: ['ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF', 'abcdefab-1234-4567-89ab-abcdefabcdef'] },
    { ...valid, name: 'other' }, { ...valid, changedByUserId: valid.primaryUserId }, { ...valid, history: [] }]) assert.equal(parseChangeProjectAssigneesInput(input), null);
});
test('担当差分は主担当交代と副担当の追加・解除だけを返し、順番や元入力を変えない', () => {
  const before = Object.freeze({ primaryUserId: 'a', supportUserIds: Object.freeze(['b', 'c']) });
  const next = Object.freeze({ primaryUserId: 'b', supportUserIds: Object.freeze(['a', 'd']) });
  assert.deepEqual(diffProjectAssignees(before, next), { primaryChanged: true, addedUserIds: ['a', 'd'], removedUserIds: ['b', 'c'] });
  assert.deepEqual(diffProjectAssignees(before, { primaryUserId: 'a', supportUserIds: ['c', 'b'] }), { primaryChanged: false, addedUserIds: [], removedUserIds: [] });
  assert.deepEqual(before.supportUserIds, ['b', 'c']); assert.deepEqual(next.supportUserIds, ['a', 'd']);
});
test('案件登録は入力を変えずに名前とIDを整え、任意項目の既定値を作る', () => {
  const input = Object.freeze({ ...projectInput });
  assert.deepEqual(parseCreateProjectInput(input), { ...projectInput, name: '架空の案件', supportUserIds: [], code: null, summary: null, clientName: null, notes: null });
  assert.equal(input.name, ' 架空の案件 ');
  assert.equal(parseCreateProjectInput({ ...input, dueDate: '1000-01-01' }).dueDate, '1000-01-01');
  assert.equal(parseCreateProjectInput({ ...input, dueDate: '9999-12-31' }).dueDate, '9999-12-31');
});
test('案件名と任意項目・副担当50人の上限を受け付け、改行は長文項目だけに許可する', () => {
  const supportUserIds = Array.from({ length: 50 }, (_, i) => `20000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
  const parsed = parseCreateProjectInput({ ...projectInput, name: '😀'.repeat(200), code: 'a'.repeat(100), clientName: 'あ'.repeat(200), summary: 's'.repeat(2000), notes: 'n'.repeat(2000), supportUserIds });
  assert.equal(parsed.supportUserIds.length, 50);
  assert.equal(parseCreateProjectInput({ ...projectInput, summary: '一行目\n二行目', notes: '\tメモ\r\n続き' }).summary, '一行目\n二行目');
  assert.equal(parseCreateProjectInput({ ...projectInput, code: '  ', notes: null }).code, null);
});
test('不正日付・長さ・制御文字と、作成者や初期状態などの上書きを拒否する', () => {
  for (const dueDate of ['2026-02-29', '2026-04-31', '0000-01-01', '0999-12-31', '2026-1-01', '2026-01-01T00:00:00Z']) assert.equal(parseCreateProjectInput({ ...projectInput, dueDate }), null);
  for (const patch of [{ name: ' ' }, { name: 'a'.repeat(201) }, { code: 'a'.repeat(101) }, { clientName: 'a'.repeat(201) }, { summary: 'a'.repeat(2001) }, { notes: 'a'.repeat(2001) }, { name: '改\n行' }, { code: '改\t行' }, { notes: 'a\u0000b' }, { progress: 0 }, { status: 'NOT_STARTED' }, { createdByUserId: projectInput.primaryUserId }, { version: 1 }]) assert.equal(parseCreateProjectInput({ ...projectInput, ...patch }), null);
  for (const input of [null, [], {}, '案件', { ...projectInput, primaryUserId: 'bad' }]) assert.equal(parseCreateProjectInput(input), null);
});
test('副担当の形式・重複・主担当との重複を大文字小文字の違いも含めて拒否する', () => {
  const other = 'abcdefab-1234-4567-89ab-abcdefabcdef';
  for (const supportUserIds of [null, 'bad', ['bad'], [other, other.toUpperCase()], [projectInput.primaryUserId], Array(51).fill(other)]) assert.equal(parseCreateProjectInput({ ...projectInput, supportUserIds }), null);
  assert.deepEqual(parseCreateProjectInput({ ...projectInput, supportUserIds: [other.toUpperCase()] }).supportUserIds, [other]);
});
test('案件作成は対象チームのadmin/memberだけに許可し、編集権限とは分ける', () => {
  for (const role of ['admin', 'member']) assert.equal(canCreateProject('u', 't', { userId: 'u', teamId: 't', role }), true);
  assert.equal(canCreateProject('u', 't', null), false);
  assert.equal(canCreateProject('u', 't', { userId: 'u', teamId: 'other', role: 'admin' }), false);
  assert.equal(canCreateProject('u', 't', { userId: 'other', teamId: 't', role: 'admin' }), false);
});
test('チーム名は前後の空白を除き1〜80コードポイントを受け付け、入力は変えない', () => {
  const input = Object.freeze({ name: '　架空チーム　' });
  assert.deepEqual(parseCreateTeamInput(input), { name: '架空チーム' });
  assert.equal(input.name, '　架空チーム　');
  for (const name of ['あ', 'あ'.repeat(80), '😀'.repeat(80)]) assert.deepEqual(parseCreateTeamInput({ name }), { name });
});
test('チーム名の空・過長・制御文字と、作成者やrole等の追加指定を拒否する', () => {
  for (const input of [null, [], {}, 'name', { name: 1 }, { name: '　 ' }, { name: 'あ'.repeat(81) }, { name: '改\n行' }, { name: 'a\u0000b' }, { name: 'a\u007fb' }, { name: 'チーム', role: 'admin' }, { name: 'チーム', userId: 'other' }]) {
    assert.equal(parseCreateTeamInput(input), null);
  }
});
test('チーム作成にはメール認証済みの利用者が必要', () => {
  assert.equal(canCreateTeam({ emailVerified: true }), true);
  assert.equal(canCreateTeam({ emailVerified: false }), false);
  assert.equal(canCreateTeam(null), false);
});
test('業務フローの飛び越しを拒否する', () => { assert.throws(() => changeStatus(issue, 'done', '2026-09-30T00:00:00Z')); });
test('対応内容がない確認依頼を拒否する', () => { assert.throws(() => changeStatus({...issue,status:'in_progress',response:'  '},'review','2026-09-30T00:00:00Z')); });

test('確認待ちの対応内容を空にした場合は完了を拒否し、元データと履歴を変更しない', () => {
  for (const response of ['', ' \t\n　']) {
    const current = { ...issue, status: 'review', response, history: [{ label: '確認待ち', at: '2026-09-30T00:00:00Z' }] };
    const before = structuredClone(current);

    assert.throws(
      () => changeStatus(current, 'done', '2026-09-30T01:00:00Z'),
      { message: '完了の前に対応内容を入力してください。' },
    );
    assert.deepEqual(current, before);
  }
});
test('対応と確認を経て完了し、元データを変更しない', () => { let current=changeStatus(issue,'in_progress','2026-09-30T00:00:00Z'); current=changeStatus({...current,response:'現地確認済み'},'review','2026-09-30T00:00:00Z'); current=changeStatus(current,'done','2026-09-30T00:00:00Z'); assert.equal(current.status,'done'); assert.equal(current.history.length,3); assert.equal(issue.status,'open'); assert.equal(issue.history.length,0); });
test('確認待ちから差し戻せる', () => { assert.equal(changeStatus({...issue,status:'review'},'in_progress','2026-09-30T00:00:00Z').status,'in_progress'); });
test('期限当日は超過ではなく、完了済みも超過に含めない', () => { assert.equal(isOverdue(issue,'2026-10-01'),false); assert.equal(isOverdue(issue,'2026-10-02'),true); assert.equal(isOverdue({...issue,status:'done'},'2026-10-02'),false); });
test('存在しない日付と空白の件名を拒否する', () => { assert.ok(validateIssue({...issue,dueDate:'2026-02-30'})); assert.ok(validateIssue({...issue,title:'  '})); assert.equal(validateIssue(issue),null); });
test('指摘0件は0%、完了件数から率を算出する', () => { assert.equal(completionRate([]),0); assert.equal(completionRate([issue,{...issue,status:'done'}]),50); });

test('現在の所属が本人と対象チームに一致すればadminとmemberはチーム情報を読める', () => {
  for (const role of ['admin', 'member']) {
    const membership = Object.freeze({ userId: 'user-a', teamId: 'team-a', role });
    assert.equal(canReadTeam('user-a', 'team-a', membership), true);
    assert.deepEqual(membership, { userId: 'user-a', teamId: 'team-a', role });
  }
});

test('所属がない・別チーム・別人の場合はチーム情報を読めない', () => {
  assert.equal(canReadTeam('user-a', 'team-a', null), false);
  assert.equal(canReadTeam('user-a', 'team-a', { userId: 'user-a', teamId: 'team-b', role: 'admin' }), false);
  assert.equal(canReadTeam('user-a', 'team-a', { userId: 'user-b', teamId: 'team-a', role: 'admin' }), false);
});

test('未対応の役割はチーム情報の閲覧も許可しない', () => {
  for (const role of ['owner', '', 'admin,member']) {
    assert.equal(canReadTeam('user-a', 'team-a', { userId: 'user-a', teamId: 'team-a', role }), false);
  }
});

test('案件一覧は既定20件、1〜50件を許可し、UUIDのカーソルを読む', () => {
  assert.deepEqual(parseListPageQuery({}), { limit: 20 });
  for (const limit of ['1', '50']) assert.equal(parseListPageQuery({ limit }).limit, Number(limit));
  const input = Object.freeze({ limit: '3', cursor: 'ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF' });
  assert.deepEqual(parseListPageQuery(input), { limit: 3, cursor: input.cursor.toLowerCase() });
  assert.equal(input.cursor, 'ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF');
});

test('案件一覧は範囲外・空・小数・指数・余分な文字や不正なカーソルを拒否する', () => {
  for (const limit of ['0', '51', '-1', '', '1.5', '1e1', ' 2', '02', '2x', '999999999999999999999']) {
    assert.equal(parseListPageQuery({ limit }), null);
  }
  for (const cursor of ['', 'not-a-uuid', '../team', 'abcdefab-1234-4567-89ab-abcdefabcdef ']) {
    assert.equal(parseListPageQuery({ cursor }), null);
  }
});
