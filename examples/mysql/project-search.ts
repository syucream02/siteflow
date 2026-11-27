import type { Prisma, PrismaClient } from './generated/integrated/client.ts';
import type { ProjectSearchQuery } from '../../lib/siteflow/domain.ts';

// LIKEの記号を文字として検索する。SQL文字列の組み立てはPrismaに任せる。
export function escapeSearchLiteral(value: string): string { return value.replace(/[\\%_]/g, '\\$&'); }

export async function searchProjects(prisma: PrismaClient, userId: string, teamId: string, archived: boolean, query: NonNullable<ProjectSearchQuery>) {
  const scope: Prisma.ProjectWhereInput = {
    teamId, archivedAt: archived ? { not: null } : null,
    team: { teammemberships: { some: { userId, role: { in: ['admin', 'member'] } } } },
  };
  const conditions: Prisma.ProjectWhereInput[] = [scope];
  if (query.q) {
    const contains = escapeSearchLiteral(query.q);
    conditions.push({ OR: [{ name: { contains } }, { code: { contains } }] });
  }
  if (query.primaryUserId) conditions.push({ primaryParticipant: { teamId, userId: query.primaryUserId } });
  if (query.supportUserId) conditions.push({ supportMembers: { some: { teamId, participant: { teamId, userId: query.supportUserId } } } });
  if (query.status) conditions.push({ status: query.status });
  if (query.progressMin !== undefined || query.progressMax !== undefined) conditions.push({ progress: { gte: query.progressMin, lte: query.progressMax } });
  const where: Prisma.ProjectWhereInput = { AND: conditions };
  // 件数・カーソル・一覧が同じスナップショットと認可条件を見る。
  return prisma.$transaction(async tx => {
    const cursor = query.cursor ? await tx.project.findFirst({ where: { AND: [where, { id: query.cursor }] }, select: { id: true, dueDate: true } }) : null;
    if (query.cursor && !cursor) return { ok: false as const };
    const total = await tx.project.count({ where });
    const collectionTotal = conditions.length === 1 ? total : await tx.project.count({ where: scope });
    const rows = await tx.project.findMany({
      where: { AND: [where, ...(cursor ? [{ OR: [{ dueDate: { gt: cursor.dueDate } }, { dueDate: cursor.dueDate, id: { gt: cursor.id } }] }] : [])] },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: query.limit + 1,
      select: { id: true, name: true, code: true, dueDate: true, progress: true, status: true, archivedAt: true, version: true,
        primaryParticipant: { select: { id: true, user: { select: { name: true } } } } },
    });
    return { ok: true as const, total, collectionTotal, rows };
  }, { isolationLevel: 'RepeatableRead' });
}
