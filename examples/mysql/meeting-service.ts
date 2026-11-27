import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from './generated/integrated/client.ts';
import { canReadTeam, canRunMeeting, compareMeetingProgress, meetingProjectLimit, type MeetingAction, type ProjectStatus } from '../../lib/siteflow/domain.ts';

const denied = () => ({ ok: false as const, status: 403, code: 'MEETING_ACCESS_DENIED', message: 'この会議を操作する権限がありません。所属と進行役を確認してください。' });
const missing = () => ({ ok: false as const, status: 404, code: 'MEETING_NOT_FOUND', message: '会議が見つかりません。' });
const conflict = () => ({ ok: false as const, status: 409, code: 'MEETING_VERSION_CONFLICT', message: '会議が更新されています。最新の状態を取得し、確認してからもう一度操作してください。' });

export async function lockMembership(tx: Prisma.TransactionClient, userId: string, teamId: string, otherUserId?: string | null) {
  const ids = [...new Set([userId, ...(otherUserId ? [otherUserId] : [])])].sort();
  return tx.$queryRaw<{ teamId: string; userId: string; role: string }[]>(Prisma.sql`
    SELECT teamId, userId, role FROM TeamMembership WHERE teamId=${teamId}
    AND userId IN (${Prisma.join(ids)}) ORDER BY userId FOR UPDATE
  `);
}

export async function startMeetingForUser(prisma: PrismaClient, userId: string, teamId: string, facilitatorUserId: string | null) {
  return prisma.$transaction(async tx => {
    const memberships = await lockMembership(tx, userId, teamId, facilitatorUserId);
    if (!canReadTeam(userId, teamId, memberships.find(row => row.userId === userId) ?? null)) return denied();
    if (facilitatorUserId && !memberships.some(row => row.userId === facilitatorUserId && ['admin', 'member'].includes(row.role))) {
      return { ok: false as const, status: 400, code: 'INVALID_FACILITATOR', message: '進行役は現在のチーム所属者から選んでください。' };
    }
    // 通常一覧の1ページを流用しない。上限超過も、黙って切り捨てず拒否する。
    const projects = await tx.project.findMany({ where: { teamId, archivedAt: null }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: meetingProjectLimit + 1, select: { id: true, name: true } });
    if (!projects.length || projects.length > meetingProjectLimit) return { ok: false as const, status: 409, code: 'MEETING_TARGET_COUNT', message: `対象案件は1〜${meetingProjectLimit}件にしてください。保管中の案件は対象外です。` };
    const people = new Map<string, string>();
    for (const id of [...new Set([userId, ...(facilitatorUserId ? [facilitatorUserId] : [])])].sort()) {
      const person = await tx.teamParticipant.upsert({ where: { teamId_userId: { teamId, userId: id } }, create: { teamId, userId: id }, update: {}, select: { id: true } });
      people.set(id, person.id);
    }
    const meeting = await tx.meeting.create({ data: { id: randomUUID(), teamId, createdByParticipantId: people.get(userId)!,
      facilitatorParticipantId: facilitatorUserId ? people.get(facilitatorUserId)! : null }, select: { id: true, version: true } });
    await tx.meetingProject.createMany({ data: projects.map((project, position) => ({ id: randomUUID(), teamId, meetingId: meeting.id,
      projectId: project.id, position, nameSnapshot: project.name })) });
    return { ok: true as const, meeting };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function readMeetingForUser(prisma: PrismaClient, userId: string, teamId: string, meetingId: string) {
  return prisma.$transaction(async tx => {
    const memberships = await lockMembership(tx, userId, teamId);
    const membership = memberships.find(row => row.userId === userId) ?? null;
    if (!canReadTeam(userId, teamId, membership)) return denied();
    // 確認・取消・終了の途中を混ぜず、件数と対象を同じ状態から返す。
    await tx.$queryRaw(Prisma.sql`SELECT id FROM Meeting WHERE teamId=${teamId} AND id=${meetingId} FOR UPDATE`);
    const meeting = await tx.meeting.findFirst({ where: { id: meetingId, teamId }, select: {
      id: true, version: true, startedAt: true, endedAt: true,
      facilitator: { select: { userId: true, user: { select: { name: true } } } },
      projects: { orderBy: { position: 'asc' }, select: { id: true, projectId: true, nameSnapshot: true,
        project: { select: { name: true, dueDate: true, progress: true, status: true, archivedAt: true, primaryParticipant: { select: { user: { select: { name: true } } } } } },
        confirmations: { where: { revokedAt: null }, orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }], take: 1,
          select: { id: true, progress: true, status: true, projectVersion: true, confirmedAt: true, confirmedByNameSnapshot: true } },
        _count: { select: { confirmations: true } },
      } },
    } });
    if (!meeting) return missing();
    // 今回の開始前に終了した会議だけ。同時進行の会議や取消済みの記録を混ぜない。
    // 全対象を1回で取得し、案件ごとの問い合わせ（N+1）と過去全行の転送を避ける。
    const previousRows = meeting.projects.length ? await tx.$queryRaw<{
      projectId: string; meetingId: string; confirmedAt: Date; progress: number; status: ProjectStatus;
    }[]>(Prisma.sql`
      SELECT projectId, meetingId, confirmedAt, progress, status FROM (
        SELECT mp.projectId, mp.meetingId, c.confirmedAt, c.progress, c.status,
          ROW_NUMBER() OVER (PARTITION BY mp.projectId ORDER BY c.confirmedAt DESC, c.id DESC) AS recordRank
        FROM MeetingConfirmation c
        INNER JOIN MeetingProject mp ON mp.teamId=c.teamId AND mp.id=c.entryId
        INNER JOIN Meeting m ON m.teamId=mp.teamId AND m.id=mp.meetingId
        WHERE c.teamId=${teamId} AND mp.teamId=${teamId} AND m.teamId=${teamId}
          AND c.revokedAt IS NULL AND m.endedAt < ${meeting.startedAt}
          AND c.confirmedAt < ${meeting.startedAt} AND m.id <> ${meetingId}
          AND mp.projectId IN (${Prisma.join(meeting.projects.map(entry => entry.projectId))})
      ) ranked WHERE recordRank=1
    `) : [];
    const previousByProject = new Map(previousRows.map(({ projectId, ...record }) => [projectId, record]));
    const entries = meeting.projects.map(entry => ({ id: entry.id, projectId: entry.projectId, nameAtStart: entry.nameSnapshot,
      project: { name: entry.project.name, dueDate: entry.project.dueDate.toISOString().slice(0, 10), progress: entry.project.progress,
        status: entry.project.status, archived: entry.project.archivedAt !== null, primaryName: entry.project.primaryParticipant.user.name },
      confirmation: entry.confirmations[0] ?? null, auditCount: entry._count.confirmations,
      previousConfirmation: previousByProject.get(entry.projectId) ?? null,
      comparison: compareMeetingProgress(previousByProject.get(entry.projectId) ?? null, entry.project,
        entry.confirmations[0] ?? null, meeting.endedAt !== null),
    }));
    const confirmed = entries.filter(entry => entry.confirmation !== null).length;
    return { ok: true as const, meeting: { id: meeting.id, version: meeting.version, startedAt: meeting.startedAt, endedAt: meeting.endedAt,
      facilitator: meeting.facilitator ? { userId: meeting.facilitator.userId, name: meeting.facilitator.user.name } : null,
      canOperate: !meeting.endedAt && canRunMeeting(userId, teamId, membership, meeting.facilitator?.userId ?? null),
      counts: { total: entries.length, confirmed, unconfirmed: entries.length - confirmed },
      comparisonCounts: {
        changed: entries.filter(entry => entry.comparison.progressChanged || entry.comparison.statusChanged).length,
        noPrevious: entries.filter(entry => !entry.previousConfirmation).length,
        unconfirmed: entries.filter(entry => entry.comparison.source === 'unconfirmed').length,
      }, entries } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function actOnMeetingForUser(prisma: PrismaClient, userId: string, teamId: string, meetingId: string, input: MeetingAction) {
  return prisma.$transaction(async tx => {
    const memberships = await lockMembership(tx, userId, teamId, input.action === 'facilitator' ? input.facilitatorUserId : null);
    const membership = memberships.find(row => row.userId === userId) ?? null;
    if (!canReadTeam(userId, teamId, membership)) return denied();
    await tx.$queryRaw(Prisma.sql`SELECT id FROM Meeting WHERE teamId=${teamId} AND id=${meetingId} FOR UPDATE`);
    const meeting = await tx.meeting.findFirst({ where: { id: meetingId, teamId }, select: { version: true, endedAt: true, facilitator: { select: { userId: true } } } });
    if (!meeting) return missing();
    if (!canRunMeeting(userId, teamId, membership, meeting.facilitator?.userId ?? null)) return denied();
    if (meeting.endedAt) return { ok: false as const, status: 409, code: 'MEETING_ENDED', message: '終了した会議の確認記録は変更できません。' };
    if (meeting.version !== input.expectedVersion) return conflict();
    if (input.action === 'facilitator' && input.facilitatorUserId && !memberships.some(row => row.userId === input.facilitatorUserId && ['admin', 'member'].includes(row.role))) {
      return { ok: false as const, status: 400, code: 'INVALID_FACILITATOR', message: '進行役は現在のチーム所属者から選んでください。' };
    }
    if (input.action === 'finish' && !input.allowUnconfirmed) {
      const remaining = await tx.meetingProject.count({ where: { teamId, meetingId, confirmations: { none: { revokedAt: null } } } });
      if (remaining) return { ok: false as const, status: 409, code: 'UNCONFIRMED_PROJECTS', message: `未確認の案件が${remaining}件あります。一覧を確認してから終了してください。` };
    }
    if (input.action === 'finish') {
      // Canonical action rows serialize finish with updates from other active meetings.
      const ids = await tx.meetingActionSnapshot.findMany({ where: { teamId, entry: { meetingId } }, select: { actionId: true } });
      if (ids.length) {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM MeetingActionItem WHERE teamId=${teamId} AND id IN (${Prisma.join(ids.map(row => row.actionId).sort())}) ORDER BY id FOR UPDATE`);
        const stale = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT s.id FROM MeetingActionSnapshot s
          JOIN MeetingProject e ON e.teamId=s.teamId AND e.id=s.entryId
          JOIN MeetingActionItem a ON a.teamId=s.teamId AND a.id=s.actionId
          WHERE s.teamId=${teamId} AND e.meetingId=${meetingId} AND s.actionVersion<>a.version LIMIT 1`);
        if (stale.length) return { ok: false as const, status: 409, code: 'ACTION_REVIEW_REQUIRED', message: '別の会議で更新された対応事項があります。各案件で最新の対応事項を確認してから終了してください。' };
      }
    }
    const actor = await tx.teamParticipant.upsert({ where: { teamId_userId: { teamId, userId } }, create: { teamId, userId }, update: {}, select: { id: true, user: { select: { name: true } } } });
    let facilitatorParticipantId: string | null | undefined;
    if (input.action === 'facilitator') {
      facilitatorParticipantId = input.facilitatorUserId ? (await tx.teamParticipant.upsert({ where: { teamId_userId: { teamId, userId: input.facilitatorUserId } },
        create: { teamId, userId: input.facilitatorUserId }, update: {}, select: { id: true } })).id : null;
    }
    if (input.action === 'confirm' || input.action === 'unconfirm') {
      const entry = await tx.meetingProject.findFirst({ where: { id: input.entryId, teamId, meetingId }, select: { projectId: true } });
      if (!entry) return { ok: false as const, status: 404, code: 'MEETING_ENTRY_NOT_FOUND', message: 'この会議の対象案件が見つかりません。' };
      const existing = await tx.meetingConfirmation.findFirst({ where: { teamId, entryId: input.entryId, revokedAt: null }, select: { id: true } });
      if ((input.action === 'confirm') === Boolean(existing)) return { ok: true as const, meeting: { id: meetingId, version: meeting.version }, changed: false };
      if (input.action === 'confirm') {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM Project WHERE teamId=${teamId} AND id=${entry.projectId} FOR UPDATE`);
        const project = await tx.project.findFirstOrThrow({ where: { id: entry.projectId, teamId }, select: { progress: true, status: true, version: true } });
        await tx.meetingConfirmation.create({ data: { id: randomUUID(), teamId, entryId: input.entryId, progress: project.progress, status: project.status,
          projectVersion: project.version, confirmedByParticipantId: actor.id, confirmedByNameSnapshot: actor.user.name } });
      } else {
        // 値や確認者は消さず、取消者・取消日時を加えて監査用に保持する。
        await tx.meetingConfirmation.update({ where: { id: existing!.id }, data: { revokedAt: new Date(), revokedByParticipantId: actor.id, revokedByNameSnapshot: actor.user.name } });
      }
    }
    const saved = await tx.meeting.updateMany({ where: { id: meetingId, teamId, version: input.expectedVersion, endedAt: null }, data: {
      version: { increment: 1 }, ...(input.action === 'finish' ? { endedAt: new Date() } : {}),
      ...(input.action === 'facilitator' ? { facilitatorParticipantId } : {}),
    } });
    if (saved.count !== 1) throw new Error('Locked meeting update failed');
    return { ok: true as const, meeting: { id: meetingId, version: meeting.version + 1 }, changed: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
