import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunMeeting, parseMeetingAction, parseStartMeetingInput } from '../lib/siteflow/domain.ts';
const entryId = '1bfeb235-081e-4bfc-8ae5-65c93bedbe00';
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
