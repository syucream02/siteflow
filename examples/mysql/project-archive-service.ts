import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "./generated/integrated/client.ts";
import { canReadTeam, canArchiveProject, diffProjectAssignees, planProjectArchiveChange, type ProjectArchiveInput } from "../../lib/siteflow/domain.ts";

export async function changeProjectArchiveForUser(prisma: PrismaClient, userId: string, teamId: string, projectId: string, input: ProjectArchiveInput) {
  // 事前の担当IDはロック対象を決めるためだけに使い、保存前に版と担当を読み直す。
  const preview = await prisma.project.findFirst({ where: { id: projectId, teamId,
    team: { teammemberships: { some: { userId, role: { in: ["admin", "member"] } } } } }, select: {
    version: true, primaryParticipant: { select: { userId: true } }, supportMembers: { select: { participant: { select: { userId: true } } } },
  } });
  const userIds = [...new Set([userId,
    ...(preview ? [preview.primaryParticipant.userId, ...preview.supportMembers.map(row => row.participant.userId)] : []),
    ...(input.assignees ? [input.assignees.primaryUserId, ...input.assignees.supportUserIds] : []),
  ])].sort();
  return prisma.$transaction(async tx => {
    const memberships = await tx.$queryRaw<{ teamId: string; userId: string; role: string }[]>(Prisma.sql`
      SELECT teamId, userId, role FROM TeamMembership WHERE teamId = ${teamId}
      AND userId IN (${Prisma.join(userIds)}) ORDER BY userId FOR UPDATE
    `);
    const membership = memberships.find(row => row.userId === userId) ?? null;
    if (!canReadTeam(userId, teamId, membership)) return { ok: false as const, status: 403, code: "TEAM_ACCESS_DENIED", message: "このチームへのアクセスは許可されていません。" };
    await tx.$queryRaw(Prisma.sql`SELECT id FROM Project WHERE id = ${projectId} AND teamId = ${teamId} FOR UPDATE`);
    const project = await tx.project.findFirst({ where: { id: projectId, teamId }, select: {
      version: true, archivedAt: true, primaryParticipant: { select: { id: true, userId: true } },
      supportMembers: { select: { participant: { select: { id: true, userId: true } } } },
    } });
    if (!project) return { ok: false as const, status: 404, code: "PROJECT_NOT_FOUND", message: "案件が見つかりません。" };
    const current = { primaryUserId: project.primaryParticipant.userId, supportUserIds: project.supportMembers.map(row => row.participant.userId) };
    if (!canArchiveProject(userId, teamId, membership, current)) return { ok: false as const, status: 403, code: "PROJECT_EDIT_DENIED", message: "アーカイブ・復元できるのは現在のチーム管理者または案件の主担当です。" };
    if (project.version !== input.expectedVersion || preview?.version !== project.version) return { ok: false as const, status: 409, code: "PROJECT_VERSION_CONFLICT", message: "案件が更新されています。対象の詳細を取得して確認してください。" };
    const plan = planProjectArchiveChange(project.archivedAt !== null, input);
    if (!plan.ok) return { ok: false as const, status: 409, code: plan.code, message: "通常の案件の担当変更は担当変更APIを使ってください。" };
    if (!plan.changed) return { ok: true as const, project: { id: projectId, version: project.version, archivedAt: project.archivedAt?.toISOString() ?? null }, changed: false };
    const next = input.assignees ?? current;
    if (!input.archived && [next.primaryUserId, ...next.supportUserIds].some(id => !memberships.some(row => row.userId === id && (row.role === "admin" || row.role === "member")))) {
      return { ok: false as const, status: 409, code: "INACTIVE_ASSIGNEES", message: "現在所属していない担当者がいます。主担当と副担当一覧を現在の所属者から指定して復元してください。" };
    }
    const diff = diffProjectAssignees(current, next);
    const assignmentChanged = diff.primaryChanged || diff.addedUserIds.length > 0 || diff.removedUserIds.length > 0;
    const participants = new Map(project.supportMembers.map(row => [row.participant.userId, row.participant.id]));
    participants.set(current.primaryUserId, project.primaryParticipant.id);
    let history: Prisma.ProjectAssignmentHistoryCreateManyInput[] = [];
    if (assignmentChanged) {
      for (const id of [...new Set([userId, next.primaryUserId, ...next.supportUserIds])].sort()) {
        const person = await tx.teamParticipant.upsert({ where: { teamId_userId: { teamId, userId: id } }, create: { teamId, userId: id }, update: {}, select: { id: true } });
        participants.set(id, person.id);
      }
      const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
      const names = new Map(users.map(row => [row.id, row.name]));
      const common = { teamId, projectId, changedByParticipantId: participants.get(userId)!, changedByNameSnapshot: names.get(userId)!, changedAt: new Date() };
      if (diff.primaryChanged) history.push({ ...common, id: randomUUID(), kind: "PRIMARY_CHANGE", previousParticipantId: participants.get(current.primaryUserId)!, previousNameSnapshot: names.get(current.primaryUserId)!, nextParticipantId: participants.get(next.primaryUserId)!, nextNameSnapshot: names.get(next.primaryUserId)! });
      history = history.concat(diff.removedUserIds.map(id => ({ ...common, id: randomUUID(), kind: "SUPPORT_REMOVE" as const, previousParticipantId: participants.get(id)!, previousNameSnapshot: names.get(id)!, nextParticipantId: null, nextNameSnapshot: null })),
        diff.addedUserIds.map(id => ({ ...common, id: randomUUID(), kind: "SUPPORT_ADD" as const, previousParticipantId: null, previousNameSnapshot: null, nextParticipantId: participants.get(id)!, nextNameSnapshot: names.get(id)! })));
    }
    const archivedAt = input.archived ? new Date() : null;
    const updated = await tx.project.updateMany({ where: { id: projectId, teamId, version: input.expectedVersion },
      data: { archivedAt, version: { increment: 1 }, ...(assignmentChanged ? { primaryParticipantId: participants.get(next.primaryUserId)! } : {}) } });
    if (updated.count !== 1) throw new Error("Locked project update failed");
    if (diff.removedUserIds.length) await tx.projectSupportMember.deleteMany({ where: { teamId, projectId, participantId: { in: diff.removedUserIds.map(id => participants.get(id)!) } } });
    if (diff.addedUserIds.length) await tx.projectSupportMember.createMany({ data: diff.addedUserIds.map(id => ({ teamId, projectId, participantId: participants.get(id)! })) });
    if (history.length) await tx.projectAssignmentHistory.createMany({ data: history });
    return { ok: true as const, project: { id: projectId, version: project.version + 1, archivedAt: archivedAt?.toISOString() ?? null }, changed: true };
  });
}
