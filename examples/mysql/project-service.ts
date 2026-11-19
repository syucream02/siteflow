import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "./generated/integrated/client.ts";
import { planProjectProgressUpdate, type UpdateProjectProgressInput } from "../../lib/siteflow/domain.ts";
import { planProjectStatusChange, type ChangeProjectStatusInput } from "../../lib/siteflow/domain.ts";
import { canCreateProject, canReadTeam, canEditProject, diffProjectAssignees, type ChangeProjectAssigneesInput, type CreateProjectInput, type EditProjectInput } from "../../lib/siteflow/domain.ts";

export async function changeProjectStatusForUser(prisma: PrismaClient, userId: string, teamId: string, projectId: string, input: ChangeProjectStatusInput) {
  // 所属→案件のロック順を保つため、担当IDと版だけ先に読む。保存判断にはロック後の値を使う。
  const preview = await prisma.project.findFirst({ where: { id: projectId, teamId, archivedAt: null,
    team: { teammemberships: { some: { userId, role: { in: ["admin", "member"] } } } } }, select: {
    version: true, primaryParticipant: { select: { userId: true } }, supportMembers: { select: { participant: { select: { userId: true } } } },
  } });
  const userIds = [...new Set([userId, ...(preview ? [preview.primaryParticipant.userId, ...preview.supportMembers.map(row => row.participant.userId)] : [])])].sort();
  return prisma.$transaction(async tx => {
    const memberships = await tx.$queryRaw<{ teamId: string; userId: string; role: string }[]>(Prisma.sql`
      SELECT teamId, userId, role FROM TeamMembership WHERE teamId = ${teamId}
      AND userId IN (${Prisma.join(userIds)}) ORDER BY userId FOR UPDATE
    `);
    const membership = memberships.find(row => row.userId === userId) ?? null;
    if (!canReadTeam(userId, teamId, membership)) return { ok: false as const, status: 403, code: "TEAM_ACCESS_DENIED", message: "このチームへのアクセスは許可されていません。" };
    await tx.$queryRaw(Prisma.sql`SELECT id FROM Project WHERE id = ${projectId} AND teamId = ${teamId} AND archivedAt IS NULL FOR UPDATE`);
    const project = await tx.project.findFirst({ where: { id: projectId, teamId, archivedAt: null }, select: {
      progress: true, status: true, version: true, primaryParticipant: { select: { userId: true } },
      supportMembers: { select: { participant: { select: { userId: true } } } },
    } });
    if (!project) return { ok: false as const, status: 404, code: "PROJECT_NOT_FOUND", message: "案件が見つかりません。" };
    const assignment = { primaryUserId: project.primaryParticipant.userId, supportUserIds: project.supportMembers.map(row => row.participant.userId) };
    if (!canEditProject(userId, teamId, membership, assignment)) return { ok: false as const, status: 403, code: "PROJECT_EDIT_DENIED", message: "状態を変更できるのは現在の管理者・主担当・副担当です。" };
    if (project.version !== input.expectedVersion || preview?.version !== project.version) return { ok: false as const, status: 409, code: "PROJECT_VERSION_CONFLICT", message: "案件が更新されています。最新の詳細と担当一覧を取得して確認してください。" };
    const plan = planProjectStatusChange(project, input);
    if (!plan.ok) {
      const messages = {
        INVALID_STATUS_TRANSITION: "この状態へは変更できません。確認待ちからのみ完了でき、完了からは進行中へ再開します。",
        PROGRESS_REQUIRED_FOR_COMPLETION: "完了にする前に進捗を100％にしてください。",
        REOPEN_REASON_REQUIRED: "完了した案件を再開する理由をcommentに記入してください。",
        COMMENT_WITHOUT_STATUS_CHANGE: "同じ状態のままメモだけを保存することはできません。",
      };
      return { ok: false as const, status: plan.code === "REOPEN_REASON_REQUIRED" || plan.code === "COMMENT_WITHOUT_STATUS_CHANGE" ? 400 : 409, code: plan.code, message: messages[plan.code] };
    }
    if (!plan.changed) return { ok: true as const, project: { id: projectId, progress: project.progress, status: project.status, version: project.version }, changed: false };
    if (plan.reopening && [assignment.primaryUserId, ...assignment.supportUserIds].some(id => !memberships.some(row => row.userId === id && (row.role === "admin" || row.role === "member")))) {
      return { ok: false as const, status: 409, code: "INACTIVE_ASSIGNEES", message: "現在所属していない担当者がいます。先に担当を変更してから再開してください。" };
    }
    const actor = await tx.teamParticipant.upsert({ where: { teamId_userId: { teamId, userId } }, create: { teamId, userId }, update: {}, select: { id: true } });
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    const updated = await tx.project.updateMany({ where: { id: projectId, teamId, archivedAt: null, version: input.expectedVersion }, data: { status: input.status, version: { increment: 1 } } });
    if (updated.count !== 1) throw new Error("Locked project update failed");
    await tx.projectProgressHistory.create({ data: { id: randomUUID(), teamId, projectId,
      previousProgress: project.progress, nextProgress: project.progress, previousStatus: project.status, nextStatus: input.status,
      changedByParticipantId: actor.id, changedByNameSnapshot: user.name, comment: input.comment, changedAt: new Date() } });
    return { ok: true as const, project: { id: projectId, progress: project.progress, status: input.status, version: project.version + 1 }, changed: true };
  });
}

export async function updateProjectProgressForUser(prisma: PrismaClient, userId: string, teamId: string, projectId: string, input: UpdateProjectProgressInput) {
  return prisma.$transaction(async tx => {
    const memberships = await tx.$queryRaw<{ teamId: string; userId: string; role: string }[]>(Prisma.sql`
      SELECT teamId, userId, role FROM TeamMembership WHERE teamId = ${teamId} AND userId = ${userId} FOR UPDATE
    `);
    const membership = memberships[0] ?? null;
    if (!canReadTeam(userId, teamId, membership)) return { ok: false as const, status: 403, code: "TEAM_ACCESS_DENIED", message: "このチームへのアクセスは許可されていません。" };
    await tx.$queryRaw(Prisma.sql`SELECT id FROM Project WHERE id = ${projectId} AND teamId = ${teamId} AND archivedAt IS NULL FOR UPDATE`);
    const project = await tx.project.findFirst({ where: { id: projectId, teamId, archivedAt: null }, select: {
      progress: true, status: true, version: true, primaryParticipant: { select: { userId: true } },
      supportMembers: { select: { participant: { select: { userId: true } } } },
    } });
    if (!project) return { ok: false as const, status: 404, code: "PROJECT_NOT_FOUND", message: "案件が見つかりません。" };
    if (!canEditProject(userId, teamId, membership, { primaryUserId: project.primaryParticipant.userId,
      supportUserIds: project.supportMembers.map(row => row.participant.userId) })) return { ok: false as const, status: 403, code: "PROJECT_EDIT_DENIED", message: "進捗を更新できるのは現在の管理者・主担当・副担当です。" };
    if (project.version !== input.expectedVersion) return { ok: false as const, status: 409, code: "PROJECT_VERSION_CONFLICT", message: "案件が更新されています。入力を控え、最新の詳細を取得して確認してください。" };
    const plan = planProjectProgressUpdate(project, input);
    if (!plan.ok) return { ok: false as const, status: plan.code === "PROJECT_COMPLETED" ? 409 : 400, code: plan.code,
      message: plan.code === "PROJECT_COMPLETED" ? "完了済み案件の進捗は変更できません。理由を記入して進行中へ再開してから変更してください。" : "進捗が同じ場合はメモだけを保存できません。変更する進捗と一緒に送信してください。" };
    if (!plan.changed) return { ok: true as const, project: { id: projectId, progress: project.progress, status: project.status, version: project.version }, changed: false };
    const actor = await tx.teamParticipant.upsert({ where: { teamId_userId: { teamId, userId } }, create: { teamId, userId }, update: {}, select: { id: true } });
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    const updated = await tx.project.updateMany({ where: { id: projectId, teamId, archivedAt: null, version: input.expectedVersion },
      data: { progress: input.progress, version: { increment: 1 } } });
    if (updated.count !== 1) throw new Error("Locked project update failed");
    await tx.projectProgressHistory.create({ data: { id: randomUUID(), teamId, projectId,
      previousProgress: project.progress, nextProgress: input.progress, previousStatus: project.status, nextStatus: project.status,
      changedByParticipantId: actor.id, changedByNameSnapshot: user.name, comment: input.comment, changedAt: new Date() } });
    return { ok: true as const, project: { id: projectId, progress: input.progress, status: project.status, version: project.version + 1 }, changed: true };
  });
}

export async function changeProjectAssigneesForUser(prisma: PrismaClient, userId: string, teamId: string, projectId: string, input: ChangeProjectAssigneesInput) {
  return prisma.$transaction(async tx => {
    const selectedIds = [...new Set([userId, input.primaryUserId, ...input.supportUserIds])].sort();
    // 基本編集と同じ順：所属→案件。複数所属はuserId順でロックする。
    const memberships = await tx.$queryRaw<{ teamId: string; userId: string; role: string }[]>(Prisma.sql`
      SELECT teamId, userId, role FROM TeamMembership WHERE teamId = ${teamId}
      AND userId IN (${Prisma.join(selectedIds)}) ORDER BY userId FOR UPDATE
    `);
    const membership = memberships.find(row => row.userId === userId) ?? null;
    if (!canReadTeam(userId, teamId, membership)) return { ok: false as const, status: 403, code: "TEAM_ACCESS_DENIED", message: "このチームへのアクセスは許可されていません。" };
    await tx.$queryRaw(Prisma.sql`SELECT id FROM Project WHERE id = ${projectId} AND teamId = ${teamId} AND archivedAt IS NULL FOR UPDATE`);
    const project = await tx.project.findFirst({ where: { id: projectId, teamId, archivedAt: null }, select: {
      version: true, primaryParticipant: { select: { id: true, userId: true } },
      supportMembers: { select: { participant: { select: { id: true, userId: true } } } },
    } });
    if (!project) return { ok: false as const, status: 404, code: "PROJECT_NOT_FOUND", message: "案件が見つかりません。" };
    const current = { primaryUserId: project.primaryParticipant.userId, supportUserIds: project.supportMembers.map(row => row.participant.userId) };
    if (!canEditProject(userId, teamId, membership, current)) return { ok: false as const, status: 403, code: "PROJECT_EDIT_DENIED", message: "担当変更できるのは現在の管理者・主担当・副担当です。" };
    if (project.version !== input.expectedVersion) return { ok: false as const, status: 409, code: "PROJECT_VERSION_CONFLICT", message: "案件が更新されています。最新の詳細と担当一覧を取得して、変更内容を確認してください。" };
    if (selectedIds.some(id => !memberships.some(row => row.userId === id && (row.role === "admin" || row.role === "member")))) {
      return { ok: false as const, status: 400, code: "INVALID_ASSIGNEES", message: "変更後の担当者は、このチームの現在の所属者から選んでください。" };
    }
    const diff = diffProjectAssignees(current, input);
    const changed = diff.primaryChanged || diff.addedUserIds.length > 0 || diff.removedUserIds.length > 0;
    if (!changed) return { ok: true as const, project: { id: projectId, version: project.version }, changed: false };
    const allIds = [...new Set([...selectedIds, current.primaryUserId, ...current.supportUserIds])];
    const users = await tx.user.findMany({ where: { id: { in: allIds } }, select: { id: true, name: true } });
    const names = new Map(users.map(row => [row.id, row.name]));
    const participants = new Map(project.supportMembers.map(row => [row.participant.userId, row.participant.id]));
    participants.set(current.primaryUserId, project.primaryParticipant.id);
    for (const id of selectedIds) {
      const person = await tx.teamParticipant.upsert({ where: { teamId_userId: { teamId, userId: id } }, create: { teamId, userId: id }, update: {}, select: { id: true } });
      participants.set(id, person.id);
    }
    const updated = await tx.project.updateMany({ where: { id: projectId, teamId, archivedAt: null, version: input.expectedVersion },
      data: { primaryParticipantId: participants.get(input.primaryUserId)!, version: { increment: 1 } } });
    // ロック済みなので0件は想定外。例外にして、先行upsertも含め巻き戻す。
    if (updated.count !== 1) throw new Error("Locked project update failed");
    if (diff.removedUserIds.length) await tx.projectSupportMember.deleteMany({ where: { teamId, projectId, participantId: { in: diff.removedUserIds.map(id => participants.get(id)!) } } });
    if (diff.addedUserIds.length) await tx.projectSupportMember.createMany({ data: diff.addedUserIds.map(id => ({ teamId, projectId, participantId: participants.get(id)! })) });
    const common = { teamId, projectId, changedByParticipantId: participants.get(userId)!, changedByNameSnapshot: names.get(userId)!, changedAt: new Date() };
    const history: Prisma.ProjectAssignmentHistoryCreateManyInput[] = [];
    if (diff.primaryChanged) history.push({ ...common, id: randomUUID(), kind: "PRIMARY_CHANGE", previousParticipantId: participants.get(current.primaryUserId)!, previousNameSnapshot: names.get(current.primaryUserId)!, nextParticipantId: participants.get(input.primaryUserId)!, nextNameSnapshot: names.get(input.primaryUserId)! });
    for (const id of diff.removedUserIds) history.push({ ...common, id: randomUUID(), kind: "SUPPORT_REMOVE", previousParticipantId: participants.get(id)!, previousNameSnapshot: names.get(id)!, nextParticipantId: null, nextNameSnapshot: null });
    for (const id of diff.addedUserIds) history.push({ ...common, id: randomUUID(), kind: "SUPPORT_ADD", previousParticipantId: null, previousNameSnapshot: null, nextParticipantId: participants.get(id)!, nextNameSnapshot: names.get(id)! });
    await tx.projectAssignmentHistory.createMany({ data: history });
    return { ok: true as const, project: { id: projectId, version: project.version + 1 }, changed: true };
  });
}

export async function editProjectForUser(prisma: PrismaClient, userId: string, teamId: string, projectId: string, input: EditProjectInput) {
  return prisma.$transaction(async tx => {
    const memberships = await tx.$queryRaw<{ teamId: string; userId: string; role: string }[]>(Prisma.sql`
      SELECT teamId, userId, role FROM TeamMembership WHERE teamId = ${teamId} AND userId = ${userId} FOR UPDATE
    `);
    const membership = memberships[0] ?? null;
    if (!canReadTeam(userId, teamId, membership)) {
      return { ok: false as const, status: 403, code: "TEAM_ACCESS_DENIED", message: "このチームへのアクセスは許可されていません。" };
    }
    // 編集同士を直列化してから権限と版番号を確認する。古い版は待機後も保存しない。
    await tx.$queryRaw(Prisma.sql`SELECT id FROM Project WHERE id = ${projectId} AND teamId = ${teamId} AND archivedAt IS NULL FOR UPDATE`);
    const project = await tx.project.findFirst({ where: { id: projectId, teamId, archivedAt: null }, select: {
      version: true, primaryParticipant: { select: { userId: true } },
      supportMembers: { select: { participant: { select: { userId: true } } } },
    } });
    if (!project) return { ok: false as const, status: 404, code: "PROJECT_NOT_FOUND", message: "案件が見つかりません。" };
    if (!canEditProject(userId, teamId, membership, { primaryUserId: project.primaryParticipant.userId,
      supportUserIds: project.supportMembers.map(row => row.participant.userId) })) {
      return { ok: false as const, status: 403, code: "PROJECT_EDIT_DENIED", message: "編集できるのは現在の管理者・主担当・副担当です。" };
    }
    const { dueDate, ...changes } = input.changes;
    const updated = await tx.project.updateMany({ where: { id: projectId, teamId, archivedAt: null, version: input.expectedVersion },
      data: { ...changes, ...(dueDate === undefined ? {} : { dueDate: new Date(`${dueDate}T00:00:00Z`) }), version: { increment: 1 } } });
    if (updated.count !== 1) return { ok: false as const, status: 409, code: "PROJECT_VERSION_CONFLICT",
      message: "別の保存により案件が更新されています。入力を控え、最新の案件を取得して変更内容を確認してください。" };
    const saved = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: {
      id: true, name: true, dueDate: true, code: true, summary: true, clientName: true, notes: true, version: true,
    } });
    return { ok: true as const, project: { ...saved, dueDate: saved.dueDate.toISOString().slice(0, 10) } };
  });
}

type ProjectResult =
  | { ok: true; project: { id: string; name: string; dueDate: string; progress: number; status: string; version: number } }
  | { ok: false; status: 400 | 403; code: string; message: string };

export async function createProjectForUser(prisma: PrismaClient, userId: string, teamId: string, input: CreateProjectInput): Promise<ProjectResult> {
  return prisma.$transaction(async tx => {
    const userIds = [...new Set([userId, input.primaryUserId, ...input.supportUserIds])].sort();
    // 値はパラメーター化する。同じ所属行の削除・変更と保存が途中で交差しないようロックする。
    const memberships = await tx.$queryRaw<{ teamId: string; userId: string; role: string }[]>(Prisma.sql`
      SELECT teamId, userId, role FROM TeamMembership
      WHERE teamId = ${teamId} AND userId IN (${Prisma.join(userIds)}) ORDER BY userId FOR UPDATE
    `);
    if (!canCreateProject(userId, teamId, memberships.find(m => m.userId === userId) ?? null)) {
      return { ok: false, status: 403, code: "TEAM_ACCESS_DENIED", message: "このチームへのアクセスは許可されていません。" };
    }
    if (userIds.some(id => !memberships.some(m => m.userId === id && (m.role === "admin" || m.role === "member")))) {
      return { ok: false, status: 400, code: "INVALID_ASSIGNEES", message: "担当者は、このチームの現在の所属者から選んでください。" };
    }
    const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
    const names = new Map(users.map(user => [user.id, user.name]));
    const participants = new Map<string, string>();
    for (const id of userIds) {
      const person = await tx.teamParticipant.upsert({
        where: { teamId_userId: { teamId, userId: id } }, create: { teamId, userId: id }, update: {}, select: { id: true },
      });
      participants.set(id, person.id);
    }
    const primary = participants.get(input.primaryUserId)!;
    const actor = participants.get(userId)!;
    const project = await tx.project.create({ data: {
      id: randomUUID(), teamId, name: input.name, dueDate: new Date(`${input.dueDate}T00:00:00Z`),
      primaryParticipantId: primary, createdByParticipantId: actor, createdByNameSnapshot: names.get(userId)!,
      code: input.code, summary: input.summary, clientName: input.clientName, notes: input.notes,
      progress: 0, status: "NOT_STARTED", version: 1,
    }, select: { id: true, name: true, dueDate: true, progress: true, status: true, version: true } });
    if (input.supportUserIds.length > 0) await tx.projectSupportMember.createMany({ data: input.supportUserIds.map(id => ({ teamId, projectId: project.id, participantId: participants.get(id)! })) });
    const changedAt = new Date();
    await tx.projectAssignmentHistory.createMany({ data: [
      { id: randomUUID(), teamId, projectId: project.id, kind: "PRIMARY_CHANGE", previousParticipantId: null, previousNameSnapshot: null,
        nextParticipantId: primary, nextNameSnapshot: names.get(input.primaryUserId)!, changedByParticipantId: actor, changedByNameSnapshot: names.get(userId)!, changedAt },
      ...input.supportUserIds.map(id => ({ id: randomUUID(), teamId, projectId: project.id, kind: "SUPPORT_ADD" as const,
        previousParticipantId: null, previousNameSnapshot: null, nextParticipantId: participants.get(id)!, nextNameSnapshot: names.get(id)!,
        changedByParticipantId: actor, changedByNameSnapshot: names.get(userId)!, changedAt })),
    ] });
    return { ok: true, project: { ...project, dueDate: project.dueDate.toISOString().slice(0, 10) } };
  });
}
