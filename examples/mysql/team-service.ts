import { randomUUID } from "node:crypto";
import { canCreateTeam } from "../../lib/siteflow/domain.ts";
import type { PrismaClient } from "./generated/integrated/client.ts";

type CreationResult =
  | { ok: true; team: { id: string; name: string }; role: "admin" }
  | { ok: false; status: 401 | 403; code: string; message: string };

// HTTPやCookieは扱わず、検証済みの名前と本人IDを受け取って一括保存する。
export async function createTeamForUser(prisma: PrismaClient, userId: string, name: string): Promise<CreationResult> {
  return prisma.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { emailVerified: true } });
    if (!user) return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "ログインが必要です。" };
    if (!canCreateTeam(user)) return { ok: false, status: 403, code: "EMAIL_NOT_VERIFIED", message: "チーム作成にはメール認証が必要です。" };
    const id = randomUUID();
    const createdAt = new Date();
    const team = await tx.team.create({
      data: { id, name, slug: `team-${id}`, createdAt }, select: { id: true, name: true },
    });
    await tx.teamMembership.create({ data: { id: randomUUID(), teamId: id, userId, role: "admin", createdAt } });
    return { ok: true, team, role: "admin" };
  });
}
