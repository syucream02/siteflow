import { Prisma, type PrismaClient } from './generated/integrated/client.ts';
import type { TeamManagementInput } from '../../lib/siteflow/domain.ts';

export const teamFailure = (status: number, code: string, message = '現在の所属・権限・入力内容を確認してください。') => ({ ok: false as const, status, code, message });
export const teamConflict = () => teamFailure(409, 'TEAM_VERSION_CONFLICT', 'チーム情報が更新されています。入力は保持しています。最新の情報を確認してから再試行してください。');

// Existing business writers lock their actor/assignee membership rows first.
// Lock all current memberships in the same order BEFORE Team, avoiding the reverse FK lock order.
// At least one administrator is retained by every roster mutation.
export async function lockTeamRoster(tx: Prisma.TransactionClient, teamId: string) {
  const memberships = await tx.$queryRaw<{ userId: string; role: 'admin' | 'member' }[]>(Prisma.sql`
    SELECT userId, role FROM TeamMembership WHERE teamId=${teamId} ORDER BY userId FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM Team WHERE id=${teamId} FOR UPDATE`);
  const team = await tx.team.findUnique({ where: { id: teamId }, select: { id: true, name: true, version: true } });
  return { team, memberships };
}

export async function verifiedTeamUser(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, emailVerified: true } });
  return user?.emailVerified ? user : null;
}

export async function teamTransaction<T>(prisma: PrismaClient, callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  try { return await prisma.$transaction(callback, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10000 }); }
  catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') return teamFailure(409, 'TEAM_RETRY_REQUIRED', '同時操作がありました。最新の状態を確認してください。');
    throw e;
  }
}

export async function removalBlockers(tx: Prisma.TransactionClient, teamId: string, targetId: string, lastAdmin: boolean) {
  const person = await tx.teamParticipant.findUnique({ where: { teamId_userId: { teamId, userId: targetId } }, select: { id: true } });
  if (!person) return { lastAdmin, counts: { projects: 0, meetings: 0, actions: 0 }, projects: [], meetings: [], actions: [], allowed: !lastAdmin };
  const projectsWhere: Prisma.ProjectWhereInput = { teamId, archivedAt: null, status: { not: 'DONE' },
    OR: [{ primaryParticipantId: person.id }, { supportMembers: { some: { participantId: person.id } } }] };
  const meetingsWhere = { teamId, endedAt: null, facilitatorParticipantId: person.id };
  const actionsWhere = { teamId, assigneeParticipantId: person.id, status: 'OPEN' as const };
  const [projectCount, meetingCount, actionCount, projects, meetings, actions] = await Promise.all([
    tx.project.count({ where: projectsWhere }), tx.meeting.count({ where: meetingsWhere }), tx.meetingActionItem.count({ where: actionsWhere }),
    tx.project.findMany({ where: projectsWhere, orderBy: { id: 'asc' }, take: 20, select: { id: true, name: true } }),
    tx.meeting.findMany({ where: meetingsWhere, orderBy: { id: 'asc' }, take: 20, select: { id: true, startedAt: true } }),
    tx.meetingActionItem.findMany({ where: actionsWhere, orderBy: { id: 'asc' }, take: 20,
      select: { id: true, content: true, originEntryId: true, originEntry: { select: { meetingId: true } } } }),
  ]);
  return { lastAdmin, counts: { projects: projectCount, meetings: meetingCount, actions: actionCount }, projects, meetings, actions,
    allowed: !lastAdmin && projectCount + meetingCount + actionCount === 0 };
}

export async function readTeamSettings(prisma: PrismaClient, userId: string, teamId: string) {
  return teamTransaction(prisma, async tx => {
    const { team, memberships } = await lockTeamRoster(tx, teamId), own = memberships.find(m => m.userId === userId);
    if (!team || !own) return teamFailure(403, 'TEAM_ACCESS_DENIED');
    const orphanedWhere = { teamId, endedAt: null, facilitatorParticipantId: { not: null },
      facilitator: { user: { teammemberships: { none: { teamId } } } } };
    const orphanedCount = await tx.meeting.count({ where: orphanedWhere });
    const orphanedMeetings = await tx.meeting.findMany({ where: orphanedWhere, orderBy: { id: 'asc' }, take: 20, select: { id: true } });
    return { ok: true as const, team, role: own.role, counts: { members: memberships.length, admins: memberships.filter(m => m.role === 'admin').length },
      orphanedCount, orphanedMeetings };
  });
}

export async function checkTeamRemoval(prisma: PrismaClient, userId: string, teamId: string, targetId: string) {
  return teamTransaction(prisma, async tx => {
    const { team, memberships } = await lockTeamRoster(tx, teamId), own = memberships.find(m => m.userId === userId), target = memberships.find(m => m.userId === targetId);
    if (!team || !own) return teamFailure(403, 'TEAM_ACCESS_DENIED');
    if (own.role !== 'admin' && userId !== targetId) return teamFailure(403, 'TEAM_MANAGE_DENIED');
    if (!target) return teamFailure(404, 'MEMBER_NOT_FOUND');
    const blockers = await removalBlockers(tx, teamId, targetId, target.role === 'admin' && memberships.filter(m => m.role === 'admin').length <= 1);
    return { ok: true as const, version: team.version, blockers };
  });
}

export async function changeTeamMembership(prisma: PrismaClient, userId: string, teamId: string, targetId: string | null,
  input: Exclude<TeamManagementInput, { action: 'invite' }>) {
  return teamTransaction(prisma, async tx => {
    const { team, memberships } = await lockTeamRoster(tx, teamId), own = memberships.find(m => m.userId === userId);
    if (!team || !own) return teamFailure(403, 'TEAM_ACCESS_DENIED');
    if (!await verifiedTeamUser(tx, userId)) return teamFailure(403, 'EMAIL_NOT_VERIFIED');
    if (input.action !== 'leave' && own.role !== 'admin') return teamFailure(403, 'TEAM_MANAGE_DENIED', 'チーム管理者だけが操作できます。');
    if (team.version !== input.expectedVersion) return teamConflict();
    if (input.action === 'rename') {
      if (team.name === input.name) return { ok: true as const, changed: false, team };
      const saved = await tx.team.update({ where: { id: teamId }, data: { name: input.name, version: { increment: 1 } }, select: { id: true, name: true, version: true } });
      return { ok: true as const, changed: true, team: saved };
    }
    const subjectId = input.action === 'leave' ? userId : targetId;
    const target = memberships.find(m => m.userId === subjectId);
    if (!target || !subjectId) return teamFailure(404, 'MEMBER_NOT_FOUND');
    const lastAdmin = target.role === 'admin' && memberships.filter(m => m.role === 'admin').length <= 1;
    if (input.action === 'role') {
      if (target.role === input.role) return { ok: true as const, changed: false, team };
      if (lastAdmin && input.role === 'member') return teamFailure(409, 'LAST_ADMIN', '最後の管理者は降格できません。先に別の管理者を設定してください。');
      await tx.teamMembership.update({ where: { teamId_userId: { teamId, userId: subjectId } }, data: { role: input.role } });
    } else if (input.action === 'remove' || input.action === 'leave') {
      const blockers = await removalBlockers(tx, teamId, subjectId, lastAdmin);
      if (!blockers.allowed) return { ...teamFailure(409, 'MEMBERSHIP_BLOCKED', '未完了の担当・進行役・最後の管理者を確認してください。所属は解除していません。'), blockers };
      await tx.teamMembership.delete({ where: { teamId_userId: { teamId, userId: subjectId } } });
    } else return teamFailure(400, 'INVALID_TEAM_ACTION');
    if (target.role === 'admin' || input.action === 'remove' || input.action === 'leave') await tx.invitation.updateMany({ where: { teamId, inviterId: subjectId, status: 'pending' }, data: { status: 'canceled' } });
    const saved = await tx.team.update({ where: { id: teamId }, data: { version: { increment: 1 } }, select: { id: true, name: true, version: true } });
    return { ok: true as const, changed: true, team: saved };
  });
}
