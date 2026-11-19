import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readSchemaCheckSettings } from "../examples/mysql/schema-check-settings.mjs";

// 通常のテスト実行ではDBへ接続しない。専用コマンドだけが明示的に有効化する。
const enabled = process.env.SITEFLOW_SCHEMA_CHECK === "1";

describe("分離したMySQLで所属と履歴の統合候補を検証する", { skip: !enabled, concurrency: false }, () => {
  let prisma;
  let settings;
  const id = () => randomUUID();
  const f = {
    adminA: id(), former: id(), adminB: id(), teamA: id(), teamB: id(),
    memberFormer: id(), actorAdminA: id(), actorFormer: id(), actorB: id(),
    project: id(), progressHistory: id(), assignmentHistory: id(),
    formerName: "検証 旧担当", adminName: "検証 管理者A",
  };
  const projectData = (overrides = {}) => ({
    id: id(), teamId: f.teamA, name: "拒否条件の検証用案件",
    primaryParticipantId: f.actorAdminA, createdByParticipantId: f.actorFormer,
    createdByNameSnapshot: f.formerName, dueDate: new Date("2026-12-31T00:00:00.000Z"),
    ...overrides,
  });
  const progressData = (overrides = {}) => ({
    id: id(), teamId: f.teamA, projectId: f.project,
    changedByParticipantId: f.actorFormer, changedByNameSnapshot: f.formerName,
    previousProgress: 50, nextProgress: 100,
    previousStatus: "IN_PROGRESS", nextStatus: "DONE", ...overrides,
  });
  const assignmentData = (overrides = {}) => ({
    id: id(), teamId: f.teamA, projectId: f.project, kind: "PRIMARY_CHANGE",
    previousParticipantId: f.actorFormer, nextParticipantId: f.actorAdminA,
    changedByParticipantId: f.actorAdminA, previousNameSnapshot: f.formerName,
    nextNameSnapshot: f.adminName, changedByNameSnapshot: f.adminName, ...overrides,
  });
  const rejectsWith = (promise, code) => assert.rejects(promise, (error) => error?.code === code);

  before(async () => {
    settings = readSchemaCheckSettings();
    const fromExample = createRequire(new URL("../examples/mysql/package.json", import.meta.url));
    const { PrismaMariaDb } = fromExample("@prisma/adapter-mariadb");
    const { PrismaClient } = await import("../examples/mysql/generated/integrated/client.ts");
    prisma = new PrismaClient({ adapter: new PrismaMariaDb({
      host: "127.0.0.1", port: settings.port, user: settings.user,
      password: settings.password, database: settings.database,
      connectionLimit: 1, connectTimeout: 5000, acquireTimeout: 5000,
    }) });
    const rows = await prisma.$queryRaw`SELECT DATABASE() AS current_database`;
    assert.equal(rows[0].current_database, settings.database);

    await prisma.user.createMany({ data: [
      { id: f.adminA, name: f.adminName, email: `${f.adminA}@example.invalid`, emailVerified: true },
      { id: f.former, name: f.formerName, email: `${f.former}@example.invalid`, emailVerified: true },
      { id: f.adminB, name: "検証 管理者B", email: `${f.adminB}@example.invalid`, emailVerified: true },
    ] });
    await prisma.team.createMany({ data: [
      { id: f.teamA, name: "検証チームA", slug: `check-${f.teamA}`, createdAt: new Date() },
      { id: f.teamB, name: "検証チームB", slug: `check-${f.teamB}`, createdAt: new Date() },
    ] });
    await prisma.teamMembership.createMany({ data: [
      { id: id(), teamId: f.teamA, userId: f.adminA, role: "admin", createdAt: new Date() },
      { id: f.memberFormer, teamId: f.teamA, userId: f.former, role: "member", createdAt: new Date() },
      { id: id(), teamId: f.teamB, userId: f.adminB, role: "admin", createdAt: new Date() },
    ] });
    await prisma.teamParticipant.createMany({ data: [
      { id: f.actorAdminA, teamId: f.teamA, userId: f.adminA },
      { id: f.actorFormer, teamId: f.teamA, userId: f.former },
      { id: f.actorB, teamId: f.teamB, userId: f.adminB },
    ] });
    await prisma.project.create({ data: projectData({ id: f.project, name: "完了済みの履歴保持検証案件", status: "DONE", progress: 100 }) });
    await prisma.projectSupportMember.create({ data: { teamId: f.teamA, projectId: f.project, participantId: f.actorFormer } });
    await prisma.projectProgressHistory.create({ data: progressData({ id: f.progressHistory }) });
    await prisma.projectAssignmentHistory.create({ data: assignmentData({ id: f.assignmentHistory }) });
  });

  after(async () => { await prisma?.$disconnect(); });

  it("接続ユーザーの権限が検証専用DBの範囲に限られる", async () => {
    const rows = await prisma.$queryRaw`SHOW GRANTS FOR CURRENT_USER`;
    const grants = rows.map((row) => String(Object.values(row)[0]));
    assert.ok(grants.some((grant) => grant.includes(` ON \`${settings.database}\`.* TO `)));
    assert.ok(grants.every((grant) => grant.startsWith("GRANT USAGE ON *.* TO ") || grant.includes(` ON \`${settings.database}\`.* TO `)));
  });

  it("同じ人の同じチームへの所属の重複をDBが拒否する", async () => {
    await rejectsWith(prisma.teamMembership.create({ data: { id: id(), teamId: f.teamA, userId: f.former, role: "member", createdAt: new Date() } }), "P2002");
  });

  it("人物記録のチームとユーザーの重複をDBが拒否する", async () => {
    await rejectsWith(prisma.teamParticipant.create({ data: { teamId: f.teamA, userId: f.former } }), "P2002");
  });

  it("別チームの人物を主担当・作成者に指定できない", async () => {
    await rejectsWith(prisma.project.create({ data: projectData({ primaryParticipantId: f.actorB }) }), "P2003");
    await rejectsWith(prisma.project.create({ data: projectData({ createdByParticipantId: f.actorB }) }), "P2003");
  });

  it("副担当と案件のどちらもチーム境界をまたげない", async () => {
    await rejectsWith(prisma.projectSupportMember.create({ data: { teamId: f.teamA, projectId: f.project, participantId: f.actorB } }), "P2003");
    await rejectsWith(prisma.projectSupportMember.create({ data: { teamId: f.teamB, projectId: f.project, participantId: f.actorB } }), "P2003");
  });

  it("進捗履歴の変更者に別チームの人物を指定できない", async () => {
    await rejectsWith(prisma.projectProgressHistory.create({ data: progressData({ changedByParticipantId: f.actorB }) }), "P2003");
  });

  it("担当履歴の変更前・変更後・変更者もチーム境界をまたげない", async () => {
    for (const field of ["previousParticipantId", "nextParticipantId", "changedByParticipantId"]) {
      await rejectsWith(prisma.projectAssignmentHistory.create({ data: assignmentData({ [field]: f.actorB }) }), "P2003");
    }
  });

  it("Prismaの型検査を通さないSQLでもownerという役割は保存できない", async () => {
    const validId = id();
    const invalidId = id();
    await prisma.$executeRaw`INSERT INTO TeamMembership (id, teamId, userId, role, createdAt) VALUES (${validId}, ${f.teamA}, ${f.adminB}, ${"member"}, CURRENT_TIMESTAMP(3))`;
    assert.equal(await prisma.teamMembership.count({ where: { id: validId } }), 1);
    await prisma.teamMembership.delete({ where: { id: validId } });
    await rejectsWith(prisma.$executeRaw`INSERT INTO TeamMembership (id, teamId, userId, role, createdAt) VALUES (${invalidId}, ${f.teamA}, ${f.adminB}, ${"owner"}, CURRENT_TIMESTAMP(3))`, "P2010");
    assert.equal(await prisma.teamMembership.count({ where: { id: invalidId } }), 0);
  });

  it("現在の表示名を変えても作成時・変更時の名前を保持する", async () => {
    await prisma.user.update({ where: { id: f.former }, data: { name: "検証 新表示名" } });
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: f.project } })).createdByNameSnapshot, f.formerName);
    assert.equal((await prisma.projectProgressHistory.findUniqueOrThrow({ where: { id: f.progressHistory } })).changedByNameSnapshot, f.formerName);
    assert.equal((await prisma.projectAssignmentHistory.findUniqueOrThrow({ where: { id: f.assignmentHistory } })).previousNameSnapshot, f.formerName);
  });

  it("完了案件の旧担当の所属を削除しても案件・人物・履歴が残る", async () => {
    await prisma.teamMembership.delete({ where: { id: f.memberFormer } });
    assert.equal(await prisma.teamMembership.count({ where: { teamId: f.teamA, userId: f.former } }), 0);
    assert.equal((await prisma.teamParticipant.findUniqueOrThrow({ where: { id: f.actorFormer } })).userId, f.former);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: f.project } })).createdByParticipantId, f.actorFormer);
    assert.equal(await prisma.projectProgressHistory.count({ where: { id: f.progressHistory } }), 1);
    assert.equal(await prisma.projectAssignmentHistory.count({ where: { id: f.assignmentHistory } }), 1);
    assert.equal(await prisma.projectSupportMember.count({ where: { projectId: f.project, participantId: f.actorFormer } }), 1);
  });

  it("再参加で人物記録を再利用し、以前の履歴も同じ人物へつながる", async () => {
    const membership = await prisma.teamMembership.create({ data: { id: id(), teamId: f.teamA, userId: f.former, role: "member", createdAt: new Date() } });
    const participant = await prisma.teamParticipant.upsert({
      where: { teamId_userId: { teamId: f.teamA, userId: f.former } },
      update: {}, create: { teamId: f.teamA, userId: f.former },
    });
    assert.equal(participant.id, f.actorFormer);
    assert.equal((await prisma.projectAssignmentHistory.findUniqueOrThrow({ where: { id: f.assignmentHistory } })).previousParticipantId, participant.id);
    await prisma.teamMembership.delete({ where: { id: membership.id } });
  });

  it("所属を削除済みでも、参照される人物・ユーザー・チームの物理削除を拒否する", async () => {
    await rejectsWith(prisma.teamParticipant.delete({ where: { id: f.actorFormer } }), "P2003");
    await rejectsWith(prisma.user.delete({ where: { id: f.former } }), "P2003");
    await rejectsWith(prisma.team.delete({ where: { id: f.teamA } }), "P2003");
  });

  it("履歴の保存に失敗すると同じトランザクションの案件更新も戻る", async () => {
    const before = await prisma.project.findUniqueOrThrow({ where: { id: f.project } });
    const count = await prisma.projectProgressHistory.count({ where: { projectId: f.project } });
    await rejectsWith(prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: f.project }, data: { progress: 75, version: { increment: 1 } } });
      await tx.projectProgressHistory.create({ data: progressData({ changedByParticipantId: f.actorB }) });
    }), "P2003");
    const after = await prisma.project.findUniqueOrThrow({ where: { id: f.project } });
    assert.equal(after.progress, before.progress);
    assert.equal(after.version, before.version);
    assert.equal(await prisma.projectProgressHistory.count({ where: { projectId: f.project } }), count);
  });
});
