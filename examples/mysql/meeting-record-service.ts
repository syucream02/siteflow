import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from './generated/integrated/client.ts';
import { canReadTeam, canRunMeeting, type MeetingRecordAction } from '../../lib/siteflow/domain.ts';
import { lockMembership } from './meeting-service.ts';

const reject = (status: number, code: string) => ({ ok: false as const, status, code,
  message: status === 409 ? '他の操作で記録が変更されました。入力は保持されています。最新内容と比較してから再試行してください。'
    : status === 403 ? '現在の所属と会議の進行役を確認してください。' : '対象の会議記録・担当者・入力を確認してください。' });

export async function saveMeetingRecord(prisma: PrismaClient, userId: string, teamId: string, meetingId: string, input: MeetingRecordAction) {
  return prisma.$transaction(async tx => {
    const assigneeId = 'assigneeUserId' in input ? input.assigneeUserId : null;
    const memberships = await lockMembership(tx, userId, teamId, assigneeId);
    const membership = memberships.find(row => row.userId === userId) ?? null;
    if (!canReadTeam(userId, teamId, membership)) return reject(403, 'TEAM_ACCESS_DENIED');
    await tx.$queryRaw(Prisma.sql`SELECT id FROM Meeting WHERE teamId=${teamId} AND id=${meetingId} FOR UPDATE`);
    const meeting = await tx.meeting.findFirst({ where: { id: meetingId, teamId }, include: { facilitator: true } });
    if (!meeting) return reject(404, 'MEETING_NOT_FOUND');
    if (!canRunMeeting(userId, teamId, membership, meeting.facilitator?.userId ?? null)) return reject(403, 'MEETING_ACCESS_DENIED');
    if (meeting.endedAt || meeting.version !== input.expectedVersion) return reject(409, 'MEETING_VERSION_CONFLICT');
    const entry = await tx.meetingProject.findFirst({ where: { teamId, meetingId, id: input.entryId } });
    if (!entry) return reject(404, 'MEETING_ENTRY_NOT_FOUND');
    if (assigneeId && !memberships.some(row => row.userId === assigneeId && ['admin', 'member'].includes(row.role))) return reject(400, 'INVALID_ASSIGNEE');
    // Validate before any writes. Root locks serialize concurrent meetings that share an item.
    const actionId = 'actionId' in input ? input.actionId : null;
    if (actionId) await tx.$queryRaw(Prisma.sql`SELECT id FROM MeetingActionItem WHERE teamId=${teamId} AND id=${actionId} FOR UPDATE`);
    const current = actionId ? await tx.meetingActionItem.findFirst({ where: { teamId, projectId: entry.projectId, id: actionId } }) : null;
    const existing = actionId ? await tx.meetingActionSnapshot.findUnique({ where: { teamId_entryId_actionId: { teamId, entryId: entry.id, actionId } } }) : null;
    if (actionId && (!current || !('itemVersion' in input) || current.version !== input.itemVersion)) return reject(409, 'ACTION_VERSION_CONFLICT');
    if (input.action === 'carry_action') {
      if (!current || current.status !== 'OPEN' || existing) return reject(409, 'ACTION_NOT_AVAILABLE');
      const source = await tx.meetingActionSnapshot.findFirst({ where: { id: input.sourceSnapshotId, teamId,
        projectId: entry.projectId, actionId: current.id, entry: { meeting: { endedAt: { lt: meeting.startedAt } } } } });
      if (!source) return reject(409, 'INVALID_HANDOVER_SOURCE');
    } else if (input.action === 'update_action' || input.action === 'refresh_action') {
      if (!existing || !current) return reject(404, 'ACTION_NOT_IN_MEETING');
      if (input.action === 'update_action' && (current.status !== 'OPEN' || existing.actionVersion !== current.version)) return reject(409, 'ACTION_REVIEW_REQUIRED');
    }
    const actor = await tx.teamParticipant.upsert({ where: { teamId_userId: { teamId, userId } }, create: { teamId, userId }, update: {}, include: { user: true } });
    const stamp = { updatedByParticipantId: actor.id, updatedByNameSnapshot: actor.user.name };
    if (input.action === 'save_notes') {
      await tx.meetingProjectNote.upsert({ where: { teamId_entryId: { teamId, entryId: entry.id } },
        create: { id: randomUUID(), teamId, entryId: entry.id, consultation: input.consultation, decision: input.decision,
          createdByParticipantId: actor.id, createdByNameSnapshot: actor.user.name, ...stamp },
        update: { consultation: input.consultation, decision: input.decision, ...stamp } });
    } else {
      const assignee = assigneeId ? await tx.teamParticipant.upsert({ where: { teamId_userId: { teamId, userId: assigneeId } },
        create: { teamId, userId: assigneeId }, update: {}, include: { user: true } }) : null;
      let item = current;
      if (input.action === 'create_action') {
        item = await tx.meetingActionItem.create({ data: { id: randomUUID(), teamId, projectId: entry.projectId, originEntryId: entry.id,
          content: input.content, dueDate: input.dueDate ? new Date(input.dueDate + 'T00:00:00Z') : null,
          assigneeParticipantId: assignee!.id, assigneeNameSnapshot: assignee!.user.name,
          createdByParticipantId: actor.id, createdByNameSnapshot: actor.user.name, ...stamp } });
      } else if (input.action === 'update_action' || (input.action === 'carry_action'
        && (item!.assigneeParticipantId !== assignee!.id || item!.assigneeNameSnapshot !== assignee!.user.name))) {
        item = await tx.meetingActionItem.update({ where: { id: item!.id }, data: {
          ...(input.action === 'update_action' ? { content: input.content, status: input.status,
            dueDate: input.dueDate ? new Date(input.dueDate + 'T00:00:00Z') : null } : {}),
          assigneeParticipantId: assignee!.id, assigneeNameSnapshot: assignee!.user.name, version: { increment: 1 }, ...stamp } });
      }
      const snapshot = { content: item!.content, assigneeParticipantId: item!.assigneeParticipantId,
        assigneeNameSnapshot: item!.assigneeNameSnapshot, dueDate: item!.dueDate, status: item!.status, actionVersion: item!.version,
        recordedAt: new Date(), recordedByParticipantId: actor.id, recordedByNameSnapshot: actor.user.name };
      if (existing) await tx.meetingActionSnapshot.update({ where: { id: existing.id }, data: snapshot });
      else await tx.meetingActionSnapshot.create({ data: { id: randomUUID(), teamId, projectId: entry.projectId, entryId: entry.id,
        actionId: item!.id, sourceSnapshotId: input.action === 'carry_action' ? input.sourceSnapshotId : null, ...snapshot } });
    }
    const saved = await tx.meeting.update({ where: { id: meetingId }, data: { version: { increment: 1 } }, select: { id: true, version: true } });
    return { ok: true as const, meeting: saved, changed: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function readMeetingRecords(prisma: PrismaClient, userId: string, teamId: string, meetingId: string, entryId: string,
  page: { limit: number; cursor?: string }, candidates = false) {
  return prisma.$transaction(async tx => {
    const memberships = await lockMembership(tx, userId, teamId);
    if (!canReadTeam(userId, teamId, memberships[0] ?? null)) return reject(403, 'TEAM_ACCESS_DENIED');
    await tx.$queryRaw(Prisma.sql`SELECT id FROM Meeting WHERE teamId=${teamId} AND id=${meetingId} FOR UPDATE`);
    const entry = await tx.meetingProject.findFirst({ where: { id: entryId, teamId, meetingId }, include: { meeting: { include: { facilitator: true } }, note: true } });
    if (!entry) return reject(404, 'MEETING_ENTRY_NOT_FOUND');
    const { meeting } = entry;
    const eligibleSource = { teamId, entry: { meeting: { endedAt: { lt: meeting.startedAt } } } };
    const items = candidates ? (meeting.endedAt ? [] : await tx.meetingActionItem.findMany({
      where: { teamId, projectId: entry.projectId, status: 'OPEN', ...(page.cursor ? { id: { gt: page.cursor } } : {}),
        snapshots: { some: eligibleSource, none: { teamId, entryId } } }, orderBy: { id: 'asc' }, take: page.limit + 1,
      include: { assignee: { include: { user: { select: { id: true, name: true } } } },
        snapshots: { where: eligibleSource, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: 1, include: { entry: { select: { meetingId: true } } } } },
    })).map(item => ({ id: item.id, actionId: item.id, content: item.content, status: item.status, dueDate: item.dueDate,
      itemVersion: item.version, assigneeUserId: item.assignee.userId, assigneeName: item.assignee.user.name,
      sourceSnapshotId: item.snapshots[0].id, sourceMeetingId: item.snapshots[0].entry.meetingId, sourceEntryId: item.snapshots[0].entryId }))
      : (await tx.meetingActionSnapshot.findMany({ where: { teamId, entryId, ...(page.cursor ? { id: { gt: page.cursor } } : {}) },
        orderBy: { id: 'asc' }, take: page.limit + 1,
        include: { assignee: { select: { userId: true } }, action: { select: { version: true, status: true } },
          source: { select: { entryId: true, entry: { select: { meetingId: true } } } } },
      })).map(item => ({ id: item.id, actionId: item.actionId, content: item.content, status: item.status, dueDate: item.dueDate,
        assigneeUserId: item.assignee.userId, assigneeName: item.assigneeNameSnapshot,
        itemVersion: item.actionVersion, currentVersion: meeting.endedAt ? null : item.action.version,
        stale: !meeting.endedAt && item.actionVersion !== item.action.version,
        currentStatus: meeting.endedAt ? null : item.action.status,
        recordedAt: item.recordedAt, recordedBy: item.recordedByNameSnapshot, sourceMeetingId: item.source?.entry.meetingId ?? null, sourceEntryId: item.source?.entryId ?? null }));
    const hasMore = items.length > page.limit;
    return { ok: true as const, note: entry.note, meetingVersion: meeting.version, ended: Boolean(meeting.endedAt),
      canOperate: !meeting.endedAt && canRunMeeting(userId, teamId, memberships[0], meeting.facilitator?.userId ?? null),
      items: items.slice(0, page.limit), page: { hasMore, nextCursor: hasMore ? items[page.limit - 1].id : null } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
