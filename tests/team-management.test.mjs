import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeamManagementInput, invitationCanBeAccepted } from '../lib/siteflow/domain.ts';
it('チーム名の既存規則と版番号を検査する', () => {
  assert.deepEqual(parseTeamManagementInput('rename', { name: ' チーム ', expectedVersion: 1 }), { action: 'rename', name: 'チーム', expectedVersion: 1 });
  for (const name of ['', ' ', 'a\n', 'あ'.repeat(81)]) assert.equal(parseTeamManagementInput('rename', { name, expectedVersion: 1 }), null);
  for (const expectedVersion of [0, -1, '1', 1.1, 2147483647]) assert.equal(parseTeamManagementInput('leave', { expectedVersion }), null);
});
it('役割はadmin/memberだけ、追加属性や本人の自己申告を拒否する', () => {
  for (const role of ['admin', 'member']) assert.ok(parseTeamManagementInput('role', { role, expectedVersion: 1 }));
  for (const role of ['owner', ['admin'], null, true]) assert.equal(parseTeamManagementInput('role', { role, expectedVersion: 1 }), null);
  assert.equal(parseTeamManagementInput('leave', { expectedVersion: 1, userId: 'fake' }), null);
  assert.equal(parseTeamManagementInput('invite', { email: 'a@example.invalid', expectedVersion: 1, role: 'admin' }), null);
});
it('招待メールの前後空白と大小を正規化し、別アドレスの記号は保持する', () => {
  assert.equal(parseTeamManagementInput('invite', { email: ' A.B+test@Example.invalid ', expectedVersion: 1 }).email, 'a.b+test@example.invalid');
  for (const email of ['', 'a', 'a@b', 'a\0@example.invalid', 'a\nb@example.invalid']) assert.equal(parseTeamManagementInput('invite', { email, expectedVersion: 1 }), null);
});
it('未確認・期限境界・取消・使用済み・未知の状態・別宛先・admin招待を拒否する', () => {
  const now = new Date('2026-11-25T00:00:00Z'), i = { email: 'a@example.invalid', status: 'pending', role: 'member', expiresAt: new Date(now.getTime() + 1) }, u = { email: 'A@example.invalid', emailVerified: true };
  assert.equal(invitationCanBeAccepted(i, u, now), true);
  for (const status of ['accepted', 'rejected', 'canceled', 'unknown']) assert.equal(invitationCanBeAccepted({ ...i, status }, u, now), false);
  for (const expiresAt of [now, new Date(now.getTime() - 1), new Date('invalid')]) assert.equal(invitationCanBeAccepted({ ...i, expiresAt }, u, now), false);
  assert.equal(invitationCanBeAccepted(i, { ...u, emailVerified: false }, now), false);
  assert.equal(invitationCanBeAccepted(i, { ...u, email: 'b@example.invalid' }, now), false);
  assert.equal(invitationCanBeAccepted({ ...i, role: 'admin' }, u, now), false);
});
