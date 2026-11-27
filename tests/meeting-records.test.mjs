import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeetingRecordAction } from '../lib/siteflow/domain.ts';

const id = '12345678-1234-1234-1234-123456789abc';
const base = { expectedVersion: 1, entryId: id };
const action = { ...base, action: 'create_action', content: '対応する', assigneeUserId: id, dueDate: null };
it('相談・決定は空欄も保存でき、外側の空白だけ除く', () => {
  assert.equal(parseMeetingRecordAction({ ...base, action: 'save_notes', consultation: ' 相談\n内容 ', decision: '' }).consultation, '相談\n内容');
});
it('担当者必須、期限任意、既存3状態だけを許可', () => {
  assert.ok(parseMeetingRecordAction(action));
  for (const assigneeUserId of ['', null, 1]) assert.equal(parseMeetingRecordAction({ ...action, assigneeUserId }), null);
  for (const status of ['OPEN', 'DONE', 'CANCELLED']) assert.ok(parseMeetingRecordAction({ ...action, action: 'update_action', actionId: id, itemVersion: 2, status }));
  assert.equal(parseMeetingRecordAction({ ...action, action: 'update_action', actionId: id, itemVersion: 2, status: 'REOPEN' }), null);
});
it('無効日付・型・不明キー・制御文字・上限超過を拒否', () => {
  for (const dueDate of ['2026-02-30', '2026-13-01', '', 1]) assert.equal(parseMeetingRecordAction({ ...action, dueDate }), null);
  assert.ok(parseMeetingRecordAction({ ...action, dueDate: '2028-02-29' }));
  for (const content of ['', ' ', 'a\0', 'あ'.repeat(2001)]) assert.equal(parseMeetingRecordAction({ ...action, content }), null);
  assert.ok(parseMeetingRecordAction({ ...action, content: 'あ'.repeat(2000) }));
  assert.equal(parseMeetingRecordAction({ ...action, teamId: id }), null);
});
it('会議版・本体版・引き継ぎ元IDを厳密に検査する', () => {
  for (const expectedVersion of [0, -1, 1.5, '1', 2147483647]) assert.equal(parseMeetingRecordAction({ ...action, expectedVersion }), null);
  const carry = { ...base, action: 'carry_action', actionId: id, itemVersion: 1, sourceSnapshotId: id, assigneeUserId: id };
  assert.ok(parseMeetingRecordAction(carry));
  for (const key of ['actionId', 'itemVersion', 'sourceSnapshotId', 'assigneeUserId']) { const v = { ...carry }; delete v[key]; assert.equal(parseMeetingRecordAction(v), null); }
});
