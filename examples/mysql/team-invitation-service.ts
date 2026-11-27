import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from './generated/integrated/client.ts';
import { canonicalInvitationEmail, invitationCanBeAccepted } from '../../lib/siteflow/domain.ts';
import { lockTeamRoster, teamConflict, teamFailure, teamTransaction, verifiedTeamUser } from './team-membership-service.ts';

const unavailable = () => teamFailure(409, 'INVITATION_UNAVAILABLE', 'この招待は期限切れ・取消済み・使用済み、または現在利用できません。');
export async function readTeamInvitations(prisma: PrismaClient, userId: string, teamId: string, page: { limit: number; cursor?: string }) {
  return teamTransaction(prisma, async tx => {
    const { team, memberships } = await lockTeamRoster(tx, teamId), own = memberships.find(m => m.userId === userId);
    if (!team || !own) return teamFailure(403, 'TEAM_ACCESS_DENIED');
    if (own.role !== 'admin') return teamFailure(403, 'TEAM_MANAGE_DENIED');
    const rows = await tx.invitation.findMany({ where: { teamId, ...(page.cursor ? { id: { gt: page.cursor } } : {}) }, orderBy: { id: 'asc' }, take: page.limit + 1,
      select: { id: true, email: true, status: true, expiresAt: true, createdAt: true } });
    return { ok: true as const, version: team.version, items: rows.slice(0, page.limit).map(row => ({ ...row, expired: row.expiresAt.getTime() <= Date.now() })), page: { hasMore: rows.length > page.limit, nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null } };
  });
}

export async function createTeamInvitation(prisma: PrismaClient, userId: string, teamId: string, email: string, expectedVersion: number, now = new Date()) {
  return teamTransaction(prisma, async tx => {
    const { team, memberships } = await lockTeamRoster(tx, teamId), own = memberships.find(m => m.userId === userId);
    if (!team || !own) return teamFailure(403, 'TEAM_ACCESS_DENIED');
    if (own.role !== 'admin') return teamFailure(403, 'TEAM_MANAGE_DENIED');
    if (!await verifiedTeamUser(tx, userId)) return teamFailure(403, 'EMAIL_NOT_VERIFIED');
    if (team.version !== expectedVersion) return teamConflict();
    if (!Number.isFinite(now.getTime()) || email !== canonicalInvitationEmail(email)) return teamFailure(400, 'INVALID_INVITATION');
    const existing = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM invitation WHERE teamId=${teamId}
      AND BINARY email=BINARY ${email} AND status='pending' AND expiresAt>${now} LIMIT 1`);
    const alreadyMember = await tx.teamMembership.findFirst({ where: { teamId, user: { email } }, select: { id: true } });
    if (existing.length || alreadyMember) return teamFailure(409, 'INVITATION_NOT_CREATED', '同じ宛先への有効な招待、または現在の所属を確認してください。');
    // No global User lookup or account creation. Identical success for registered/unregistered destinations.
    const invitation = await tx.invitation.create({ data: { id: randomUUID(), teamId, inviterId: userId, email, role: 'member', status: 'pending',
      createdAt: now, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) }, select: { id: true, status: true, expiresAt: true } });
    const saved = await tx.team.update({ where: { id: teamId }, data: { version: { increment: 1 } }, select: { version: true } });
    return { ok: true as const, invitation, version: saved.version };
  });
}

export async function cancelTeamInvitation(prisma: PrismaClient, userId: string, teamId: string, invitationId: string, expectedVersion: number) {
  return teamTransaction(prisma, async tx => {
    const { team, memberships } = await lockTeamRoster(tx, teamId), own = memberships.find(m => m.userId === userId);
    if (!team || !own) return teamFailure(403, 'TEAM_ACCESS_DENIED');
    if (own.role !== 'admin') return teamFailure(403, 'TEAM_MANAGE_DENIED');
    if (!await verifiedTeamUser(tx, userId)) return teamFailure(403, 'EMAIL_NOT_VERIFIED');
    if (team.version !== expectedVersion) return teamConflict();
    const invitation = await tx.invitation.findFirst({ where: { teamId, id: invitationId } });
    if (!invitation || invitation.status !== 'pending') return unavailable();
    await tx.invitation.update({ where: { id: invitationId }, data: { status: 'canceled' } });
    const teamSaved = await tx.team.update({ where: { id: teamId }, data: { version: { increment: 1 } }, select: { version: true } });
    return { ok: true as const, version: teamSaved.version };
  });
}

export async function readMyInvitations(prisma: PrismaClient, userId: string, page: { limit: number; cursor?: string }) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } });
  if (!user?.emailVerified) return teamFailure(403, 'EMAIL_NOT_VERIFIED');
  // Binary equality keeps MySQL's accent/case-insensitive collation from matching another destination.
  const rows = await prisma.$queryRaw<{ id: string; teamId: string; teamName: string; inviterName: string; status: string; expiresAt: Date }[]>(Prisma.sql`
    SELECT i.id,i.teamId,t.name AS teamName,u.name AS inviterName,i.status,i.expiresAt
    FROM invitation i JOIN Team t ON t.id=i.teamId JOIN user u ON u.id=i.inviterId
    WHERE BINARY i.email=BINARY ${canonicalInvitationEmail(user.email)}
      ${page.cursor ? Prisma.sql`AND i.id>${page.cursor}` : Prisma.empty}
    ORDER BY i.id LIMIT ${page.limit + 1}`);
  return { ok: true as const, items: rows.slice(0, page.limit).map(row => ({ ...row, expired: row.expiresAt.getTime() <= Date.now() })), page: { hasMore: rows.length > page.limit, nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null } };
}

export async function answerTeamInvitation(prisma: PrismaClient, userId: string, invitationId: string, action: 'accept' | 'decline') {
  // Preview is only a lock-routing hint; authorization and all mutable data are read again under locks.
  const preview = await prisma.invitation.findUnique({ where: { id: invitationId }, select: { teamId: true } });
  if (!preview) return teamFailure(404, 'INVITATION_NOT_FOUND');
  return teamTransaction(prisma, async tx => {
    const { team, memberships } = await lockTeamRoster(tx, preview.teamId);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM invitation WHERE teamId=${preview.teamId} AND id=${invitationId} FOR UPDATE`);
    const user = await verifiedTeamUser(tx, userId);
    const invitation = await tx.invitation.findUnique({ where: { id: invitationId } });
    if (!team || !user || !invitation || invitation.teamId !== team.id || canonicalInvitationEmail(user.email) !== invitation.email) return teamFailure(404, 'INVITATION_NOT_FOUND');
    const now = new Date(); // Capture AFTER waiting for the roster/invitation locks.
    if (!invitationCanBeAccepted(invitation, user, now) || !memberships.some(m => m.userId === invitation.inviterId && m.role === 'admin')) return unavailable();
    if (memberships.some(m => m.userId === userId)) return unavailable();
    // Check expiry again at the DB mutation, before creating membership. A zero-row result writes nothing.
    const changed = await tx.$executeRaw(Prisma.sql`UPDATE invitation SET status=${action === 'accept' ? 'accepted' : 'rejected'}
      WHERE id=${invitationId} AND teamId=${team.id} AND status='pending' AND expiresAt>CURRENT_TIMESTAMP(3)`);
    if (changed !== 1) return unavailable();
    if (action === 'accept') await tx.teamMembership.create({ data: { id: randomUUID(), teamId: team.id, userId, role: 'member', createdAt: now } });
    await tx.team.update({ where: { id: team.id }, data: { version: { increment: 1 } } });
    return { ok: true as const, teamId: team.id, accepted: action === 'accept' };
  });
}
