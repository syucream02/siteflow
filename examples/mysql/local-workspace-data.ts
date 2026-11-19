import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { PrismaClient } from './generated/integrated/client.ts';

// ローカルで画面を確認するための架空データ。実際の登録・メール認証フローではない。
export async function createLocalWorkspaceData(prisma: PrismaClient) {
  const userId = randomUUID(), password = randomBytes(24).toString('hex');
  const email = `${userId}@example.invalid`, teamIds = [randomUUID(), randomUUID()];
  const participantId = randomUUID(), projectIds = Array.from({ length: 21 }, () => randomUUID());
  const hash = await hashPassword(password);
  await prisma.$transaction(async tx => {
    await tx.user.create({ data: { id: userId, email, name: 'ローカル体験ユーザー', emailVerified: true,
      accounts: { create: { id: randomUUID(), accountId: userId, providerId: 'credential', password: hash } } } });
    for (const [index, id] of teamIds.entries()) await tx.team.create({ data: { id, name: index ? '架空の中央チーム（案件0件）' : '架空の青葉チーム', slug: `local-workspace-${id}`, createdAt: new Date(),
      teammemberships: { create: { id: randomUUID(), userId, role: 'admin', createdAt: new Date() } } } });
    await tx.teamParticipant.create({ data: { id: participantId, teamId: teamIds[0], userId } });
    await tx.project.createMany({ data: projectIds.map((id, index) => ({ id, teamId: teamIds[0], name: `架空の案件 ${String(index + 1).padStart(2, '0')}`, code: `LOCAL-${String(index + 1).padStart(3, '0')}`,
      dueDate: new Date(`2026-12-${String(index + 1).padStart(2, '0')}T00:00:00Z`), primaryParticipantId: participantId, createdByParticipantId: participantId, createdByNameSnapshot: 'ローカル体験ユーザー', progress: 0, status: 'NOT_STARTED', version: 1 })) });
    await tx.projectAssignmentHistory.createMany({ data: projectIds.map(projectId => ({ id: randomUUID(), teamId: teamIds[0], projectId, kind: 'PRIMARY_CHANGE', nextParticipantId: participantId, nextNameSnapshot: 'ローカル体験ユーザー', changedByParticipantId: participantId, changedByNameSnapshot: 'ローカル体験ユーザー' })) });
  });
  return { userId, email, password, teamIds, projectIds };
}

export async function removeLocalWorkspaceData(prisma: PrismaClient, data: { userId: string; teamIds: string[] }) {
  await prisma.$transaction(async tx => {
    await tx.meetingConfirmation.deleteMany({ where: { teamId: { in: data.teamIds } } });
    await tx.meetingProject.deleteMany({ where: { teamId: { in: data.teamIds } } });
    await tx.meeting.deleteMany({ where: { teamId: { in: data.teamIds } } });
    await tx.projectAssignmentHistory.deleteMany({ where: { teamId: { in: data.teamIds } } });
    await tx.projectProgressHistory.deleteMany({ where: { teamId: { in: data.teamIds } } });
    await tx.projectSupportMember.deleteMany({ where: { teamId: { in: data.teamIds } } });
    await tx.project.deleteMany({ where: { teamId: { in: data.teamIds } } });
    await tx.teamMembership.deleteMany({ where: { teamId: { in: data.teamIds } } });
    await tx.teamParticipant.deleteMany({ where: { teamId: { in: data.teamIds } } });
    await tx.team.deleteMany({ where: { id: { in: data.teamIds } } });
    await tx.user.delete({ where: { id: data.userId } });
  });
}
