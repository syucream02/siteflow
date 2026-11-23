import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunMeeting, compareMeetingProgress, parseMeetingAction, parseStartMeetingInput } from '../lib/siteflow/domain.ts';
const entryId = '1bfeb235-081e-4bfc-8ae5-65c93bedbe00';

const value = (progress, status = 'IN_PROGRESS') => ({ progress, status });
for (const [previous, current, delta] of [[40, 60, 20], [60, 40, -20], [40, 40, 0], [0, 100, 100], [100, 0, -100]]) {
  test(`会議差分 ${previous}→${current} は${delta}ポイント`, () => {
    const result = compareMeetingProgress(value(previous), value(current), null, false);
    assert.equal(result.deltaPoints, delta);
    assert.equal(result.progressChanged, delta !== 0);
    assert.equal(result.statusChanged, false);
  });
}
test('前回記録なしを0％とみなさず、状態だけの変更を区別する', () => {
  assert.equal(compareMeetingProgress(null, value(50), null, false).deltaPoints, null);
  const result = compareMeetingProgress(value(50), value(50, 'REVIEW'), null, false);
  assert.equal(result.deltaPoints, 0); assert.equal(result.progressChanged, false); assert.equal(result.statusChanged, true);
});
test('会議中の確認後の変更は値か状態で判定し、確認値を変更しない', () => {
  const confirmed = Object.freeze(value(40));
  assert.equal(compareMeetingProgress(value(20), value(60), confirmed, false).changedAfterConfirmation, true);
  assert.equal(compareMeetingProgress(value(20), value(40, 'REVIEW'), confirmed, false).changedAfterConfirmation, true);
  assert.equal(compareMeetingProgress(value(20), value(40), confirmed, false).changedAfterConfirmation, false);
  assert.equal(confirmed.progress, 40);
});
test('終了済みは確認値との比較を固定し、現在値を混ぜない', () => {
  const result = compareMeetingProgress(value(20), value(90), value(40), true);
  assert.equal(result.source, 'confirmation'); assert.equal(result.value.progress, 40);
  assert.equal(result.deltaPoints, 20); assert.equal(result.changedAfterConfirmation, false);
});
test('未確認で終了した案件は当時の値や差分を捏造しない', () => {
  const result = compareMeetingProgress(value(20), value(90), null, true);
  assert.equal(result.source, 'unconfirmed'); assert.equal(result.value, null); assert.equal(result.deltaPoints, null);
  assert.equal(result.progressChanged, false); assert.equal(result.statusChanged, false);
});
test('進行役なしなら所属者全員、指定ありなら本人だけ進行可能', () => {
  const member = { userId: 'u', teamId: 't', role: 'member' };
  assert.equal(canRunMeeting('u', 't', member, null), true);
  assert.equal(canRunMeeting('u', 't', member, 'u'), true);
  assert.equal(canRunMeeting('u', 't', { ...member, role: 'admin' }, 'other'), false);
  assert.equal(canRunMeeting('u', 'other', member, null), false);
  assert.equal(canRunMeeting('u', 't', null, null), false);
});
test('会議開始で本人が送った役割や対象一覧を信用しない', () => {
  assert.deepEqual(parseStartMeetingInput({}), { facilitatorUserId: null });
  assert.deepEqual(parseStartMeetingInput({ facilitatorUserId: 'u' }), { facilitatorUserId: 'u' });
  for (const body of [null, [], { role: 'admin' }, { projectIds: [entryId] }, { facilitatorUserId: '' }, { facilitatorUserId: 1 }]) assert.equal(parseStartMeetingInput(body), null);
});
test('確認は版と対象IDのみを受け取り、スナップショットの値を受け付けない', () => {
  assert.deepEqual(parseMeetingAction({ action: 'confirm', expectedVersion: 1, entryId }), { action: 'confirm', expectedVersion: 1, entryId });
  for (const patch of [{ progress: 100 }, { expectedVersion: 0 }, { expectedVersion: '1' }, { expectedVersion: 2147483647 }, { entryId: 'bad' }, { action: 'delete' }]) assert.equal(parseMeetingAction({ action: 'confirm', expectedVersion: 1, entryId, ...patch }), null);
});
test('未確認を残す終了と進行役解除は明示的な入力を必要とする', () => {
  assert.deepEqual(parseMeetingAction({ action: 'finish', expectedVersion: 1, allowUnconfirmed: false }), { action: 'finish', expectedVersion: 1, allowUnconfirmed: false });
  assert.equal(parseMeetingAction({ action: 'finish', expectedVersion: 1 }), null);
  assert.equal(parseMeetingAction({ action: 'finish', expectedVersion: 1, allowUnconfirmed: 'true' }), null);
  assert.deepEqual(parseMeetingAction({ action: 'facilitator', expectedVersion: 1, facilitatorUserId: null }), { action: 'facilitator', expectedVersion: 1, facilitatorUserId: null });
  assert.equal(parseMeetingAction({ action: 'facilitator', expectedVersion: 1 }), null);
});
