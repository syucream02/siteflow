import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { request as httpRequest } from "node:http";

// 通常実行はDB・サーバーを起動しない。専用コマンドだけで有効化。
describe("専用DBとHTTP経由でログインの土台を検証する", {
  skip: process.env.SITEFLOW_AUTH_CHECK !== "1", concurrency: false,
}, () => {
  let api, password, verified, unverified, cookie;
  const createdTeamIds = [];
  const rollbackTeamIds = [];
  const createdProjectIds = [];
  const ids = [randomUUID(), randomUUID()];
  const teams = [randomUUID(), randomUUID()];
  const participantId = randomUUID();
  const otherParticipantId = randomUUID();
  const emptyTeamId = randomUUID();
  const archivedProjectId = randomUUID();
  const otherProjectId = randomUUID();
  const supportUserIds = Array.from({ length: 3 }, () => randomUUID());
  const supportParticipantIds = Array.from({ length: 3 }, () => randomUUID());
  const otherSupportParticipantId = randomUUID();
  const historyPrefix = randomUUID().slice(0, 24);
  const assignmentPrefix = randomUUID().slice(0, 24);
  const otherAssignmentId = randomUUID(), otherProjectAssignmentId = randomUUID(), archivedAssignmentId = randomUUID();
  const assignments = Array.from({ length: 23 }, (_, index) => ({
    id: assignmentPrefix + index.toString(16).padStart(12, "0"), teamId: teams[0],
    kind: ["PRIMARY_CHANGE", "SUPPORT_ADD", "SUPPORT_REMOVE"][index % 3],
    previousParticipantId: index % 3 === 1 ? null : index % 3 === 0 ? supportParticipantIds[2] : supportParticipantIds[0],
    nextParticipantId: index % 3 === 2 ? null : index % 3 === 0 ? participantId : supportParticipantIds[0],
    previousNameSnapshot: index % 3 === 1 ? null : index % 3 === 0 ? "当時の旧主担当" : "当時の外れた副担当",
    nextNameSnapshot: index % 3 === 2 ? null : index % 3 === 0 ? "当時の新主担当" : "当時の追加された副担当",
    changedByParticipantId: index === 0 ? supportParticipantIds[2] : participantId,
    changedByNameSnapshot: "当時の操作担当",
    changedAt: new Date(index < 12 ? "2026-11-13T11:00:00Z" : "2026-11-14T11:00:00Z"),
  }));
  const otherHistoryId = randomUUID(), otherProjectHistoryId = randomUUID(), archivedHistoryId = randomUUID();
  const histories = Array.from({ length: 23 }, (_, index) => ({
    id: historyPrefix + index.toString(16).padStart(12, "0"), teamId: teams[0],
    changedByParticipantId: index === 0 ? supportParticipantIds[2] : participantId,
    changedByNameSnapshot: index === 0 ? "当時の架空の旧担当" : "当時の架空の変更者",
    previousProgress: index * 4, nextProgress: index === 22 ? 100 : (index + 1) * 4,
    previousStatus: index === 0 ? "NOT_STARTED" : "IN_PROGRESS", nextStatus: index === 22 ? "DONE" : "IN_PROGRESS",
    comment: index % 2 === 0 ? null : "架空の進捗変更メモ",
    changedAt: new Date(index < 12 ? "2026-11-13T10:00:00Z" : "2026-11-14T10:00:00Z"),
  }));
  const expectedSupport = supportParticipantIds.map((participantId, index) => ({
    participantId, userId: supportUserIds[index], name: `架空の副担当${index + 1}`, isCurrentMember: index < 2,
  })).sort((a, b) => a.participantId < b.participantId ? -1 : 1);
  const projects = Array.from({ length: 23 }, (_, index) => ({
    id: randomUUID(), teamId: teams[0], name: `一覧検証の架空案件${index}`, code: index === 1 ? null : `CHECK-${index}`,
    dueDate: new Date(index < 12 ? "2026-12-01T00:00:00Z" : "2026-12-02T00:00:00Z"),
    primaryParticipantId: participantId, createdByParticipantId: participantId,
    createdByNameSnapshot: "架空ユーザー", status: index === 0 ? "DONE" : "NOT_STARTED", progress: index === 0 ? 100 : 0,
    notes: index === 1 ? null : "一覧では返さない検証用の備考",
    summary: index === 0 ? "詳細取得を確かめる架空の概要" : null,
    clientName: index === 0 ? "架空の発注者" : null,
  }));
  const expectedProjects = [...projects].sort((a, b) => a.dueDate - b.dueDate || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  before(async () => {
    const { startAuthCheckServer } = await import("../examples/mysql/auth-check.ts");
    const fromExample = createRequire(new URL("../examples/mysql/package.json", import.meta.url));
    const { hashPassword } = await import(pathToFileURL(fromExample.resolve("better-auth/crypto")).href);
    api = await startAuthCheckServer(0);
    password = randomBytes(24).toString("hex");
    verified = `${ids[0]}@example.invalid`;
    unverified = `${ids[1]}@example.invalid`;
    // メール送信の代用ではない。条件を固定するテストデータだけを直接作る。
    const hash = await hashPassword(password);
    for (const [index, email] of [verified, unverified].entries()) {
      await api.prisma.user.create({ data: {
        id: ids[index], email, name: "認証検証用の架空ユーザー", emailVerified: index === 0,
        accounts: { create: { id: randomUUID(), accountId: ids[index], providerId: "credential", password: hash } },
      } });
    }
    for (const [index, teamId] of teams.entries()) {
      await api.prisma.team.create({ data: {
        id: teamId, name: index === 0 ? "架空の所属チームA" : "非公開の架空チームB",
        slug: `access-check-${teamId}`, createdAt: new Date(),
        teammemberships: { create: {
          id: randomUUID(), userId: ids[index], role: index === 0 ? "member" : "admin", createdAt: new Date(),
        } },
      } });
    }
    await api.prisma.teamParticipant.create({ data: { id: participantId, teamId: teams[0], userId: ids[0] } });
    await api.prisma.teamParticipant.create({ data: { id: otherParticipantId, teamId: teams[1], userId: ids[1] } });
    await api.prisma.team.create({ data: {
      id: emptyTeamId, name: "案件0件の架空チーム", slug: `empty-${emptyTeamId}`, createdAt: new Date(),
      teammemberships: { create: { id: randomUUID(), userId: ids[0], role: "member", createdAt: new Date() } },
    } });
    await api.prisma.project.createMany({ data: [
      ...[...projects].reverse(),
      { ...projects[0], id: archivedProjectId, archivedAt: new Date() },
      { ...projects[0], id: otherProjectId, teamId: teams[1], primaryParticipantId: otherParticipantId, createdByParticipantId: otherParticipantId },
    ] });
    await api.prisma.user.createMany({ data: supportUserIds.map((id, index) => ({
      id, email: `${id}@example.invalid`, name: `架空の副担当${index + 1}`,
    })) });
    await api.prisma.teamMembership.createMany({ data: [
      ...supportUserIds.slice(0, 2).map(userId => ({ id: randomUUID(), teamId: teams[0], userId, role: "member", createdAt: new Date() })),
      { id: randomUUID(), teamId: teams[1], userId: supportUserIds[0], role: "member", createdAt: new Date() },
    ] });
    await api.prisma.teamParticipant.createMany({ data: [
      ...supportParticipantIds.map((id, index) => ({ id, teamId: teams[0], userId: supportUserIds[index] })),
      { id: otherSupportParticipantId, teamId: teams[1], userId: supportUserIds[0] },
    ] });
    // 完了案件の旧副担当も保持する。所属を外すAPIの検証ではない。
    await api.prisma.projectSupportMember.createMany({ data: [
      ...supportParticipantIds.map(participantId => ({ teamId: teams[0], projectId: projects[0].id, participantId })),
      { teamId: teams[0], projectId: projects[1].id, participantId: supportParticipantIds[0] },
      { teamId: teams[1], projectId: otherProjectId, participantId: otherSupportParticipantId },
    ] });
    // 更新APIは未実装。取得条件を固定するため、履歴だけを直接用意する。
    await api.prisma.projectProgressHistory.createMany({ data: [
      ...[...histories].reverse().map(h => ({ ...h, projectId: projects[0].id })),
      { ...histories[1], id: otherProjectHistoryId, projectId: projects[1].id },
      { ...histories[1], id: archivedHistoryId, projectId: archivedProjectId },
      { ...histories[1], id: otherHistoryId, projectId: otherProjectId, teamId: teams[1], changedByParticipantId: otherParticipantId },
    ] });
    await api.prisma.projectAssignmentHistory.createMany({ data: [
      ...[...assignments].reverse().map(h => ({ ...h, projectId: projects[0].id })),
      { ...assignments[0], id: otherProjectAssignmentId, projectId: projects[1].id },
      { ...assignments[0], id: archivedAssignmentId, projectId: archivedProjectId },
      { ...assignments[0], id: otherAssignmentId, projectId: otherProjectId, teamId: teams[1],
        previousParticipantId: otherSupportParticipantId, nextParticipantId: otherParticipantId, changedByParticipantId: otherParticipantId },
    ] });
  });
  after(async () => {
    if (!api) return;
    try {
      // このテスト専用ユーザーが作った追加チームだけを回収する。
      const added = await api.prisma.team.findMany({
        where: { id: { notIn: [...teams, emptyTeamId] }, teammemberships: { some: { userId: ids[0] } } }, select: { id: true },
      });
      const extraIds = [...new Set([...createdTeamIds, ...rollbackTeamIds, ...added.map(t => t.id)])];
      const allTeamIds = [...teams, emptyTeamId, ...extraIds];
      const stored = await api.prisma.project.findMany({ where: { teamId: { in: allTeamIds } }, select: { id: true } });
      const projectIds = [...new Set([...stored.map(p => p.id), ...createdProjectIds])];
      await api.prisma.projectAssignmentHistory.deleteMany({ where: { projectId: { in: projectIds } } });
      await api.prisma.projectProgressHistory.deleteMany({ where: { projectId: { in: projectIds } } });
      await api.prisma.projectSupportMember.deleteMany({ where: { projectId: { in: projectIds } } });
      await api.prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await api.prisma.teamMembership.deleteMany({ where: { teamId: { in: allTeamIds } } });
      await api.prisma.teamParticipant.deleteMany({ where: { teamId: { in: allTeamIds } } });
      await api.prisma.team.deleteMany({ where: { id: { in: allTeamIds } } });
      await api.prisma.user.deleteMany({ where: { id: { in: [...ids, ...supportUserIds] } } });
    }
    finally { await api.close(); }
  });
  const request = (path, options = {}) => fetch(api.origin + "/api/auth/" + path, options);
  const post = (path, body, extra = {}) => request(path, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: api.origin, ...extra },
    body: JSON.stringify(body),
  });
  const readTeam = (teamId, options = {}) => fetch(api.origin + `/api/teams/${teamId}/access`, {
    headers: cookie ? { Cookie: cookie } : {}, ...options,
  });
  const listProjects = (teamId = teams[0], query = "", options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects${query}`, {
    headers: cookie ? { Cookie: cookie } : {}, ...options,
  });
  const readProject = (projectId = projects[0].id, teamId = teams[0], options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects/${projectId}`, {
    headers: cookie ? { Cookie: cookie } : {}, ...options,
  });
  const readSupport = (projectId = projects[0].id, teamId = teams[0], query = "", options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects/${projectId}/support-members${query}`, {
    headers: cookie ? { Cookie: cookie } : {}, ...options,
  });
  const readHistory = (projectId = projects[0].id, teamId = teams[0], query = "", options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects/${projectId}/progress-history${query}`, {
    headers: cookie ? { Cookie: cookie } : {}, ...options,
  });
  const readAssignments = (projectId = projects[0].id, teamId = teams[0], query = "", options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects/${projectId}/assignment-history${query}`, {
    headers: cookie ? { Cookie: cookie } : {}, ...options,
  });
  const createTeam = (body, options = {}) => fetch(api.origin + "/api/teams", {
    method: "POST", headers: { Cookie: cookie, Origin: api.origin, "Content-Type": "application/json" },
    body: JSON.stringify(body), ...options,
  });
  const ownTeams = (query = "", options = {}) => fetch(api.origin + "/api/teams" + query, {
    headers: cookie ? { Cookie: cookie } : {}, ...options,
  });
  const candidateMembers = (teamId = teams[0], query = "", options = {}) => fetch(api.origin + `/api/teams/${teamId}/members${query}`, { headers: { Cookie: cookie }, ...options });
  const projectPayload = () => ({ name: "登録する架空の案件", dueDate: "2026-12-31", primaryUserId: ids[0] });
  const createProject = (body = projectPayload(), teamId = teams[0], options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects`, {
    method: "POST", headers: { Cookie: cookie, Origin: api.origin, "Content-Type": "application/json" }, body: JSON.stringify(body), ...options,
  });
  it("Cookieなしではセッションを返さず、追跡IDとno-storeを付ける", async () => {
    const response = await request("get-session");
    assert.equal(response.status, 200);
    assert.equal(await response.json(), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
  });
  it("間違ったパスワードを拒否し、セッションを作らない", async () => {
    const response = await post("sign-in/email", { email: verified, password: "wrong-password" });
    assert.equal(response.status, 401);
    assert.equal(await api.prisma.session.count({ where: { userId: ids[0] } }), 0);
  });
  it("チーム情報はCookieなしでは401とし、情報を返さない", async () => {
    const response = await readTeam(teams[0]);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "UNAUTHENTICATED");
    assert.equal((await listProjects()).status, 401);
    assert.equal((await readProject()).status, 401);
    assert.equal((await readSupport()).status, 401);
    assert.equal((await readHistory()).status, 401);
    assert.equal((await readAssignments()).status, 401);
  });
  it("未認証メールのログインを拒否する", async () => {
    const response = await post("sign-in/email", { email: unverified, password });
    assert.equal(response.status, 403);
    assert.equal(await api.prisma.session.count({ where: { userId: ids[1] } }), 0);
  });
  it("不正な入力・送信元・公開していない登録・HTTPメソッドを拒否する", async () => {
    assert.equal((await post("sign-in/email", { email: "invalid" })).status, 400);
    assert.equal((await post("sign-in/email", { email: verified, password }, { Origin: "https://example.invalid" })).status, 403);
    assert.equal((await request("sign-in/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: verified, password }),
    })).status, 403);
    // fetchはHost指定を上書きするため、生のHTTPクライアントで送信する。
    const hostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(api.origin + "/api/auth/get-session", { headers: { Host: "example.invalid" } }, res => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal((await post("sign-up/email", {})).status, 404);
    const method = await request("sign-out");
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "POST");
  });
  it("正しいログインでHttpOnly CookieとDBのセッションが作られる", async () => {
    const response = await post("sign-in/email", { email: verified, password });
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie();
    const session = cookies.find(value => value.includes("session_token="));
    assert.ok(session);
    assert.match(session, /HttpOnly/i);
    assert.match(session, /SameSite=Lax/i);
    cookie = session.split(";")[0];
    assert.equal(await api.prisma.session.count({ where: { userId: ids[0] } }), 1);
    const account = await api.prisma.account.findFirst({ where: { userId: ids[0] } });
    assert.notEqual(account.password, password);
  });
  it("Cookieを送ると本人を取得でき、改ざんしたCookieは使えない", async () => {
    const response = await request("get-session", { headers: { Cookie: cookie } });
    const body = await response.json();
    assert.equal(body.user.id, ids[0]);
    assert.equal("password" in body.user, false);
    const tampered = await request("get-session", { headers: { Cookie: cookie + "tampered" } });
    assert.equal(await tampered.json(), null);
    assert.equal((await readTeam(teams[0], { headers: { Cookie: cookie + "tampered" } })).status, 401);
    assert.equal((await listProjects(teams[0], "", { headers: { Cookie: cookie + "tampered" } })).status, 401);
    assert.equal((await readProject(projects[0].id, teams[0], { headers: { Cookie: cookie + "tampered" } })).status, 401);
    assert.equal((await readSupport(projects[0].id, teams[0], "", { headers: { Cookie: cookie + "tampered" } })).status, 401);
    assert.equal((await readHistory(projects[0].id, teams[0], "", { headers: { Cookie: cookie + "tampered" } })).status, 401);
    assert.equal((await readAssignments(projects[0].id, teams[0], "", { headers: { Cookie: cookie + "tampered" } })).status, 401);
  });
  it("memberとadminは自分のチーム情報だけ読め、応答に不要な列を含めない", async () => {
    for (const role of ["member", "admin"]) {
      await api.prisma.teamMembership.update({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } }, data: { role } });
      const response = await readTeam(teams[0]);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { team: { id: teams[0], name: "架空の所属チームA" }, role });
    }
  });
  it("案件一覧は納期・ID順で20件を返し、完了を含めアーカイブと他チームを除く", async () => {
    const response = await listProjects();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body.items.map(item => item.id), expectedProjects.slice(0, 20).map(p => p.id));
    assert.deepEqual(body.page, { limit: 20, hasMore: true, nextCursor: body.items[19].id });
    assert.deepEqual(Object.keys(body.items[0]).sort(), ["id", "name", "code", "dueDate", "progress", "status", "primaryAssignee"].sort());
    assert.match(body.items[0].dueDate, /^2026-12-0[12]$/);
    assert.deepEqual(body.items[0].primaryAssignee, { participantId, name: "認証検証用の架空ユーザー" });
    const all = await (await listProjects(teams[0], "?limit=50")).json();
    assert.equal(all.items.length, 23);
    assert.ok(all.items.some(p => p.status === "DONE"));
    assert.ok(all.items.every(p => p.id !== archivedProjectId && p.id !== otherProjectId));
  });
  it("案件詳細は基本項目・主担当・作成時の名前だけを選んで1件返す", async () => {
    const response = await readProject();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
    const { project } = await response.json();
    assert.deepEqual(Object.keys(project).sort(), ["id", "name", "code", "dueDate", "progress", "status", "summary", "clientName", "notes", "version", "createdAt", "updatedAt", "primaryAssignee", "createdBy", "canArchive"].sort());
    assert.equal(project.canArchive, true);
    assert.equal(project.id, projects[0].id);
    assert.equal(project.name, projects[0].name);
    assert.equal(project.code, projects[0].code);
    assert.equal(project.dueDate, "2026-12-01");
    assert.equal(project.progress, 100);
    assert.equal(project.status, "DONE");
    assert.equal(project.summary, projects[0].summary);
    assert.equal(project.clientName, projects[0].clientName);
    assert.equal(project.notes, projects[0].notes);
    assert.equal(project.version, 1);
    assert.match(project.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(project.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(project.primaryAssignee, { participantId, userId: ids[0], name: "認証検証用の架空ユーザー" });
    assert.deepEqual(project.createdBy, { participantId, nameSnapshot: "架空ユーザー" });
    assert.equal((await readProject(projects[0].id.toUpperCase(), teams[0].toUpperCase())).status, 200);
  });
  it("別チームの案件ID・アーカイブ・存在しない案件は同じ404とし、両チーム所属でも取り違えない", async () => {
    assert.equal((await readProject(otherProjectId, teams[1])).status, 403);
    const bodies = [];
    for (const projectId of [otherProjectId, archivedProjectId, randomUUID()]) {
      const response = await readProject(projectId);
      assert.equal(response.status, 404);
      bodies.push(await response.json());
    }
    assert.deepEqual(bodies[0], bodies[1]);
    assert.deepEqual(bodies[1], bodies[2]);
    const membershipId = randomUUID();
    await api.prisma.teamMembership.create({ data: { id: membershipId, teamId: teams[1], userId: ids[0], role: "member", createdAt: new Date() } });
    try {
      const allowed = await readProject(otherProjectId, teams[1]);
      assert.equal(allowed.status, 200);
      assert.equal((await allowed.json()).project.id, otherProjectId);
      assert.equal((await readProject(otherProjectId, teams[0])).status, 404);
      assert.equal((await readSupport(otherProjectId, teams[1])).status, 200);
      assert.equal((await readSupport(otherProjectId, teams[0])).status, 404);
      assert.equal((await readHistory(otherProjectId, teams[1])).status, 200);
      assert.equal((await readHistory(otherProjectId, teams[0])).status, 404);
      const otherAssignments = await readAssignments(otherProjectId, teams[1]);
      assert.equal(otherAssignments.status, 200);
      assert.equal((await otherAssignments.json()).items[0].id, otherAssignmentId);
      assert.equal((await readAssignments(otherProjectId, teams[0])).status, 404);
    } finally { await api.prisma.teamMembership.delete({ where: { id: membershipId } }); }
  });
  it("memberでも詳細を読め、任意項目のnullと現在の主担当名・作成時の名前を区別する", async () => {
    await api.prisma.teamMembership.update({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } }, data: { role: "member" } });
    await api.prisma.user.update({ where: { id: ids[0] }, data: { name: "名前変更後の架空ユーザー" } });
    try {
      const response = await readProject(projects[1].id);
      assert.equal(response.status, 200);
      const { project } = await response.json();
      assert.equal(project.summary, null);
      assert.equal(project.clientName, null);
      assert.equal(project.code, null);
      assert.equal(project.notes, null);
      assert.equal(project.primaryAssignee.name, "名前変更後の架空ユーザー");
      assert.equal(project.createdBy.nameSnapshot, "架空ユーザー");
    } finally { await api.prisma.user.update({ where: { id: ids[0] }, data: { name: "認証検証用の架空ユーザー" } }); }
  });
  it("詳細の不正なID・検索条件・更新メソッドを拒否する", async () => {
    assert.equal((await readProject("not-a-uuid")).status, 400);
    assert.equal((await readProject(projects[0].id, "not-a-uuid")).status, 400);
    const query = await fetch(api.origin + `/api/teams/${teams[0]}/projects/${projects[0].id}?teamId=${teams[1]}&role=admin`, { headers: { Cookie: cookie } });
    assert.equal(query.status, 400);
    const method = await readProject(projects[0].id, teams[0], { method: "DELETE", headers: { Cookie: cookie, Origin: api.origin } });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET, PATCH");
  });
  it("副担当を人物ID順に返し、現在の所属と残っている担当記録を区別する", async () => {
    const response = await readSupport();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
    assert.deepEqual(await response.json(), { items: expectedSupport, page: { limit: 20, hasMore: false, nextCursor: null } });
    // 副担当の所属変更は表示に反映するが、案件への関連は消さない。
    await api.prisma.teamMembership.delete({ where: { teamId_userId: { teamId: teams[0], userId: supportUserIds[0] } } });
    try {
      const body = await (await readSupport()).json();
      assert.equal(body.items.find(p => p.participantId === supportParticipantIds[0]).isCurrentMember, false);
      assert.equal(body.items.length, 3);
    } finally {
      await api.prisma.teamMembership.create({ data: { id: randomUUID(), teamId: teams[0], userId: supportUserIds[0], role: "member", createdAt: new Date() } });
    }
  });
  it("副担当を少しずつ取得しても重複・漏れがなく、最後は続きなしになる", async () => {
    const first = await (await readSupport(projects[0].id, teams[0], "?limit=2")).json();
    assert.deepEqual(first.items, expectedSupport.slice(0, 2));
    assert.equal(first.page.hasMore, true);
    const second = await (await readSupport(projects[0].id, teams[0], `?limit=2&cursor=${first.page.nextCursor}`)).json();
    assert.deepEqual([...first.items, ...second.items], expectedSupport);
    assert.deepEqual(second.page, { limit: 2, hasMore: false, nextCursor: null });
    const tail = await (await readSupport(projects[0].id, teams[0], `?cursor=${expectedSupport[2].participantId}`)).json();
    assert.deepEqual(tail.items, []);
    assert.equal(tail.page.hasMore, false);
  });
  it("副担当0人は空配列、対象外の案件は同じ404、未所属チームは403になる", async () => {
    const empty = await readSupport(projects[2].id);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { items: [], page: { limit: 20, hasMore: false, nextCursor: null } });
    const bodies = [];
    for (const id of [otherProjectId, archivedProjectId, randomUUID()]) {
      const response = await readSupport(id);
      assert.equal(response.status, 404);
      bodies.push(await response.json());
    }
    assert.deepEqual(bodies[0], bodies[1]);assert.deepEqual(bodies[1], bodies[2]);
    assert.equal((await readSupport(otherProjectId, teams[1])).status, 403);
  });
  it("副担当の件数・ID・目印の案件境界・検索条件と更新メソッドを検証する", async () => {
    for (const query of ["?limit=0", "?limit=51", "?limit=", "?limit=1.5", "?limit=2&limit=3", "?cursor=bad", "?cursor=", "?userId=fake", `?cursor=${supportParticipantIds[0]}&cursor=${supportParticipantIds[1]}`]) {
      assert.equal((await readSupport(projects[0].id, teams[0], query)).status, 400);
    }
    for (const cursor of [otherSupportParticipantId, participantId, randomUUID()]) {
      assert.equal((await readSupport(projects[0].id, teams[0], `?cursor=${cursor}`)).status, 400);
    }
    assert.equal((await readSupport(projects[1].id, teams[0], `?cursor=${supportParticipantIds[2]}`)).status, 400);
    for (const limit of [1, 50]) assert.equal((await readSupport(projects[0].id, teams[0], `?limit=${limit}`)).status, 200);
    assert.equal((await readSupport("bad")).status, 400);
    assert.equal((await readSupport(projects[0].id, "bad")).status, 400);
    const method = await readSupport(projects[0].id, teams[0], "", { method: "POST", headers: { Cookie: cookie, Origin: api.origin } });
    assert.equal(method.status, 405);assert.equal(method.headers.get("allow"), "GET");
  });
  it("進捗履歴は日時とIDの降順で20件を返し、変更時の名前を保持する", async () => {
    const response = await readHistory();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
    const body = await response.json();
    assert.deepEqual(body.items.map(h => h.id), [...histories].reverse().slice(0, 20).map(h => h.id));
    assert.deepEqual(body.page, { limit: 20, hasMore: true, nextCursor: body.items[19].id });
    assert.deepEqual(body.items[0], {
      id: histories[22].id, changedAt: "2026-11-14T10:00:00.000Z", previousProgress: 88, nextProgress: 100,
      previousStatus: "IN_PROGRESS", nextStatus: "DONE", comment: null,
      changedBy: { participantId, nameSnapshot: "当時の架空の変更者" },
    });
    await api.prisma.user.update({ where: { id: ids[0] }, data: { name: "現在は変更された架空の名前" } });
    try {
      const all = await (await readHistory(projects[0].id, teams[0], "?limit=50")).json();
      assert.equal(all.items.length, 23);
      assert.equal(all.items[0].changedBy.nameSnapshot, "当時の架空の変更者");
      assert.deepEqual(all.items[22].changedBy, { participantId: supportParticipantIds[2], nameSnapshot: "当時の架空の旧担当" });
      assert.equal(all.items[1].comment, "架空の進捗変更メモ");
      assert.equal(await api.prisma.teamMembership.count({ where: { userId: supportUserIds[2], teamId: teams[0] } }), 0);
    } finally { await api.prisma.user.update({ where: { id: ids[0] }, data: { name: "認証検証用の架空ユーザー" } }); }
  });
  it("担当変更履歴は3種類と変更前後のなしを表し、当時の名前を返す", async () => {
    const response = await readAssignments();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
    const body = await response.json();
    assert.deepEqual(body.items.map(h => h.id), [...assignments].reverse().slice(0, 20).map(h => h.id));
    assert.deepEqual(body.page, { limit: 20, hasMore: true, nextCursor: body.items[19].id });
    assert.deepEqual(body.items[0], {
      id: assignments[22].id, kind: "SUPPORT_ADD", changedAt: "2026-11-14T11:00:00.000Z",
      previousAssignee: null,
      nextAssignee: { participantId: supportParticipantIds[0], nameSnapshot: "当時の追加された副担当" },
      changedBy: { participantId, nameSnapshot: "当時の操作担当" },
    });
    await api.prisma.user.updateMany({ where: { id: { in: [ids[0], supportUserIds[0]] } }, data: { name: "変更した現在の架空の名前" } });
    try {
      const all = await (await readAssignments(projects[0].id, teams[0], "?limit=50")).json();
      assert.equal(all.items.length, 23);
      const primary = all.items.find(h => h.kind === "PRIMARY_CHANGE");
      assert.deepEqual(primary.previousAssignee, { participantId: supportParticipantIds[2], nameSnapshot: "当時の旧主担当" });
      assert.deepEqual(primary.nextAssignee, { participantId, nameSnapshot: "当時の新主担当" });
      assert.equal(primary.changedBy.nameSnapshot, "当時の操作担当");
      const added = all.items.find(h => h.kind === "SUPPORT_ADD");
      assert.equal(added.previousAssignee, null);
      assert.equal(added.nextAssignee.nameSnapshot, "当時の追加された副担当");
      const removed = all.items.find(h => h.kind === "SUPPORT_REMOVE");
      assert.deepEqual(removed.previousAssignee, { participantId: supportParticipantIds[0], nameSnapshot: "当時の外れた副担当" });
      assert.equal(removed.nextAssignee, null);
      assert.equal(all.items[22].changedBy.participantId, supportParticipantIds[2]);
    } finally {
      await api.prisma.user.update({ where: { id: ids[0] }, data: { name: "認証検証用の架空ユーザー" } });
      await api.prisma.user.update({ where: { id: supportUserIds[0] }, data: { name: "架空の副担当1" } });
    }
  });
  it("同時刻の担当変更履歴も重複・漏れなく古い順へ進み、末尾で続きなしになる", async () => {
    let cursor, hasMore = true;
    const collected = [];
    for (let page = 0; hasMore && page < 10; page++) {
      const response = await readAssignments(projects[0].id, teams[0], "?limit=3" + (cursor ? `&cursor=${cursor}` : ""));
      assert.equal(response.status, 200);
      const body = await response.json();
      collected.push(...body.items.map(h => h.id));
      ({ hasMore, nextCursor: cursor } = body.page);
    }
    assert.equal(hasMore, false);assert.equal(cursor, null);
    assert.deepEqual(collected, [...assignments].reverse().map(h => h.id));
    assert.equal(new Set(collected).size, 23);
    const tail = await (await readAssignments(projects[0].id, teams[0], `?cursor=${assignments[0].id}`)).json();
    assert.deepEqual(tail.items, []);assert.equal(tail.page.hasMore, false);
  });
  it("担当変更履歴0件と対象外案件を区別し、他チームやアーカイブを返さない", async () => {
    const empty = await readAssignments(projects[2].id);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { items: [], page: { limit: 20, hasMore: false, nextCursor: null } });
    const bodies = [];
    for (const id of [otherProjectId, archivedProjectId, randomUUID()]) {
      const response = await readAssignments(id);
      assert.equal(response.status, 404);bodies.push(await response.json());
    }
    assert.deepEqual(bodies[0], bodies[1]);assert.deepEqual(bodies[1], bodies[2]);
    assert.equal((await readAssignments(otherProjectId, teams[1])).status, 403);
  });
  it("担当変更履歴の不正な入力・別種類の目印・更新/削除メソッドを拒否する", async () => {
    for (const query of ["?limit=0", "?limit=51", "?limit=", "?limit=1.5", "?limit=2&limit=3", "?cursor=bad", "?cursor=", "?userId=fake", `?cursor=${assignments[0].id}&cursor=${assignments[1].id}`]) {
      assert.equal((await readAssignments(projects[0].id, teams[0], query)).status, 400);
    }
    const errors = [];
    for (const cursor of [otherAssignmentId, otherProjectAssignmentId, archivedAssignmentId, histories[0].id, randomUUID()]) {
      const response = await readAssignments(projects[0].id, teams[0], `?cursor=${cursor}`);
      assert.equal(response.status, 400);errors.push(await response.json());
    }
    assert.ok(errors.every(error => JSON.stringify(error) === JSON.stringify(errors[0])));
    for (const limit of [1, 50]) assert.equal((await readAssignments(projects[0].id, teams[0], `?limit=${limit}`)).status, 200);
    assert.equal((await readAssignments("bad")).status, 400);
    assert.equal((await readAssignments(projects[0].id, "bad")).status, 400);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const response = await readAssignments(projects[0].id, teams[0], "", { method, headers: { Cookie: cookie, Origin: api.origin } });
      assert.equal(response.status, 405);assert.equal(response.headers.get("allow"), "GET");
    }
    assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: projects[0].id } }), 23);
  });
  it("同じ日時の進捗履歴もページ移動で重複・漏れがなく、古い履歴へ続く", async () => {
    const collected = [];
    let cursor, hasMore = true;
    for (let page = 0; hasMore && page < 10; page++) {
      const response = await readHistory(projects[0].id, teams[0], "?limit=3" + (cursor ? `&cursor=${cursor}` : ""));
      assert.equal(response.status, 200);
      const body = await response.json();
      collected.push(...body.items.map(h => h.id));
      ({ hasMore, nextCursor: cursor } = body.page);
    }
    assert.equal(hasMore, false);assert.equal(cursor, null);
    assert.deepEqual(collected, [...histories].reverse().map(h => h.id));
    assert.equal(new Set(collected).size, 23);
    const tail = await (await readHistory(projects[0].id, teams[0], `?cursor=${histories[0].id}`)).json();
    assert.deepEqual(tail.items, []);assert.equal(tail.page.hasMore, false);
  });
  it("進捗履歴0件と対象外案件を区別し、他チーム・アーカイブを返さない", async () => {
    const empty = await readHistory(projects[2].id);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { items: [], page: { limit: 20, hasMore: false, nextCursor: null } });
    const bodies = [];
    for (const id of [otherProjectId, archivedProjectId, randomUUID()]) {
      const response = await readHistory(id);
      assert.equal(response.status, 404);bodies.push(await response.json());
    }
    assert.deepEqual(bodies[0], bodies[1]);assert.deepEqual(bodies[1], bodies[2]);
    assert.equal((await readHistory(otherProjectId, teams[1])).status, 403);
  });
  it("履歴の不正入力・目印の案件境界・更新と削除のメソッドを拒否する", async () => {
    for (const query of ["?limit=0", "?limit=51", "?limit=", "?limit=1.5", "?limit=2&limit=3", "?cursor=bad", "?cursor=", "?userId=fake", `?cursor=${histories[0].id}&cursor=${histories[1].id}`]) {
      assert.equal((await readHistory(projects[0].id, teams[0], query)).status, 400);
    }
    const errors = [];
    for (const cursor of [otherHistoryId, otherProjectHistoryId, archivedHistoryId, randomUUID()]) {
      const response = await readHistory(projects[0].id, teams[0], `?cursor=${cursor}`);
      assert.equal(response.status, 400);errors.push(await response.json());
    }
    assert.ok(errors.every(error => JSON.stringify(error) === JSON.stringify(errors[0])));
    for (const limit of [1, 50]) assert.equal((await readHistory(projects[0].id, teams[0], `?limit=${limit}`)).status, 200);
    assert.equal((await readHistory("bad")).status, 400);
    assert.equal((await readHistory(projects[0].id, "bad")).status, 400);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const response = await readHistory(projects[0].id, teams[0], "", { method, headers: { Cookie: cookie, Origin: api.origin } });
      assert.equal(response.status, 405);assert.equal(response.headers.get("allow"), "GET");
    }
    assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: projects[0].id } }), 23);
  });
  it("同じ納期でも続きの取得で重複・取りこぼしがなく、末尾はnextCursorがnullになる", async () => {
    let cursor, hasMore = true;
    const collected = [];
    for (let page = 0; hasMore && page < 10; page++) {
      const response = await listProjects(teams[0], "?limit=3" + (cursor ? `&cursor=${cursor}` : ""));
      assert.equal(response.status, 200);
      const body = await response.json();
      collected.push(...body.items.map(p => p.id));
      ({ hasMore, nextCursor: cursor } = body.page);
    }
    assert.equal(hasMore, false);
    assert.equal(cursor, null);
    assert.deepEqual(collected, expectedProjects.map(p => p.id));
    assert.equal(new Set(collected).size, 23);
  });
  it("所属チームに案件が0件なら空配列と続きなしを返す", async () => {
    const response = await listProjects(emptyTeamId);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [], page: { limit: 20, hasMore: false, nextCursor: null } });
  });
  it("別チームは403、別チーム・アーカイブ・不明な案件のカーソルは同じ400になる", async () => {
    assert.equal((await listProjects(teams[1], `?cursor=${projects[0].id}`)).status, 403);
    assert.equal((await listProjects(randomUUID())).status, 403);
    const bodies = [];
    for (const cursor of [otherProjectId, archivedProjectId, randomUUID()]) {
      const response = await listProjects(teams[0], `?cursor=${cursor}`);
      assert.equal(response.status, 400);
      bodies.push(await response.json());
    }
    assert.deepEqual(bodies[0], bodies[1]);
    assert.deepEqual(bodies[1], bodies[2]);
  });
  it("一覧の件数・カーソル・重複/未知の検索条件と更新メソッドを検証する", async () => {
    for (const query of ["?limit=0", "?limit=51", "?limit=", "?limit=2.5", "?limit=2&limit=3", "?cursor=bad", "?cursor=", "?userId=fake", `?cursor=${projects[0].id}&cursor=${projects[1].id}`]) {
      assert.equal((await listProjects(teams[0], query)).status, 400);
    }
    assert.equal((await listProjects(teams[0], "?limit=1")).status, 200);
    const response = await listProjects(teams[0], "", { method: "PATCH", headers: { Origin: api.origin, Cookie: cookie } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, POST");
  });
  it("他チームと存在しないチームを同じ403で拒否し、存在や名前を知らせない", async () => {
    const denied = await readTeam(teams[1]);
    const missing = await readTeam(randomUUID());
    assert.equal(denied.status, 403);
    assert.equal(missing.status, 403);
    const body = await denied.json();
    assert.deepEqual(body, await missing.json());
    assert.equal(body.code, "TEAM_ACCESS_DENIED");
    assert.equal("team" in body, false);
  });
  it("選択中チーム・偽のユーザーIDやroleを渡しても所属確認を回避できない", async () => {
    await api.prisma.session.updateMany({ where: { userId: ids[0] }, data: { activeOrganizationId: teams[1] } });
    const attack = await fetch(api.origin + `/api/teams/${teams[1]}/access?userId=${ids[1]}&role=admin&teamId=${teams[0]}`, {
      headers: { Cookie: cookie, "X-User-Id": ids[1], "X-Role": "admin", "X-Team-Id": teams[0] },
    });
    assert.equal(attack.status, 403);
    assert.equal((await listProjects(teams[1], "", { headers: { Cookie: cookie, "X-User-Id": ids[1], "X-Role": "admin" } })).status, 403);
    assert.equal((await readProject(otherProjectId, teams[1], { headers: { Cookie: cookie, "X-User-Id": ids[1], "X-Role": "admin" } })).status, 403);
    assert.equal((await readSupport(otherProjectId, teams[1], "", { headers: { Cookie: cookie, "X-User-Id": ids[1], "X-Role": "admin" } })).status, 403);
    assert.equal((await readHistory(otherProjectId, teams[1], "", { headers: { Cookie: cookie, "X-User-Id": ids[1], "X-Role": "admin" } })).status, 403);
    assert.equal((await readAssignments(otherProjectId, teams[1], "", { headers: { Cookie: cookie, "X-User-Id": ids[1], "X-Role": "admin" } })).status, 403);
    assert.equal((await readTeam(teams[0])).status, 200);
  });
  it("所属を外すと人物記録とログインが残っても403になり、再所属で同じ人物記録を利用できる", async () => {
    await api.prisma.teamMembership.delete({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } } });
    assert.equal(await api.prisma.teamParticipant.count({ where: { id: participantId } }), 1);
    const stillLoggedIn = await request("get-session", { headers: { Cookie: cookie } });
    assert.equal((await stillLoggedIn.json()).user.id, ids[0]);
    assert.equal((await readTeam(teams[0])).status, 403);
    assert.equal((await listProjects()).status, 403);
    assert.equal((await readProject()).status, 403);
    assert.equal((await readSupport()).status, 403);
    assert.equal((await readHistory()).status, 403);
    assert.equal((await readAssignments()).status, 403);
    assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: projects[0].id } }), 23);
    assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: projects[0].id } }), 23);
    await api.prisma.teamMembership.create({ data: {
      id: randomUUID(), teamId: teams[0], userId: ids[0], role: "member", createdAt: new Date(),
    } });
    assert.equal((await readTeam(teams[0])).status, 200);
    assert.equal((await listProjects()).status, 200);
    assert.equal((await readProject()).status, 200);
    assert.equal((await readSupport()).status, 200);
    assert.equal((await readHistory()).status, 200);
    assert.equal((await readAssignments()).status, 200);
    assert.equal(await api.prisma.teamParticipant.count({ where: { id: participantId } }), 1);
  });
  it("不正なチームIDとチーム情報への更新メソッドを拒否する", async () => {
    assert.equal((await readTeam("not-a-uuid")).status, 400);
    const response = await readTeam(teams[0], { method: "POST", headers: { Origin: api.origin, Cookie: cookie } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  });
  it("チーム作成は本人を管理者にし、そのチームを直後に取得できる", async () => {
    const response = await createTeam({ name: "　まとめて保存する架空チーム　" });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
    const body = await response.json();
    createdTeamIds.push(body.team.id);
    assert.deepEqual(body, { team: { id: body.team.id, name: "まとめて保存する架空チーム" }, role: "admin" });
    assert.match(body.team.id, /^[a-f0-9-]{36}$/);
    assert.equal(response.headers.get("location"), `/api/teams/${body.team.id}/access`);
    assert.equal((await readTeam(body.team.id)).status, 200);
    assert.deepEqual(await (await listProjects(body.team.id)).json(), { items: [], page: { limit: 20, hasMore: false, nextCursor: null } });
    const membership = await api.prisma.teamMembership.findMany({ where: { teamId: body.team.id } });
    assert.equal(membership.length, 1);assert.equal(membership[0].userId, ids[0]);assert.equal(membership[0].role, "admin");
    const team = await api.prisma.team.findUnique({ where: { id: body.team.id } });
    assert.equal(team.slug, `team-${body.team.id}`);
    assert.equal(await api.prisma.teamParticipant.count({ where: { teamId: body.team.id } }), 0);
    assert.equal((await readProject(projects[0].id, body.team.id)).status, 404);
  });
  it("同じ表示名や最大長でも別のIDとslugを持つチームを作成できる", async () => {
    for (const name of ["同じ架空チーム", "同じ架空チーム", "あ".repeat(80)]) {
      const response = await createTeam({ name });assert.equal(response.status, 201);
      createdTeamIds.push((await response.json()).team.id);
    }
    assert.equal(new Set(createdTeamIds).size, 4);
    const duplicates = await api.prisma.team.findMany({ where: { id: { in: createdTeamIds }, name: "同じ架空チーム" } });
    assert.equal(duplicates.length, 2);assert.notEqual(duplicates[0].slug, duplicates[1].slug);
  });
  it("チーム作成は不正本文・追加属性・Content-Type・送信元・過大な本文を保存前に拒否する", async () => {
    const before = await api.prisma.team.count();
    for (const body of [{ name: " " }, { name: "あ".repeat(81) }, { name: "改\n行" }, { name: 1 }, [], null, { name: "架空", userId: ids[1] }, { name: "架空", role: "owner" }, { name: "架空", slug: "chosen" }]) {
      assert.equal((await createTeam(body)).status, 400);
    }
    assert.equal((await createTeam({}, { body: "{" })).status, 400);
    assert.equal((await createTeam({}, { headers: { Cookie: cookie, Origin: api.origin, "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await createTeam({ name: "架空" }, { headers: { Cookie: cookie, Origin: "https://example.invalid", "Content-Type": "application/json" } })).status, 403);
    assert.equal((await createTeam({ name: "架空" }, { headers: { Cookie: cookie, "Content-Type": "application/json" } })).status, 403);
    assert.equal((await createTeam({ name: "a".repeat(5000) })).status, 413);
    assert.equal((await fetch(api.origin + "/api/teams?role=admin", { method: "POST", headers: { Cookie: cookie, Origin: api.origin, "Content-Type": "application/json" }, body: JSON.stringify({ name: "架空" }) })).status, 400);
    assert.equal(await api.prisma.team.count(), before);
  });
  it("ログイン済みCookieがあっても、DBでメール未認証になっていればチームを作れない", async () => {
    const before = await api.prisma.team.count();
    await api.prisma.user.update({ where: { id: ids[0] }, data: { emailVerified: false } });
    try {
      const response = await createTeam({ name: "作れない架空チーム" });
      assert.equal(response.status, 403);assert.equal((await response.json()).code, "EMAIL_NOT_VERIFIED");
      assert.equal(await api.prisma.team.count(), before);
    } finally { await api.prisma.user.update({ where: { id: ids[0] }, data: { emailVerified: true } }); }
  });
  it("管理者所属のDB保存に失敗したら、直前に作ったチームも取り消す", async () => {
    const { createTeamForUser } = await import("../examples/mysql/team-service.ts");
    const existing = await api.prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } } });
    let insertedId;
    const broken = api.prisma.$extends({ query: {
      team: { async create({ args, query }) { const row = await query(args);insertedId = row.id;rollbackTeamIds.push(row.id);return row; } },
      teamMembership: { async create({ args, query }) { return query({ ...args, data: { ...args.data, id: existing.id } }); } },
    } });
    await assert.rejects(createTeamForUser(broken, ids[0], "巻き戻しを確かめる架空チーム"), error => error.code === "P2002");
    assert.ok(insertedId);
    assert.equal(await api.prisma.team.findUnique({ where: { id: insertedId } }), null);
    assert.equal(await api.prisma.teamMembership.count({ where: { teamId: insertedId } }), 0);
  });
  it("自分のチーム一覧は本人の所属だけを返し、続きの取得と0件・不正条件を扱う", async () => {
    const first = await ownTeams("?limit=50");assert.equal(first.status, 200);
    const body = await first.json();
    const expectedIds = [teams[0], emptyTeamId, ...createdTeamIds].sort();
    assert.deepEqual(body.items.map(t => t.id), expectedIds);
    assert.ok(body.items.every(t => t.id !== teams[1]));
    assert.ok(body.items.filter(t => createdTeamIds.includes(t.id)).every(t => t.role === "admin"));
    assert.deepEqual(Object.keys(body.items[0]).sort(), ["id", "name", "role"]);
    const all = [];let cursor, hasMore = true;
    for (let page = 0; hasMore && page < 20; page++) {
      const response = await ownTeams("?limit=2" + (cursor ? `&cursor=${cursor}` : ""));assert.equal(response.status, 200);
      const part = await response.json();all.push(...part.items.map(t => t.id));({ hasMore, nextCursor: cursor } = part.page);
    }
    assert.equal(hasMore, false);assert.equal(cursor, null);assert.deepEqual(all, expectedIds);
    const tail = await (await ownTeams(`?cursor=${expectedIds[expectedIds.length - 1]}`)).json();assert.deepEqual(tail.items, []);
    for (const query of ["?limit=0", "?limit=51", "?limit=2&limit=3", "?cursor=bad", `?cursor=${teams[1]}`, `?cursor=${randomUUID()}`, "?userId=fake"]) assert.equal((await ownTeams(query)).status, 400);
    assert.equal((await ownTeams("", { method: "DELETE" })).status, 405);
    const transient = await api.prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId: createdTeamIds[0], userId: ids[0] } } });
    await api.prisma.teamMembership.delete({ where: { id: transient.id } });
    try { assert.equal((await ownTeams(`?cursor=${createdTeamIds[0]}`)).status, 400); }
    finally { await api.prisma.teamMembership.create({ data: { id: transient.id, teamId: transient.teamId, userId: transient.userId, role: transient.role, createdAt: transient.createdAt } }); }
    const memberships = await api.prisma.teamMembership.findMany({ where: { userId: ids[0] } });
    await api.prisma.teamMembership.deleteMany({ where: { userId: ids[0] } });
    try {
      const empty = await ownTeams();assert.equal(empty.status, 200);
      assert.deepEqual(await empty.json(), { items: [], page: { limit: 20, hasMore: false, nextCursor: null } });
    } finally { await api.prisma.teamMembership.createMany({ data: memberships }); }
  });
  it("未ログイン・改ざんCookieではチーム作成も自分のチーム一覧も使えない", async () => {
    const before = await api.prisma.team.count();
    assert.equal((await ownTeams("", { headers: {} })).status, 401);
    assert.equal((await createTeam({ name: "架空" }, { headers: { Origin: api.origin, "Content-Type": "application/json" } })).status, 401);
    assert.equal((await ownTeams("", { headers: { Cookie: cookie + "tampered" } })).status, 401);
    assert.equal((await createTeam({ name: "架空" }, { headers: { Cookie: cookie + "tampered", Origin: api.origin, "Content-Type": "application/json" } })).status, 401);
    assert.equal(await api.prisma.team.count(), before);
  });
  it("担当候補は現在の対象チーム所属者だけを返し、ページ分割と境界を守る", async () => {
    const response = await candidateMembers();assert.equal(response.status, 200);
    const body = await response.json();
    const expected = [ids[0], ...supportUserIds.slice(0, 2)].sort();
    assert.deepEqual(body.items.map(m => m.userId), expected);
    assert.deepEqual(Object.keys(body.items[0]).sort(), ["name", "role", "userId"]);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const first = await (await candidateMembers(teams[0], "?limit=2")).json();
    const second = await (await candidateMembers(teams[0], `?limit=2&cursor=${first.page.nextCursor}`)).json();
    assert.deepEqual([...first.items, ...second.items].map(m => m.userId), expected);
    assert.equal(second.page.nextCursor, null);
    for (const query of ["?limit=0", "?limit=51", "?limit=2&limit=3", "?cursor=bad", `?cursor=${ids[1]}`, `?cursor=${supportUserIds[2]}`, "?role=admin"]) assert.equal((await candidateMembers(teams[0], query)).status, 400);
    assert.equal((await candidateMembers(teams[1])).status, 403);
    assert.equal((await candidateMembers(teams[0], "", { headers: {} })).status, 401);
    assert.equal((await candidateMembers(teams[0], "", { method: "POST", headers: { Cookie: cookie, Origin: api.origin } })).status, 405);
  });
  it("最小入力で案件と人物記録・初期担当履歴を保存し、詳細から確認できる", async () => {
    const response = await createProject({ ...projectPayload(), name: "　最小の架空案件　" }, emptyTeamId);
    assert.equal(response.status, 201);
    const { project } = await response.json();createdProjectIds.push(project.id);
    assert.deepEqual(project, { id: project.id, name: "最小の架空案件", dueDate: "2026-12-31", progress: 0, status: "NOT_STARTED", version: 1 });
    assert.equal(response.headers.get("location"), `/api/teams/${emptyTeamId}/projects/${project.id}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const detail = await (await readProject(project.id, emptyTeamId)).json();
    assert.equal(detail.project.code, null);assert.equal(detail.project.summary, null);assert.equal(detail.project.notes, null);
    assert.equal(detail.project.createdBy.nameSnapshot, "認証検証用の架空ユーザー");
    assert.equal(detail.project.primaryAssignee.participantId, detail.project.createdBy.participantId);
    const history = await (await readAssignments(project.id, emptyTeamId)).json();
    assert.equal(history.items.length, 1);assert.equal(history.items[0].kind, "PRIMARY_CHANGE");
    assert.equal(history.items[0].previousAssignee, null);
    assert.deepEqual((await (await readSupport(project.id, emptyTeamId)).json()).items, []);
    assert.deepEqual((await (await readHistory(project.id, emptyTeamId)).json()).items, []);
    assert.equal(await api.prisma.teamParticipant.count({ where: { teamId: emptyTeamId, userId: ids[0] } }), 1);
  });
  it("memberが別の主担当と副担当を指定でき、既存の人物記録を再利用する", async () => {
    const before = await api.prisma.teamParticipant.count({ where: { teamId: teams[0] } });
    const response = await createProject({ ...projectPayload(), primaryUserId: supportUserIds[0], supportUserIds: [ids[0], supportUserIds[1]], code: "案件-01", summary: "架空の概要\n二行目", clientName: "架空の発注者", notes: "架空メモ" });
    assert.equal(response.status, 201);const { project } = await response.json();createdProjectIds.push(project.id);
    const detail = await (await readProject(project.id)).json();
    assert.equal(detail.project.primaryAssignee.participantId, supportParticipantIds[0]);
    assert.equal(detail.project.createdBy.participantId, participantId);
    assert.equal(detail.project.code, "案件-01");assert.equal(detail.project.summary, "架空の概要\n二行目");
    assert.equal(detail.project.clientName, "架空の発注者");assert.equal(detail.project.notes, "架空メモ");
    const support = await (await readSupport(project.id)).json();
    assert.deepEqual(support.items.map(p => p.participantId).sort(), [participantId, supportParticipantIds[1]].sort());
    const history = await (await readAssignments(project.id)).json();
    assert.equal(history.items.length, 3);assert.equal(history.items.filter(h => h.kind === "SUPPORT_ADD").length, 2);
    assert.ok(history.items.every(h => h.previousAssignee === null && h.changedBy.participantId === participantId));
    assert.equal(await api.prisma.teamParticipant.count({ where: { teamId: teams[0] } }), before);
  });
  it("案件登録は不正入力・主副担当の重複・別チームや所属なしの担当を保存前に拒否する", async () => {
    const before = await api.prisma.project.count();
    for (const patch of [{ name: " " }, { dueDate: "2026-02-29" }, { name: "あ".repeat(201) }, { primaryUserId: "bad" }, { supportUserIds: [ids[0]] }, { supportUserIds: [supportUserIds[0], supportUserIds[0].toUpperCase()] }, { progress: 100 }, { status: "DONE" }, { createdByUserId: ids[1] }, { version: 99 }, { notes: "a".repeat(2001) }]) assert.equal((await createProject({ ...projectPayload(), ...patch })).status, 400);
    for (const userId of [ids[1], supportUserIds[2], randomUUID()]) {
      const response = await createProject({ ...projectPayload(), primaryUserId: userId });
      assert.equal(response.status, 400);assert.equal((await response.json()).code, "INVALID_ASSIGNEES");
      assert.equal((await createProject({ ...projectPayload(), supportUserIds: [userId] })).status, 400);
    }
    assert.equal((await createProject(null)).status, 400);
    assert.equal((await createProject({}, teams[0], { body: "{" })).status, 400);
    assert.equal((await createProject({}, teams[0], { headers: { Cookie: cookie, Origin: api.origin, "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await createProject({ ...projectPayload(), notes: "a".repeat(40000) })).status, 413);
    assert.equal(await api.prisma.project.count(), before);
  });
  it("登録時にも現在の本人と担当の所属を確かめ、古い候補や偽の本人情報では通らない", async () => {
    const before = await api.prisma.project.count();
    assert.equal((await createProject(projectPayload(), teams[0], { headers: { Origin: api.origin, "Content-Type": "application/json" } })).status, 401);
    assert.equal((await createProject(projectPayload(), teams[0], { headers: { Cookie: cookie + "tampered", Origin: api.origin, "Content-Type": "application/json" } })).status, 401);
    assert.equal((await createProject(projectPayload(), teams[0], { headers: { Cookie: cookie, Origin: "https://example.invalid", "Content-Type": "application/json" } })).status, 403);
    assert.equal((await createProject(projectPayload(), teams[1], { headers: { Cookie: cookie, Origin: api.origin, "Content-Type": "application/json", "X-User-Id": ids[1], "X-Role": "admin" } })).status, 403);
    const member = await api.prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId: teams[0], userId: supportUserIds[1] } } });
    await api.prisma.teamMembership.delete({ where: { id: member.id } });
    try { assert.equal((await createProject({ ...projectPayload(), primaryUserId: supportUserIds[1] })).status, 400); }
    finally { await api.prisma.teamMembership.create({ data: member }); }
    const actor = await api.prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } } });
    await api.prisma.teamMembership.delete({ where: { id: actor.id } });
    try { assert.equal((await createProject()).status, 403);assert.equal((await candidateMembers()).status, 403); }
    finally { await api.prisma.teamMembership.create({ data: actor }); }
    assert.equal(await api.prisma.project.count(), before);
  });
  it("最後の担当履歴保存がDBエラーになると、案件・副担当・新しい人物記録も全て巻き戻る", async () => {
    const { createProjectForUser } = await import("../examples/mysql/project-service.ts");
    const { parseCreateProjectInput } = await import("../lib/siteflow/domain.ts");
    const teamId = createdTeamIds[0];
    const membershipId = randomUUID();
    await api.prisma.teamMembership.create({ data: { id: membershipId, teamId, userId: supportUserIds[0], role: "member", createdAt: new Date() } });
    let insertedId;
    const broken = api.prisma.$extends({ query: {
      project: { async create({ args, query }) { const row = await query(args);insertedId = row.id;createdProjectIds.push(row.id);return row; } },
      projectAssignmentHistory: { async createMany({ args, query }) { return query({ ...args, data: args.data.map((row, index) => index === 0 ? { ...row, id: assignments[0].id } : row) }); } },
    } });
    try {
      await assert.rejects(createProjectForUser(broken, ids[0], teamId, parseCreateProjectInput({ ...projectPayload(), supportUserIds: [supportUserIds[0]] })), error => error.code === "P2002");
      assert.ok(insertedId);
      assert.equal(await api.prisma.project.findUnique({ where: { id: insertedId } }), null);
      assert.equal(await api.prisma.projectSupportMember.count({ where: { projectId: insertedId } }), 0);
      assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: insertedId } }), 0);
      assert.equal(await api.prisma.teamParticipant.count({ where: { teamId } }), 0);
    } finally { await api.prisma.teamMembership.delete({ where: { id: membershipId } }); }
  });
  it("案件保存中に対象の所属行を直接削除しようとしても、保存が終わるまで待つ", async () => {
    const { createProjectForUser } = await import("../examples/mysql/project-service.ts");
    const { parseCreateProjectInput } = await import("../lib/siteflow/domain.ts");
    const membership = await api.prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId: emptyTeamId, userId: ids[0] } } });
    let markReady, release;
    const ready = new Promise(resolve => { markReady = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const held = api.prisma.$extends({ query: { project: { async create({ args, query }) {
      markReady();await gate;const row = await query(args);createdProjectIds.push(row.id);return row;
    } } } });
    const creation = createProjectForUser(held, ids[0], emptyTeamId, parseCreateProjectInput(projectPayload()));
    creation.catch(() => {});
    let deletion, finished = false, timer;
    try {
      await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("ロック確認の準備ができませんでした。")), 3000); })]);clearTimeout(timer);
      deletion = api.prisma.teamMembership.delete({ where: { id: membership.id } }).then(row => { finished = true;return row; });
      deletion.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));assert.equal(finished, false);
      release();const result = await creation;assert.equal(result.ok, true);await deletion;
    } finally {
      clearTimeout(timer);release();await Promise.allSettled([creation, deletion]);
      if (!await api.prisma.teamMembership.findUnique({ where: { id: membership.id } })) await api.prisma.teamMembership.create({ data: membership });
    }
  });
  it("チーム作成から担当候補・案件登録・一覧・詳細までHTTPでつながる", async () => {
    const teamResponse = await createTeam({ name: "案件登録まで試す架空チーム" });assert.equal(teamResponse.status, 201);
    const teamId = (await teamResponse.json()).team.id;createdTeamIds.push(teamId);
    const candidates = await (await candidateMembers(teamId)).json();assert.equal(candidates.items.length, 1);assert.equal(candidates.items[0].userId, ids[0]);
    for (let i = 0; i < 2; i++) {
      const response = await createProject({ ...projectPayload(), name: `作成確認の架空案件${i}` }, teamId);assert.equal(response.status, 201);
      const id = (await response.json()).project.id;createdProjectIds.push(id);assert.equal((await readProject(id, teamId)).status, 200);
    }
    const list = await (await listProjects(teamId)).json();assert.equal(list.items.length, 2);
    assert.equal(await api.prisma.teamParticipant.count({ where: { teamId, userId: ids[0] } }), 1);
  });
  const editProject = (projectId, body, teamId = teams[0], options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects/${projectId}`, {
    method: "PATCH", headers: { Cookie: cookie, Origin: api.origin, "Content-Type": "application/json" }, body: JSON.stringify(body), ...options,
  });
  const newEditProject = async (overrides = {}) => {
    const response = await createProject({ ...projectPayload(), code: 'KEEP', notes: '残す備考', ...overrides });
    assert.equal(response.status, 201);
    const { project } = await response.json(); createdProjectIds.push(project.id); return project.id;
  };
  it("主担当は指定した基本項目だけ編集でき、担当・進捗・履歴・作成情報は変わらない", async () => {
    const id = await newEditProject();
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const response = await editProject(id, { expectedVersion: 1, name: ' 編集済み ', dueDate: '2028-02-29', summary: '概要\n続き', code: '' });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(response.headers.get('x-request-id'));
    const { project } = await response.json(); assert.equal(project.version, 2); assert.equal(project.code, null); assert.equal(project.notes, '残す備考');
    const after = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    for (const key of ['primaryParticipantId', 'createdByParticipantId', 'createdByNameSnapshot', 'status', 'progress']) assert.equal(after[key], before[key]);
    assert.equal(after.name, '編集済み'); assert.equal(after.dueDate.toISOString().slice(0, 10), '2028-02-29');
    assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: id } }), 1);
    assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 0);
    assert.equal((await (await readProject(id)).json()).project.version, 2);
  });
  it("作成者だけでは編集できず、現在の副担当か管理者なら編集できる", async () => {
    const id = await newEditProject({ primaryUserId: supportUserIds[0] });
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const denied = await editProject(id, { expectedVersion: 1, name: '拒否される' });
    assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'PROJECT_EDIT_DENIED');
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
    const supported = await newEditProject({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] });
    assert.equal((await editProject(supported, { expectedVersion: 1, clientName: '架空の発注者' })).status, 200);
    await api.prisma.teamMembership.update({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } }, data: { role: 'admin' } });
    try { assert.equal((await editProject(id, { expectedVersion: 1, name: '管理者が編集' })).status, 200); }
    finally { await api.prisma.teamMembership.update({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } }, data: { role: 'member' } }); }
  });
  it("古い版は409で保存せず、最新を読み直すと再編集できる", async () => {
    const id = await newEditProject();
    assert.equal((await editProject(id, { expectedVersion: 1, name: '先に保存' })).status, 200);
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const stale = await editProject(id, { expectedVersion: 1, name: '古い編集' });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'PROJECT_VERSION_CONFLICT');
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
    assert.equal((await editProject(id, { expectedVersion: 2, notes: null })).status, 200);
    assert.equal((await (await readProject(id)).json()).project.notes, null);
  });
  it("同じ版の2つのHTTP保存は一方だけ成功し、版は1回だけ増える", async () => {
    const id = await newEditProject();
    const responses = await Promise.all(['同時A', '同時B'].map(name => editProject(id, { expectedVersion: 1, name })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const winner = await responses.find(r => r.status === 200).json();
    const stored = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    assert.equal(stored.version, 2); assert.equal(stored.name, winner.project.name);
  });
  it("編集でも認証・送信元・所属・チーム・アーカイブ・入力と本文上限を検証する", async () => {
    const id = await newEditProject(), body = { expectedVersion: 1, name: '保存しない' };
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    assert.equal((await editProject(id, body, teams[0], { headers: { Origin: api.origin, 'Content-Type': 'application/json' } })).status, 401);
    assert.equal((await editProject(id, body, teams[0], { headers: { Cookie: cookie, Origin: 'https://example.invalid', 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await editProject(id, body, teams[1])).status, 403);
    for (const missing of [randomUUID(), archivedProjectId, otherProjectId]) assert.equal((await editProject(missing, body)).status, 404);
    assert.equal((await editProject(id + '?unknown=1', body)).status, 400);
    for (const invalid of [{ expectedVersion: 1 }, { ...body, progress: 100 }, { ...body, dueDate: '2026-02-30' }, { ...body, expectedVersion: '1' }]) {
      assert.equal((await editProject(id, invalid)).status, 400);
    }
    assert.equal((await editProject(id, body, teams[0], { body: '{' })).status, 400);
    assert.equal((await editProject(id, body, teams[0], { headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await editProject(id, { ...body, notes: 'x'.repeat(33000) })).status, 413);
    const membership = await api.prisma.teamMembership.findUniqueOrThrow({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } } });
    await api.prisma.teamMembership.delete({ where: { id: membership.id } });
    try { assert.equal((await editProject(id, body)).status, 403); }
    finally { await api.prisma.teamMembership.create({ data: membership }); }
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
  });
  it("別々の主担当・副担当が同じ版を同時保存しても一方だけ成功する", async () => {
    const { editProjectForUser } = await import('../examples/mysql/project-service.ts');
    const id = await newEditProject({ supportUserIds: [supportUserIds[0]] });
    const results = await Promise.all([ids[0], supportUserIds[0]].map((userId, index) =>
      editProjectForUser(api.prisma, userId, teams[0], id, { expectedVersion: 1, changes: { name: `別担当${index}` } })));
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(results.find(r => !r.ok).status, 409);
    const stored = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    assert.equal(stored.version, 2); assert.equal(stored.name, results.find(r => r.ok).project.name);
  });
  it("更新後の応答読み取りに失敗しても基本情報と版番号を一緒に巻き戻す", async () => {
    const { editProjectForUser } = await import('../examples/mysql/project-service.ts');
    const id = await newEditProject();
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const broken = api.prisma.$extends({ query: { project: { async findUniqueOrThrow() { throw new Error('test-only-read-failure'); } } } });
    await assert.rejects(editProjectForUser(broken, ids[0], teams[0], id, { expectedVersion: 1, changes: { name: '戻す' } }), /test-only-read-failure/);
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
  });
  const changeAssignees = (id, body, teamId = teams[0], options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects/${id}/assignees`, {
    method: 'PUT', headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options,
  });
  const assignmentBody = (overrides = {}) => ({ expectedVersion: 1, primaryUserId: ids[0], supportUserIds: [], ...overrides });
  it('主副担当の入替と解除を一括保存し、実際の差分だけ当時の名前で履歴に残す', async () => {
    const id = await newEditProject({ supportUserIds: supportUserIds.slice(0, 2) });
    const response = await changeAssignees(id, assignmentBody({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] }));
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(response.headers.get('x-request-id'));
    assert.deepEqual(await response.json(), { project: { id, version: 2 }, changed: true });
    const detail = (await (await readProject(id)).json()).project;
    assert.equal(detail.primaryAssignee.participantId, supportParticipantIds[0]); assert.equal(detail.version, 2);
    assert.equal(detail.progress, 0); assert.equal(detail.status, 'NOT_STARTED'); assert.equal(detail.code, 'KEEP');
    const support = (await (await readSupport(id)).json()).items; assert.deepEqual(support.map(s => s.participantId), [participantId]);
    const history = (await (await readAssignments(id)).json()).items;
    assert.equal(history.length, 7); const latest = history.filter(h => h.previousAssignee?.participantId === participantId || h.kind === 'SUPPORT_REMOVE' || h.kind === 'SUPPORT_ADD' && h.nextAssignee?.participantId === participantId);
    assert.equal(latest.length, 4); assert.equal(new Set(latest.map(h => h.changedAt)).size, 1);
    const primary = latest.find(h => h.kind === 'PRIMARY_CHANGE'); assert.equal(primary.nextAssignee.participantId, supportParticipantIds[0]);
    assert.equal(primary.previousAssignee.nameSnapshot, detail.createdBy.nameSnapshot);
    assert.equal(primary.nextAssignee.nameSnapshot, '架空の副担当1');
    assert.ok(latest.every(h => h.changedBy.participantId === participantId));
    const oldName = primary.nextAssignee.nameSnapshot;
    await api.prisma.user.update({ where: { id: supportUserIds[0] }, data: { name: '変更後の架空名' } });
    try { assert.equal((await (await readAssignments(id)).json()).items.find(h => h.id === primary.id).nextAssignee.nameSnapshot, oldName); }
    finally { await api.prisma.user.update({ where: { id: supportUserIds[0] }, data: { name: '架空の副担当1' } }); }
    assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 0);
  });
  it('同じ担当や副担当の並び替えでは履歴と版を増やさず、古い版は拒否する', async () => {
    const id = await newEditProject({ supportUserIds: supportUserIds.slice(0, 2) });
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const response = await changeAssignees(id, assignmentBody({ supportUserIds: supportUserIds.slice(0, 2).reverse() }));
    assert.equal(response.status, 200); assert.equal((await response.json()).changed, false);
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
    assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: id } }), 3);
    assert.equal((await editProject(id, { expectedVersion: 1, name: '版を進める' })).status, 200);
    assert.equal((await changeAssignees(id, assignmentBody({ supportUserIds: supportUserIds.slice(0, 2) }))).status, 409);
  });
  it('単なる作成者の担当変更を拒否し、副担当と管理者に許可、自分を外した後は編集できない', async () => {
    const deniedId = await newEditProject({ primaryUserId: supportUserIds[0] });
    assert.equal((await changeAssignees(deniedId, assignmentBody())).status, 403);
    const supported = await newEditProject({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] });
    assert.equal((await changeAssignees(supported, assignmentBody())).status, 200);
    assert.equal((await changeAssignees(supported, assignmentBody({ expectedVersion: 2, primaryUserId: supportUserIds[0] }))).status, 200);
    assert.equal((await editProject(supported, { expectedVersion: 3, notes: '拒否' })).status, 403);
    assert.equal((await changeAssignees(supported, assignmentBody({ expectedVersion: 3 }))).status, 403);
    await api.prisma.teamMembership.update({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } }, data: { role: 'admin' } });
    try { assert.equal((await changeAssignees(deniedId, assignmentBody())).status, 200); }
    finally { await api.prisma.teamMembership.update({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } }, data: { role: 'member' } }); }
  });
  it('担当変更も認証・送信元・チーム・入力・本文上限を確認し、不正な保存は何も変えない', async () => {
    const id = await newEditProject(); const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const body = assignmentBody({ supportUserIds: [supportUserIds[0]] });
    assert.equal((await changeAssignees(id, body, teams[0], { headers: { Origin: api.origin, 'Content-Type': 'application/json' } })).status, 401);
    assert.equal((await changeAssignees(id, body, teams[0], { headers: { Cookie: cookie, Origin: 'https://example.invalid', 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await changeAssignees(id, body, teams[1])).status, 403);
    for (const missing of [randomUUID(), otherProjectId, archivedProjectId]) assert.equal((await changeAssignees(missing, body)).status, 404);
    assert.equal((await changeAssignees('bad', body)).status, 400);
    assert.equal((await changeAssignees(id, body, 'bad')).status, 400);
    for (const invalid of [{ ...body, supportUserIds: [ids[0]] }, { ...body, history: [] }, { expectedVersion: 1, primaryUserId: ids[0] }, { ...body, supportUserIds: ['bad'] }]) assert.equal((await changeAssignees(id, invalid)).status, 400);
    for (const userId of [supportUserIds[2], ids[1], randomUUID()]) assert.equal((await changeAssignees(id, assignmentBody({ primaryUserId: userId }))).status, 400);
    assert.equal((await changeAssignees(id, body, teams[0], { body: '{' })).status, 400);
    assert.equal((await changeAssignees(id, body, teams[0], { body: ' '.repeat(33000) })).status, 413);
    assert.equal((await changeAssignees(id, body, teams[0], { headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'text/plain' } })).status, 415);
    const query = await fetch(api.origin + `/api/teams/${teams[0]}/projects/${id}/assignees?x=1`, { method: 'PUT', headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(query.status, 400);
    const method = await changeAssignees(id, body, teams[0], { method: 'POST' }); assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'PUT');
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
    assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: id } }), 1);
    assert.equal(await api.prisma.projectSupportMember.count({ where: { projectId: id } }), 0);
  });
  it('候補取得後の所属解除を保存で拒否し、元担当の解除は台帳と履歴を残して行える', async () => {
    const id = await newEditProject({ supportUserIds: [supportUserIds[0]] });
    assert.equal((await candidateMembers()).status, 200);
    const membership = await api.prisma.teamMembership.findUniqueOrThrow({ where: { teamId_userId: { teamId: teams[0], userId: supportUserIds[0] } } });
    await api.prisma.teamMembership.delete({ where: { id: membership.id } });
    try {
      assert.equal((await changeAssignees(id, assignmentBody({ primaryUserId: supportUserIds[0] }))).status, 400);
      assert.equal((await changeAssignees(id, assignmentBody())).status, 200);
      assert.ok(await api.prisma.teamParticipant.findUnique({ where: { id: supportParticipantIds[0] } }));
      const removed = (await (await readAssignments(id)).json()).items.find(h => h.kind === 'SUPPORT_REMOVE');
      assert.equal(removed.previousAssignee.participantId, supportParticipantIds[0]); assert.equal(removed.nextAssignee, null);
    } finally { await api.prisma.teamMembership.create({ data: membership }); }
    const actor = await api.prisma.teamMembership.findUniqueOrThrow({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } } });
    await api.prisma.teamMembership.delete({ where: { id: actor.id } });
    try { assert.equal((await changeAssignees(id, assignmentBody({ expectedVersion: 2 }))).status, 403); }
    finally { await api.prisma.teamMembership.create({ data: actor }); }
  });
  it('基本編集と担当変更が同じ版を同時保存しても、一方だけ成功する', async () => {
    const id = await newEditProject();
    const responses = await Promise.all([editProject(id, { expectedVersion: 1, name: '競合する編集' }), changeAssignees(id, assignmentBody({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] }))]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const project = await api.prisma.project.findUniqueOrThrow({ where: { id } }); assert.equal(project.version, 2);
    assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: id } }), responses[1].status === 200 ? 3 : 1);
  });
  it('担当変更の最後の履歴INSERTに失敗すると、担当・版・新しい人物も巻き戻る', async () => {
    const { changeProjectAssigneesForUser } = await import('../examples/mysql/project-service.ts');
    const oldSupportMembership = { id: randomUUID(), teamId: emptyTeamId, userId: supportUserIds[1], role: 'member', createdAt: new Date() };
    await api.prisma.teamMembership.create({ data: oldSupportMembership });
    const response = await createProject({ ...projectPayload(), supportUserIds: [supportUserIds[1]] }, emptyTeamId); assert.equal(response.status, 201);
    const id = (await response.json()).project.id; createdProjectIds.push(id);
    const membership = { id: randomUUID(), teamId: emptyTeamId, userId: supportUserIds[0], role: 'member', createdAt: new Date() };
    await api.prisma.teamMembership.create({ data: membership });
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const beforeSupports = await api.prisma.projectSupportMember.findMany({ where: { projectId: id } });
    const broken = api.prisma.$extends({ query: { projectAssignmentHistory: { async createMany({ args, query }) {
      return query({ ...args, data: args.data.map((row, index) => index === 0 ? { ...row, id: assignments[0].id } : row) });
    } } } });
    try {
      await assert.rejects(changeProjectAssigneesForUser(broken, ids[0], emptyTeamId, id, assignmentBody({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] })), e => e.code === 'P2002');
      assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
      assert.deepEqual(await api.prisma.projectSupportMember.findMany({ where: { projectId: id } }), beforeSupports);
      assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: id } }), 2);
      assert.equal(await api.prisma.teamParticipant.count({ where: { teamId: emptyTeamId, userId: supportUserIds[0] } }), 0);
    } finally { await api.prisma.teamMembership.deleteMany({ where: { id: { in: [membership.id, oldSupportMembership.id] } } }); }
  });
  it('別々の主副担当が同じ版で担当変更しても履歴が混ざらず一方だけ成功する', async () => {
    const { changeProjectAssigneesForUser } = await import('../examples/mysql/project-service.ts');
    const id = await newEditProject({ supportUserIds: [supportUserIds[0]] });
    const results = await Promise.all([
      changeProjectAssigneesForUser(api.prisma, ids[0], teams[0], id, assignmentBody({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] })),
      changeProjectAssigneesForUser(api.prisma, supportUserIds[0], teams[0], id, assignmentBody({ supportUserIds: supportUserIds.slice(0, 2) })),
    ]);
    assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).status, 409);
    assert.equal((await api.prisma.project.findUniqueOrThrow({ where: { id } })).version, 2);
    assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: id } }), results[0].ok ? 5 : 3);
  });
  const updateProgress = (id, body, teamId = teams[0], options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects/${id}/progress`, {
    method: 'PATCH', headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options,
  });
  const progressBody = (overrides = {}) => ({ expectedVersion: 1, progress: 40, ...overrides });
  it('進捗を整数で更新して前後の値・本人・当時の名前・メモを記録し、100でも自動完了しない', async () => {
    const id = await newEditProject(); const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const response = await updateProgress(id, progressBody({ comment: '　架空の進捗メモ\n続き　' }));
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(response.headers.get('x-request-id'));
    assert.deepEqual(await response.json(), { project: { id, progress: 40, status: 'NOT_STARTED', version: 2 }, changed: true });
    const rows = (await (await readHistory(id)).json()).items; assert.equal(rows.length, 1);
    assert.equal(rows[0].previousProgress, 0); assert.equal(rows[0].nextProgress, 40);
    assert.equal(rows[0].previousStatus, 'NOT_STARTED'); assert.equal(rows[0].nextStatus, 'NOT_STARTED');
    assert.equal(rows[0].comment, '架空の進捗メモ\n続き'); assert.equal(rows[0].changedBy.participantId, participantId);
    assert.equal(rows[0].changedBy.nameSnapshot, before.createdByNameSnapshot); assert.ok(Number.isFinite(Date.parse(rows[0].changedAt)));
    await api.prisma.user.update({ where: { id: ids[0] }, data: { name: '新しい架空名' } });
    try { assert.equal((await (await readHistory(id)).json()).items[0].changedBy.nameSnapshot, before.createdByNameSnapshot); }
    finally { await api.prisma.user.update({ where: { id: ids[0] }, data: { name: before.createdByNameSnapshot } }); }
    assert.equal((await updateProgress(id, progressBody({ expectedVersion: 2, progress: 100 }))).status, 200);
    assert.equal((await (await readProject(id)).json()).project.status, 'NOT_STARTED');
    assert.equal((await updateProgress(id, progressBody({ expectedVersion: 3, progress: 0, comment: '見積りを修正' }))).status, 200);
    const after = await api.prisma.project.findUniqueOrThrow({ where: { id } }); assert.equal(after.version, 4); assert.equal(after.progress, 0);
    for (const key of ['name', 'code', 'notes', 'primaryParticipantId', 'createdByParticipantId', 'createdAt']) assert.deepEqual(after[key], before[key]);
    assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: id } }), 1);
  });
  it('同じ進捗は履歴も版も増やさず、メモだけの保存と古い版を拒否する', async () => {
    const id = await newEditProject(), before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const response = await updateProgress(id, progressBody({ progress: 0 })); assert.equal(response.status, 200); assert.equal((await response.json()).changed, false);
    const commentOnly = await updateProgress(id, progressBody({ progress: 0, comment: '消さないメモ' })); assert.equal(commentOnly.status, 400); assert.equal((await commentOnly.json()).code, 'COMMENT_WITHOUT_PROGRESS_CHANGE');
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before); assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 0);
    assert.equal((await updateProgress(id, progressBody())).status, 200);
    assert.equal((await updateProgress(id, progressBody())).status, 409);
    assert.equal((await updateProgress(id, progressBody({ expectedVersion: 2, progress: 60 }))).status, 200);
    assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 2);
  });
  it('進行中・確認待ち・保留の状態を保持し、完了済みは進捗の変更を拒否する', async () => {
    const id = await newEditProject();
    for (const [index, status] of ['IN_PROGRESS', 'REVIEW', 'ON_HOLD'].entries()) {
      await api.prisma.project.update({ where: { id }, data: { status } }); // 状態変更APIの代用ではなく、条件固定用のデータ。
      const response = await updateProgress(id, progressBody({ expectedVersion: index + 1, progress: index + 1 })); assert.equal(response.status, 200); assert.equal((await response.json()).project.status, status);
    }
    await api.prisma.project.update({ where: { id }, data: { status: 'DONE', progress: 100 } });
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const denied = await updateProgress(id, progressBody({ expectedVersion: 4 })); assert.equal(denied.status, 409); assert.equal((await denied.json()).code, 'PROJECT_COMPLETED');
    assert.equal((await updateProgress(id, progressBody({ expectedVersion: 4, progress: 100 }))).status, 200);
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before); assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 3);
  });
  it('進捗更新も主副担当と管理者だけに許可し、単なる作成者を拒否する', async () => {
    const deniedId = await newEditProject({ primaryUserId: supportUserIds[0] });
    assert.equal((await updateProgress(deniedId, progressBody())).status, 403);
    const supported = await newEditProject({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] });
    assert.equal((await updateProgress(supported, progressBody())).status, 200);
    await api.prisma.teamMembership.update({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } }, data: { role: 'admin' } });
    try { assert.equal((await updateProgress(deniedId, progressBody())).status, 200); }
    finally { await api.prisma.teamMembership.update({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } }, data: { role: 'member' } }); }
  });
  it('進捗の不正入力・追加属性・メモ上限・JSON/本文上限を保存前に拒否する', async () => {
    const id = await newEditProject(), before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    for (const body of [progressBody({ progress: -1 }), progressBody({ progress: 101 }), progressBody({ progress: 0.5 }), progressBody({ progress: '40' }), { expectedVersion: 1 }, progressBody({ expectedVersion: '1' }), progressBody({ status: 'DONE' }), progressBody({ changedByParticipantId: participantId }), progressBody({ comment: 'あ'.repeat(2001) })]) assert.equal((await updateProgress(id, body)).status, 400);
    assert.equal((await updateProgress(id, progressBody(), teams[0], { body: '{' })).status, 400);
    assert.equal((await updateProgress(id, progressBody({ comment: 'x'.repeat(33000) }))).status, 413);
    assert.equal((await updateProgress(id, progressBody(), teams[0], { headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'text/plain' } })).status, 415);
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before); assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 0);
  });
  it('進捗更新も認証・送信元・チーム境界・アーカイブ・HTTPメソッドを検証する', async () => {
    const id = await newEditProject();
    assert.equal((await updateProgress(id, progressBody(), teams[0], { headers: { Origin: api.origin, 'Content-Type': 'application/json' } })).status, 401);
    assert.equal((await updateProgress(id, progressBody(), teams[0], { headers: { Cookie: cookie, Origin: 'https://example.invalid', 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await updateProgress(id, progressBody(), teams[1])).status, 403);
    for (const missing of [randomUUID(), otherProjectId, archivedProjectId]) assert.equal((await updateProgress(missing, progressBody())).status, 404);
    assert.equal((await updateProgress('bad', progressBody())).status, 400);
    assert.equal((await updateProgress(id, progressBody(), 'bad')).status, 400);
    const query = await fetch(api.origin + `/api/teams/${teams[0]}/projects/${id}/progress?x=1`, { method: 'PATCH', headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(progressBody()) }); assert.equal(query.status, 400);
    const method = await updateProgress(id, progressBody(), teams[0], { method: 'POST' }); assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'PATCH');
    assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 0);
  });
  it('所属解除後や担当から外れた後はCookieや人物が残っても進捗更新できない', async () => {
    const id = await newEditProject();
    const membership = await api.prisma.teamMembership.findUniqueOrThrow({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } } });
    await api.prisma.teamMembership.delete({ where: { id: membership.id } });
    try { assert.equal((await updateProgress(id, progressBody())).status, 403); }
    finally { await api.prisma.teamMembership.create({ data: membership }); }
    assert.equal((await changeAssignees(id, assignmentBody({ primaryUserId: supportUserIds[0] }))).status, 200);
    assert.equal((await updateProgress(id, progressBody({ expectedVersion: 2 }), teams[0], { headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'application/json', 'X-Role': 'admin', 'X-User-Id': supportUserIds[0] } })).status, 403);
    assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 0);
  });
  it('進捗・基本情報・担当変更が同じ版で競合すると一方だけ成功し、履歴もその変更だけ残る', async () => {
    const id = await newEditProject();
    const responses = await Promise.all([updateProgress(id, progressBody()), editProject(id, { expectedVersion: 1, name: '競合する基本編集' }), changeAssignees(id, assignmentBody({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] }))]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409, 409]);
    const stored = await api.prisma.project.findUniqueOrThrow({ where: { id } }); assert.equal(stored.version, 2);
    assert.equal(stored.progress, responses[0].status === 200 ? 40 : 0);
    assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), responses[0].status === 200 ? 1 : 0);
    assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: id } }), responses[2].status === 200 ? 3 : 1);
  });
  it('最後の進捗履歴INSERTの実DBエラーで、進捗・版・新しい変更者の人物記録も巻き戻る', async () => {
    const { createProjectForUser, updateProjectProgressForUser } = await import('../examples/mysql/project-service.ts');
    const { parseCreateProjectInput } = await import('../lib/siteflow/domain.ts');
    const teamResponse = await createTeam({ name: '進捗の巻き戻し用の架空チーム' }); assert.equal(teamResponse.status, 201);
    const teamId = (await teamResponse.json()).team.id; createdTeamIds.push(teamId);
    await api.prisma.teamMembership.create({ data: { id: randomUUID(), teamId, userId: supportUserIds[0], role: 'member', createdAt: new Date() } });
    const result = await createProjectForUser(api.prisma, supportUserIds[0], teamId, parseCreateProjectInput({ ...projectPayload(), primaryUserId: supportUserIds[0] })); assert.equal(result.ok, true);
    const id = result.project.id; createdProjectIds.push(id);
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const broken = api.prisma.$extends({ query: { projectProgressHistory: { async create({ args, query }) { return query({ ...args, data: { ...args.data, id: histories[0].id } }); } } } });
    await assert.rejects(updateProjectProgressForUser(broken, ids[0], teamId, id, { ...progressBody(), comment: null }), e => e.code === 'P2002');
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
    assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 0);
    assert.equal(await api.prisma.teamParticipant.count({ where: { teamId, userId: ids[0] } }), 0);
    const success = await updateProgress(id, progressBody(), teamId); assert.equal(success.status, 200);
    assert.equal(await api.prisma.teamParticipant.count({ where: { teamId, userId: ids[0] } }), 1);
  });
  it('別々の主副担当の同時進捗更新は一方だけ成功し、履歴は1件だけ残る', async () => {
    const { updateProjectProgressForUser } = await import('../examples/mysql/project-service.ts');
    const id = await newEditProject({ supportUserIds: [supportUserIds[0]] });
    const results = await Promise.all([ids[0], supportUserIds[0]].map((userId, index) => updateProjectProgressForUser(api.prisma, userId, teams[0], id, { ...progressBody({ progress: (index + 1) * 20 }), comment: null })));
    assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).status, 409);
    const stored = await api.prisma.project.findUniqueOrThrow({ where: { id } }); assert.equal(stored.progress, results.find(r => r.ok).project.progress); assert.equal(stored.version, 2);
    const history = await api.prisma.projectProgressHistory.findMany({ where: { projectId: id } }); assert.equal(history.length, 1); assert.equal(history[0].nextProgress, stored.progress);
  });
  const changeStatus = (id, body, teamId = teams[0], options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects/${id}/status`, {
    method: 'PATCH', headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options,
  });
  const statusBody = (overrides = {}) => ({ expectedVersion: 1, status: 'IN_PROGRESS', ...overrides });
  it('案件開始から確認待ち・100％で完了・理由付き再開・進捗修正がHTTPでつながる', async () => {
    const id = await newEditProject();
    const start = await changeStatus(id, statusBody()); assert.equal(start.status, 200); assert.equal(start.headers.get('cache-control'), 'no-store'); assert.ok(start.headers.get('x-request-id'));
    assert.deepEqual(await start.json(), { project: { id, progress: 0, status: 'IN_PROGRESS', version: 2 }, changed: true });
    assert.equal((await updateProgress(id, progressBody({ expectedVersion: 2 }))).status, 200);
    assert.equal((await changeStatus(id, statusBody({ expectedVersion: 3, status: 'REVIEW' }))).status, 200);
    const denied = await changeStatus(id, statusBody({ expectedVersion: 4, status: 'DONE' })); assert.equal(denied.status, 409); assert.equal((await denied.json()).code, 'PROGRESS_REQUIRED_FOR_COMPLETION');
    assert.equal((await updateProgress(id, progressBody({ expectedVersion: 4, progress: 100 }))).status, 200);
    assert.equal((await (await readProject(id)).json()).project.status, 'REVIEW');
    assert.equal((await changeStatus(id, statusBody({ expectedVersion: 5, status: 'DONE' }))).status, 200);
    assert.equal((await updateProgress(id, progressBody({ expectedVersion: 6 }))).status, 409);
    const reopened = await changeStatus(id, statusBody({ expectedVersion: 6, comment: '　追加確認のため再開　' })); assert.equal(reopened.status, 200);
    assert.deepEqual((await reopened.json()).project, { id, progress: 100, status: 'IN_PROGRESS', version: 7 });
    assert.equal((await updateProgress(id, progressBody({ expectedVersion: 7, progress: 60, comment: '追加作業分を反映' }))).status, 200);
    const history = (await (await readHistory(id)).json()).items; assert.equal(history.length, 7);
    const row = history.find(h => h.previousStatus === 'DONE'); assert.equal(row.nextStatus, 'IN_PROGRESS'); assert.equal(row.previousProgress, 100); assert.equal(row.nextProgress, 100); assert.equal(row.comment, '追加確認のため再開');
    assert.equal(row.changedBy.participantId, participantId); assert.ok(Number.isFinite(Date.parse(row.changedAt)));
    assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: id } }), 1);
  });
  it('保留と差し戻しができ、同じ状態は版・履歴・日時を増やさずメモ単独を拒否する', async () => {
    const id = await newEditProject();
    for (const [i, status] of ['ON_HOLD', 'IN_PROGRESS', 'REVIEW', 'IN_PROGRESS'].entries()) assert.equal((await changeStatus(id, statusBody({ expectedVersion: i + 1, status }))).status, 200);
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const same = await changeStatus(id, statusBody({ expectedVersion: 5 })); assert.equal(same.status, 200); assert.equal((await same.json()).changed, false);
    const memo = await changeStatus(id, statusBody({ expectedVersion: 5, comment: 'メモだけ' })); assert.equal(memo.status, 400); assert.equal((await memo.json()).code, 'COMMENT_WITHOUT_STATUS_CHANGE');
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before); assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 4);
    assert.equal((await changeStatus(id, statusBody({ expectedVersion: 1 }))).status, 409);
  });
  it('状態変更も主副担当・管理者に限定し、単なる作成者と元所属者を拒否する', async () => {
    const id = await newEditProject({ primaryUserId: supportUserIds[0] }); assert.equal((await changeStatus(id, statusBody())).status, 403);
    const supported = await newEditProject({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] }); assert.equal((await changeStatus(supported, statusBody())).status, 200);
    const member = await api.prisma.teamMembership.findUniqueOrThrow({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } } });
    await api.prisma.teamMembership.delete({ where: { id: member.id } });
    try { assert.equal((await changeStatus(supported, statusBody({ expectedVersion: 2, status: 'REVIEW' }))).status, 403); }
    finally { await api.prisma.teamMembership.create({ data: member }); }
    await api.prisma.teamMembership.update({ where: { id: member.id }, data: { role: 'admin' } });
    try { assert.equal((await changeStatus(id, statusBody())).status, 200); }
    finally { await api.prisma.teamMembership.update({ where: { id: member.id }, data: { role: 'member' } }); }
  });
  it('状態変更も認証・送信元・チーム境界・入力・本文・HTTPメソッドを検証する', async () => {
    const id = await newEditProject(), before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    assert.equal((await changeStatus(id, statusBody(), teams[0], { headers: { Origin: api.origin, 'Content-Type': 'application/json' } })).status, 401);
    assert.equal((await changeStatus(id, statusBody(), teams[0], { headers: { Cookie: cookie, Origin: 'https://example.invalid', 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await changeStatus(id, statusBody(), teams[1])).status, 403);
    for (const missing of [randomUUID(), otherProjectId, archivedProjectId]) assert.equal((await changeStatus(missing, statusBody())).status, 404);
    assert.equal((await changeStatus('bad', statusBody())).status, 400);
    assert.equal((await changeStatus(id, statusBody(), 'bad')).status, 400);
    for (const body of [statusBody({ status: 'done' }), statusBody({ expectedVersion: '1' }), statusBody({ progress: 100 }), statusBody({ userId: ids[0] }), statusBody({ comment: 'a'.repeat(2001) })]) assert.equal((await changeStatus(id, body)).status, 400);
    assert.equal((await changeStatus(id, statusBody(), teams[0], { body: '{' })).status, 400);
    assert.equal((await changeStatus(id, statusBody({ comment: 'a'.repeat(33000) }))).status, 413);
    assert.equal((await changeStatus(id, statusBody(), teams[0], { headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'text/plain' } })).status, 415);
    const query = await fetch(api.origin + `/api/teams/${teams[0]}/projects/${id}/status?x=1`, { method: 'PATCH', headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(statusBody()) }); assert.equal(query.status, 400);
    const method = await changeStatus(id, statusBody(), teams[0], { method: 'POST' }); assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'PATCH');
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before); assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 0);
  });
  it('100％でも未着手・進行中・保留からの完了や完了から確認待ちへの飛び越しを拒否する', async () => {
    const id = await newEditProject();
    for (const status of ['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'DONE']) {
      await api.prisma.project.update({ where: { id }, data: { status, progress: 100 } });
      const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
      const response = await changeStatus(id, statusBody({ status: status === 'DONE' ? 'REVIEW' : 'DONE' })); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'INVALID_STATUS_TRANSITION');
      assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
    }
    assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 0);
  });
  it('再開理由と現在の主副担当の所属を確認し、担当変更後は再開できる', async () => {
    const id = await newEditProject({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0], supportUserIds[1]] });
    await api.prisma.project.update({ where: { id }, data: { status: 'DONE', progress: 100 } });
    for (const comment of [undefined, '　 ']) { const response = await changeStatus(id, statusBody({ comment })); assert.equal(response.status, 400); assert.equal((await response.json()).code, 'REOPEN_REASON_REQUIRED'); }
    const memberships = await api.prisma.teamMembership.findMany({ where: { teamId: teams[0], userId: { in: supportUserIds.slice(0, 2) } } });
    for (const m of memberships) {
      await api.prisma.teamMembership.delete({ where: { id: m.id } });
      try { const response = await changeStatus(id, statusBody({ comment: '追加対応' })); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'INACTIVE_ASSIGNEES'); }
      finally { await api.prisma.teamMembership.create({ data: m }); }
    }
    await api.prisma.teamMembership.delete({ where: { id: memberships[0].id } });
    try {
      assert.equal((await changeAssignees(id, assignmentBody({ primaryUserId: ids[0] }))).status, 200);
      assert.equal((await changeStatus(id, statusBody({ expectedVersion: 2, comment: '担当を調整して再開' }))).status, 200);
      const detail = (await (await readProject(id)).json()).project; assert.equal(detail.status, 'IN_PROGRESS'); assert.equal(detail.progress, 100);
      assert.ok(await api.prisma.teamParticipant.findUnique({ where: { id: supportParticipantIds[0] } }));
    } finally { await api.prisma.teamMembership.create({ data: memberships[0] }); }
  });
  it('状態・進捗・基本編集・担当変更が同じ版で競合しても一方だけ成功する', async () => {
    const id = await newEditProject();
    const responses = await Promise.all([changeStatus(id, statusBody()), updateProgress(id, progressBody()), editProject(id, { expectedVersion: 1, name: '同時編集' }), changeAssignees(id, assignmentBody({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] }))]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409, 409, 409]);
    const stored = await api.prisma.project.findUniqueOrThrow({ where: { id } }); assert.equal(stored.version, 2);
    assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), responses[0].status === 200 || responses[1].status === 200 ? 1 : 0);
    assert.equal(stored.status, responses[0].status === 200 ? 'IN_PROGRESS' : 'NOT_STARTED');
  });
  it('古い版での完了を拒否し、履歴の変更者名はプロフィール変更後も保持する', async () => {
    const id = await newEditProject();
    await api.prisma.project.update({ where: { id }, data: { status: 'REVIEW', progress: 100 } });
    assert.equal((await editProject(id, { expectedVersion: 1, notes: '先の編集' })).status, 200);
    assert.equal((await changeStatus(id, statusBody({ status: 'DONE' }))).status, 409);
    assert.equal((await changeStatus(id, statusBody({ expectedVersion: 2, status: 'DONE' }))).status, 200);
    const row = (await (await readHistory(id)).json()).items[0];
    await api.prisma.user.update({ where: { id: ids[0] }, data: { name: '新しい架空名' } });
    try { assert.equal((await (await readHistory(id)).json()).items[0].changedBy.nameSnapshot, row.changedBy.nameSnapshot); }
    finally { await api.prisma.user.update({ where: { id: ids[0] }, data: { name: row.changedBy.nameSnapshot } }); }
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const same = await changeStatus(id, statusBody({ expectedVersion: 3, status: 'DONE' })); assert.equal(same.status, 200); assert.equal((await same.json()).changed, false);
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
  });
  it('状態の最後の履歴INSERTがDBエラーなら状態・版・新しい人物も戻る', async () => {
    const { createProjectForUser, changeProjectStatusForUser } = await import('../examples/mysql/project-service.ts');
    const { parseCreateProjectInput } = await import('../lib/siteflow/domain.ts');
    const response = await createTeam({ name: '状態変更の巻き戻し用チーム' }); assert.equal(response.status, 201); const teamId = (await response.json()).team.id; createdTeamIds.push(teamId);
    await api.prisma.teamMembership.create({ data: { id: randomUUID(), teamId, userId: supportUserIds[0], role: 'member', createdAt: new Date() } });
    const created = await createProjectForUser(api.prisma, supportUserIds[0], teamId, parseCreateProjectInput({ ...projectPayload(), primaryUserId: supportUserIds[0] })); assert.equal(created.ok, true); const id = created.project.id; createdProjectIds.push(id);
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const broken = api.prisma.$extends({ query: { projectProgressHistory: { async create({ args, query }) { return query({ ...args, data: { ...args.data, id: histories[0].id } }); } } } });
    await assert.rejects(changeProjectStatusForUser(broken, ids[0], teamId, id, { ...statusBody(), comment: null }), e => e.code === 'P2002');
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before); assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 0); assert.equal(await api.prisma.teamParticipant.count({ where: { teamId, userId: ids[0] } }), 0);
  });
  it('別々の主副担当が同じ版で状態変更しても一方だけ成功し、履歴も1件だけ残る', async () => {
    const { changeProjectStatusForUser } = await import('../examples/mysql/project-service.ts');
    const id = await newEditProject({ supportUserIds: [supportUserIds[0]] });
    const results = await Promise.all([ids[0], supportUserIds[0]].map((userId, i) => changeProjectStatusForUser(api.prisma, userId, teams[0], id, { ...statusBody({ status: i ? 'ON_HOLD' : 'IN_PROGRESS' }), comment: null })));
    assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).status, 409); assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 1);
  });
  it('事前読取後に担当が変わったら、状態変更で古い担当情報を使わず409を返す', async () => {
    const { changeProjectStatusForUser } = await import('../examples/mysql/project-service.ts');
    const id = await newEditProject(); let injected = false;
    const raced = api.prisma.$extends({ query: { project: { async findFirst({ args, query }) {
      const row = await query(args);
      if (!injected) { injected = true; const response = await changeAssignees(id, assignmentBody({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] })); assert.equal(response.status, 200); }
      return row;
    } } } });
    const result = await changeProjectStatusForUser(raced, ids[0], teams[0], id, { ...statusBody(), comment: null }); assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_VERSION_CONFLICT');
    const stored = await api.prisma.project.findUniqueOrThrow({ where: { id } }); assert.equal(stored.version, 2); assert.equal(stored.status, 'NOT_STARTED'); assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 0);
  });
  const archiveProject = (id, expectedVersion = 1, teamId = teams[0], options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects/${id}/archive`, {
    method: 'POST', headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion }), ...options,
  });
  const restoreProject = (id, body, teamId = teams[0], options = {}) => fetch(api.origin + `/api/teams/${teamId}/projects/${id}/restore`, {
    method: 'POST', headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options,
  });
  const readArchive = (suffix = '', teamId = teams[0], options = {}) => fetch(api.origin + `/api/teams/${teamId}/archived-projects${suffix}`, { headers: { Cookie: cookie }, ...options });
  it('案件と履歴を消さずにアーカイブし、専用取得と復元がHTTPでつながる', async () => {
    const id = await newEditProject({ supportUserIds: [supportUserIds[0]] });
    assert.equal((await updateProgress(id, progressBody())).status, 200);
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const response = await archiveProject(id, 2); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(response.headers.get('x-request-id'));
    const archived = (await response.json()).project; assert.equal(archived.version, 3); assert.ok(Number.isFinite(Date.parse(archived.archivedAt)));
    assert.equal((await readProject(id)).status, 404); assert.ok(!(await (await listProjects()).json()).items.some(p => p.id === id));
    for (const read of [readSupport, readHistory, readAssignments]) assert.equal((await read(id)).status, 404);
    for (const update of [() => editProject(id, { expectedVersion: 3, name: '不可' }), () => updateProgress(id, progressBody({ expectedVersion: 3 })), () => changeStatus(id, statusBody({ expectedVersion: 3 })), () => changeAssignees(id, assignmentBody({ expectedVersion: 3 }))]) assert.equal((await update()).status, 404);
    const detail = (await (await readArchive('/' + id)).json()).project; assert.equal(detail.version, 3); assert.equal(detail.primaryAssignee.userId, ids[0]); assert.equal(detail.primaryAssignee.isCurrentMember, true);
    const support = (await (await readArchive(`/${id}/support-members`)).json()).items; assert.equal(support[0].userId, supportUserIds[0]);
    assert.equal((await (await readArchive(`/${id}/progress-history`)).json()).items.length, 1); assert.equal((await (await readArchive(`/${id}/assignment-history`)).json()).items.length, 2);
    const saved = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    for (const key of ['name', 'status', 'progress', 'code', 'notes', 'primaryParticipantId', 'createdByParticipantId', 'createdAt']) assert.deepEqual(saved[key], before[key]);
    assert.equal((await restoreProject(id, { expectedVersion: 3 })).status, 200);
    const restored = (await (await readProject(id)).json()).project; assert.equal(restored.version, 4); assert.equal(restored.progress, 40); assert.equal(restored.status, before.status);
    assert.equal((await readArchive('/' + id)).status, 404); assert.equal(await api.prisma.projectProgressHistory.count({ where: { projectId: id } }), 1); assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: id } }), 2);
  });
  it('アーカイブ一覧は通常一覧と混ぜず、納期・ID順の続きと0件を扱う', async () => {
    const response = await createTeam({ name: 'アーカイブ一覧用チーム' }); const teamId = (await response.json()).team.id; createdTeamIds.push(teamId);
    const empty = await readArchive('', teamId); assert.equal(empty.status, 200); assert.deepEqual((await empty.json()).items, []);
    const projectIds = [];
    for (let i = 0; i < 3; i++) {
      const created = await createProject({ ...projectPayload(), name: `保管する架空案件${i}` }, teamId); assert.equal(created.status, 201); const id = (await created.json()).project.id; createdProjectIds.push(id); projectIds.push(id); assert.equal((await archiveProject(id, 1, teamId)).status, 200);
    }
    const first = await (await readArchive('?limit=2', teamId)).json(); assert.equal(first.items.length, 2); assert.equal(first.page.hasMore, true); assert.equal(first.items[0].version, 2); assert.ok(first.items[0].archivedAt);
    const second = await (await readArchive(`?limit=2&cursor=${first.page.nextCursor}`, teamId)).json(); assert.equal(second.items.length, 1); assert.equal(second.page.nextCursor, null);
    assert.deepEqual([...first.items, ...second.items].map(p => p.id), projectIds.sort());
    assert.equal((await (await listProjects(teamId)).json()).items.length, 0);
    for (const cursor of [projects[0].id, archivedProjectId, randomUUID()]) assert.equal((await readArchive(`?cursor=${cursor}`, teamId)).status, 400);
    for (const query of ['?limit=0', '?limit=51', '?limit=1&limit=2', '?unknown=1']) assert.equal((await readArchive(query, teamId)).status, 400);
  });
  it('アーカイブ詳細・副担当・履歴も所属とチーム境界を守り、読み取り専用とする', async () => {
    const id = await newEditProject(); assert.equal((await archiveProject(id)).status, 200);
    for (const suffix of ['', '/' + id, `/${id}/support-members`, `/${id}/progress-history`, `/${id}/assignment-history`]) {
      assert.equal((await readArchive(suffix, teams[0], { headers: {} })).status, 401);
      assert.equal((await readArchive(suffix, teams[1])).status, 403);
      const method = await readArchive(suffix, teams[0], { method: 'PATCH', headers: { Cookie: cookie, Origin: api.origin } }); assert.equal(method.status, 405);
    }
    for (const other of [projects[0].id, otherProjectId, randomUUID()]) for (const suffix of ['', '/support-members', '/progress-history', '/assignment-history']) assert.equal((await readArchive('/' + other + suffix)).status, 404);
    assert.equal((await readArchive('/bad')).status, 400); assert.equal((await readArchive('/' + id + '?unknown=1')).status, 400);
    assert.equal((await readArchive(`/${id}/progress-history?cursor=${histories[0].id}`)).status, 400);
    assert.equal((await readArchive(`/${id}/assignment-history?cursor=${assignments[0].id}`)).status, 400);
  });
  it('アーカイブ・復元は主担当と管理者に限定し、副担当・作成者だけ・元所属者は拒否する', async () => {
    const deniedId = await newEditProject({ primaryUserId: supportUserIds[0] }); assert.equal((await archiveProject(deniedId)).status, 403);
    const id = await newEditProject({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] });
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    assert.equal((await archiveProject(id)).status, 403);
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
    await api.prisma.project.update({ where: { id }, data: { archivedAt: new Date() } });
    assert.equal((await restoreProject(id, { expectedVersion: 1, primaryUserId: ids[0], supportUserIds: [] })).status, 403);
    assert.equal((await api.prisma.project.findUniqueOrThrow({ where: { id } })).version, 1);
    const membership = await api.prisma.teamMembership.findUniqueOrThrow({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } } });
    await api.prisma.teamMembership.update({ where: { id: membership.id }, data: { role: 'admin' } });
    try { assert.equal((await archiveProject(deniedId)).status, 200); assert.equal((await restoreProject(deniedId, { expectedVersion: 2 })).status, 200); }
    finally { await api.prisma.teamMembership.update({ where: { id: membership.id }, data: { role: 'member' } }); }
    await api.prisma.teamMembership.delete({ where: { id: membership.id } });
    try { assert.equal((await archiveProject(id, 3)).status, 403); assert.equal((await restoreProject(id, { expectedVersion: 3 })).status, 403); assert.equal((await readArchive()).status, 403); }
    finally { await api.prisma.teamMembership.create({ data: membership }); }
  });
  it('元所属の主副担当を残した復元を拒否し、担当変更と復元をまとめて保存できる', async () => {
    const id = await newEditProject({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0], supportUserIds[1]] });
    const actorMembership = await api.prisma.teamMembership.findUniqueOrThrow({ where: { teamId_userId: { teamId: teams[0], userId: ids[0] } } });
    await api.prisma.teamMembership.update({ where: { id: actorMembership.id }, data: { role: 'admin' } });
    await api.prisma.project.update({ where: { id }, data: { status: 'DONE', progress: 100 } });
    assert.equal((await archiveProject(id)).status, 200);
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const memberships = await api.prisma.teamMembership.findMany({ where: { teamId: teams[0], userId: { in: supportUserIds.slice(0, 2) } } });
    for (const m of memberships) {
      await api.prisma.teamMembership.delete({ where: { id: m.id } });
      try { const response = await restoreProject(id, { expectedVersion: 2 }); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'INACTIVE_ASSIGNEES'); assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before); }
      finally { await api.prisma.teamMembership.create({ data: m }); }
    }
    await api.prisma.teamMembership.deleteMany({ where: { id: { in: memberships.map(m => m.id) } } });
    try {
      assert.equal((await (await readArchive('/' + id)).json()).project.primaryAssignee.isCurrentMember, false);
      const restored = await restoreProject(id, { expectedVersion: 2, primaryUserId: ids[0], supportUserIds: [] }); assert.equal(restored.status, 200);
      const detail = (await (await readProject(id)).json()).project; assert.equal(detail.version, 3); assert.equal(detail.status, 'DONE'); assert.equal(detail.progress, 100); assert.equal(detail.primaryAssignee.participantId, participantId);
      const rows = (await (await readAssignments(id)).json()).items; assert.equal(rows.length, 6); assert.ok(rows.some(row => row.kind === 'PRIMARY_CHANGE' && row.previousAssignee?.participantId === supportParticipantIds[0] && row.nextAssignee?.participantId === participantId));
      for (const old of supportParticipantIds.slice(0, 2)) assert.ok(await api.prisma.teamParticipant.findUnique({ where: { id: old } }));
    } finally {
      await api.prisma.teamMembership.createMany({ data: memberships });
      await api.prisma.teamMembership.update({ where: { id: actorMembership.id }, data: { role: 'member' } });
    }
  });
  it('アーカイブ・復元の不正入力・送信元・型・本文上限・対象を保存前に拒否する', async () => {
    const id = await newEditProject(), before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    assert.equal((await archiveProject(id, 1, teams[0], { headers: { Origin: api.origin, 'Content-Type': 'application/json' } })).status, 401);
    assert.equal((await archiveProject(id, 1, teams[0], { headers: { Cookie: cookie, Origin: 'https://example.invalid', 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await archiveProject(id, 1, teams[1])).status, 403);
    for (const missing of [otherProjectId, randomUUID()]) { assert.equal((await archiveProject(missing)).status, 404); assert.equal((await restoreProject(missing, { expectedVersion: 1 })).status, 404); }
    assert.equal((await archiveProject('bad')).status, 400); assert.equal((await archiveProject(id, 1, 'bad')).status, 400);
    for (const body of [{ expectedVersion: '1' }, { expectedVersion: 1, archivedAt: null }, { expectedVersion: 1, primaryUserId: ids[0] }]) assert.equal((await archiveProject(id, 1, teams[0], { body: JSON.stringify(body) })).status, 400);
    for (const body of [{ expectedVersion: 1, supportUserIds: [] }, { expectedVersion: 1, primaryUserId: ids[0] }, { expectedVersion: 1, primaryUserId: ids[0], supportUserIds: [ids[0]] }]) assert.equal((await restoreProject(id, body)).status, 400);
    assert.equal((await restoreProject(id, { expectedVersion: 1, primaryUserId: ids[0], supportUserIds: [] })).status, 409);
    assert.equal((await archiveProject(id, 1, teams[0], { body: '{' })).status, 400); assert.equal((await archiveProject(id, 1, teams[0], { body: ' '.repeat(33000) })).status, 413);
    assert.equal((await archiveProject(id, 1, teams[0], { headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'text/plain' } })).status, 415);
    const method = await archiveProject(id, 1, teams[0], { method: 'PATCH' }); assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'POST');
    const query = await fetch(api.origin + `/api/teams/${teams[0]}/projects/${id}/restore?x=1`, { method: 'POST', headers: { Cookie: cookie, Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1 }) }); assert.equal(query.status, 400);
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before);
    assert.equal((await archiveProject(id)).status, 200);
    for (const primaryUserId of [ids[1], supportUserIds[2], randomUUID()]) assert.equal((await restoreProject(id, { expectedVersion: 2, primaryUserId, supportUserIds: [] })).status, 409);
  });
  it('アーカイブと他の編集の競合は一方だけ成功し、同じ版での同時復元も一方だけ成功する', async () => {
    const id = await newEditProject();
    const responses = await Promise.all([archiveProject(id), editProject(id, { expectedVersion: 1, name: '競合編集' }), updateProgress(id, progressBody()), changeStatus(id, statusBody()), changeAssignees(id, assignmentBody({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] }))]);
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    assert.ok(responses.slice(1).every(r => [200, 404, 409].includes(r.status)));
    assert.ok([200, 403, 404, 409].includes(responses[0].status));
    const stored = await api.prisma.project.findUniqueOrThrow({ where: { id } }); assert.equal(stored.version, 2); assert.equal(stored.archivedAt !== null, responses[0].status === 200);
    if (responses[0].status === 403) {
      assert.equal(responses[4].status, 200);
      assert.equal(stored.primaryParticipantId, supportParticipantIds[0]);
      assert.equal(stored.archivedAt, null);
    }
    const secondId = await newEditProject(); assert.equal((await archiveProject(secondId)).status, 200);
    const restored = await Promise.all([restoreProject(secondId, { expectedVersion: 2 }), restoreProject(secondId, { expectedVersion: 2 })]); assert.deepEqual(restored.map(r => r.status).sort(), [200, 409]);
  });
  it('同じ状態の再送は日時と版を維持し、古い版は拒否する', async () => {
    const id = await newEditProject(); assert.equal((await archiveProject(id)).status, 200);
    const before = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    const same = await archiveProject(id, 2); assert.equal(same.status, 200); assert.equal((await same.json()).changed, false);
    assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before); assert.equal((await archiveProject(id, 1)).status, 409); assert.equal((await restoreProject(id, { expectedVersion: 1 })).status, 409);
    assert.equal((await restoreProject(id, { expectedVersion: 2 })).status, 200);
    const restored = await api.prisma.project.findUniqueOrThrow({ where: { id } }); const retry = await restoreProject(id, { expectedVersion: 3 }); assert.equal(retry.status, 200); assert.equal((await retry.json()).changed, false); assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), restored);
  });
  it('復元時の最後の担当履歴INSERTが失敗すると、復元・版・担当追加解除・新規人物も戻る', async () => {
    const { changeProjectArchiveForUser } = await import('../examples/mysql/project-archive-service.ts');
    const memberships = supportUserIds.slice(0, 2).map(userId => ({ id: randomUUID(), teamId: emptyTeamId, userId, role: 'member', createdAt: new Date() }));
    await api.prisma.teamMembership.createMany({ data: memberships });
    try {
      const response = await createProject({ ...projectPayload(), supportUserIds: [supportUserIds[1]] }, emptyTeamId); assert.equal(response.status, 201); const id = (await response.json()).project.id; createdProjectIds.push(id); assert.equal((await archiveProject(id, 1, emptyTeamId)).status, 200);
      const before = await api.prisma.project.findUniqueOrThrow({ where: { id } }), supports = await api.prisma.projectSupportMember.findMany({ where: { projectId: id } });
      const broken = api.prisma.$extends({ query: { projectAssignmentHistory: { async createMany({ args, query }) { return query({ ...args, data: args.data.map((row, i) => i ? row : { ...row, id: assignments[0].id }) }); } } } });
      await assert.rejects(changeProjectArchiveForUser(broken, ids[0], emptyTeamId, id, { expectedVersion: 2, archived: false, assignees: { primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] } }), e => e.code === 'P2002');
      assert.deepEqual(await api.prisma.project.findUniqueOrThrow({ where: { id } }), before); assert.deepEqual(await api.prisma.projectSupportMember.findMany({ where: { projectId: id } }), supports); assert.equal(await api.prisma.projectAssignmentHistory.count({ where: { projectId: id } }), 2); assert.equal(await api.prisma.teamParticipant.count({ where: { teamId: emptyTeamId, userId: supportUserIds[0] } }), 0);
    } finally { await api.prisma.teamMembership.deleteMany({ where: { id: { in: memberships.map(m => m.id) } } }); }
  });
  it('主担当と副担当が同じ版でアーカイブした場合、副担当は403でデータを変更しない', async () => {
    const { changeProjectArchiveForUser } = await import('../examples/mysql/project-archive-service.ts'); const id = await newEditProject({ supportUserIds: [supportUserIds[0]] });
    const results = await Promise.all([ids[0], supportUserIds[0]].map(userId => changeProjectArchiveForUser(api.prisma, userId, teams[0], id, { expectedVersion: 1, archived: true })));
    assert.equal(results[0].ok, true); assert.equal(results[1].status, 403); assert.equal((await api.prisma.project.findUniqueOrThrow({ where: { id } })).version, 2);
  });
  it('事前読取後に編集された案件を古い版でアーカイブしない', async () => {
    const { changeProjectArchiveForUser } = await import('../examples/mysql/project-archive-service.ts'); const id = await newEditProject(); let injected = false;
    const raced = api.prisma.$extends({ query: { project: { async findFirst({ args, query }) { const row = await query(args); if (!injected) { injected = true; assert.equal((await editProject(id, { expectedVersion: 1, notes: '割込み編集' })).status, 200); } return row; } } } });
    const result = await changeProjectArchiveForUser(raced, ids[0], teams[0], id, { expectedVersion: 1, archived: true }); assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_VERSION_CONFLICT'); assert.equal((await api.prisma.project.findUniqueOrThrow({ where: { id } })).archivedAt, null);
  });
  it('事前読取後に主担当から副担当へ変わった人の保管操作は403になり、担当変更を保持する', async () => {
    const { changeProjectArchiveForUser } = await import('../examples/mysql/project-archive-service.ts');
    const id = await newEditProject(); let injected = false;
    const raced = api.prisma.$extends({ query: { project: { async findFirst({ args, query }) {
      const row = await query(args);
      if (!injected) {
        injected = true;
        assert.equal((await changeAssignees(id, assignmentBody({ primaryUserId: supportUserIds[0], supportUserIds: [ids[0]] }))).status, 200);
      }
      return row;
    } } } });
    const result = await changeProjectArchiveForUser(raced, ids[0], teams[0], id, { expectedVersion: 1, archived: true });
    assert.equal(result.ok, false); assert.equal(result.status, 403);
    const stored = await api.prisma.project.findUniqueOrThrow({ where: { id } });
    assert.equal(stored.version, 2); assert.equal(stored.primaryParticipantId, supportParticipantIds[0]); assert.equal(stored.archivedAt, null);
  });
  it("公開設定が不足するとDB作成やサーバー起動より先に拒否する", async () => {
    const { startPublicApiServer } = await import('../examples/mysql/public-api.ts');
    let calls = 0;
    const dependencies = { createDatabase() { calls++; throw Error('must not connect'); }, startServer() { calls++; throw Error('must not start'); } };
    await assert.rejects(startPublicApiServer({}, dependencies), { field: 'SITEFLOW_PUBLIC_ORIGIN' });
    await assert.rejects(startPublicApiServer({ SITEFLOW_PUBLIC_ORIGIN: 'http://example.com' }, dependencies), { field: 'SITEFLOW_PUBLIC_ORIGIN' });
    assert.equal(calls, 0);
  });
  it("検査済み公開設定をDBのTLS検証と固定secret・Secure Cookieへ渡す", async () => {
    const { startPublicApiServer } = await import('../examples/mysql/public-api.ts');
    const env = { SITEFLOW_PUBLIC_ORIGIN: 'https://demo.example.com', SITEFLOW_AUTH_SECRET: randomBytes(32).toString('hex'), SITEFLOW_DB_HOST: 'mysql.internal', SITEFLOW_DB_PORT: '3306', SITEFLOW_DB_NAME: 'siteflow_public_demo', SITEFLOW_DB_USER: 'siteflow_app', SITEFLOW_DB_PASSWORD: randomBytes(24).toString('hex'), SITEFLOW_DB_TLS: 'required' };
    const fakePrisma = {}; let dbOptions, serverOptions;
    const fakeServer = { origin: 'http://127.0.0.1:5175', prisma: fakePrisma, close: async () => {} };
    const result = await startPublicApiServer(env, { createDatabase(options) { dbOptions = options; return fakePrisma; }, async startServer(options) { serverOptions = options; return fakeServer; } });
    assert.equal(result, fakeServer); assert.deepEqual(dbOptions, { host: env.SITEFLOW_DB_HOST, port: 3306, database: env.SITEFLOW_DB_NAME, user: env.SITEFLOW_DB_USER, password: env.SITEFLOW_DB_PASSWORD, ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2', checkServerIdentity: dbOptions.ssl.checkServerIdentity }, connectionLimit: 2, connectTimeout: 5000, acquireTimeout: 5000 });
    assert.equal(dbOptions.ssl.checkServerIdentity('localhost', { subjectaltname: 'DNS:mysql.internal' }), undefined);
    assert.ok(dbOptions.ssl.checkServerIdentity('mysql.internal', { subjectaltname: 'DNS:wrong.example.com' }) instanceof Error);
    assert.equal(serverOptions.prisma, fakePrisma); assert.equal(serverOptions.authSecret, env.SITEFLOW_AUTH_SECRET); assert.equal(serverOptions.publicOrigin, env.SITEFLOW_PUBLIC_ORIGIN); assert.equal(serverOptions.secureCookies, true); assert.equal(serverOptions.port, 5175);
  });
  it("起動の例外で秘密値を出さず、接続失敗時もDBを切断する", async () => {
    const { startApiServer } = await import('../examples/mysql/api-server.ts');
    const { startPublicApiServer } = await import('../examples/mysql/public-api.ts');
    let disconnected = 0;
    await assert.rejects(startApiServer({ prisma: { async $connect() { throw Error('PRIVATE_STARTUP_SENTINEL'); }, async $disconnect() { disconnected++; } }, authSecret: randomBytes(32).toString('hex'), secureCookies: false, port: 0 }), error => {
      assert.equal(error.cause, undefined); assert.ok(!error.stack.includes('PRIVATE_STARTUP_SENTINEL')); return true;
    }); assert.equal(disconnected, 1);
    const env = { SITEFLOW_PUBLIC_ORIGIN: 'https://demo.example.com', SITEFLOW_AUTH_SECRET: randomBytes(32).toString('hex'), SITEFLOW_DB_HOST: 'mysql.internal', SITEFLOW_DB_PORT: '3306', SITEFLOW_DB_NAME: 'siteflow_public_demo', SITEFLOW_DB_USER: 'siteflow_app', SITEFLOW_DB_PASSWORD: randomBytes(24).toString('hex'), SITEFLOW_DB_TLS: 'required' };
    await assert.rejects(startPublicApiServer(env, { createDatabase() { throw Error(env.SITEFLOW_DB_PASSWORD); }, startServer() { throw Error('must not start'); } }), error => {
      assert.equal(error.cause, undefined); assert.ok(!error.stack.includes(env.SITEFLOW_DB_PASSWORD)); return true;
    });
  });
  it("同じsecretなら再起動後も実DBのセッションを読め、変更すると旧Cookieを拒否する", async () => {
    const { startAuthCheckServer } = await import('../examples/mysql/auth-check.ts');
    const secret = randomBytes(32).toString('hex');
    const previous = await api.prisma.session.findMany({ where: { userId: ids[0] }, select: { id: true } });
    let restarted;
    try {
      restarted = await startAuthCheckServer(0, { authSecret: secret });
      const origin = restarted.origin, port = Number(new URL(origin).port);
      const login = await fetch(origin + '/api/auth/sign-in/email', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: verified, password }) });
      assert.equal(login.status, 200);
      const restartCookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      assert.ok(restartCookie);
      const read = async () => { const r = await fetch(origin + '/api/auth/get-session', { headers: { Cookie: restartCookie } }); assert.equal(r.status, 200); return r.json(); };
      assert.equal((await read()).user.id, ids[0]);
      const closing = restarted.close(); assert.equal(restarted.close(), closing); await closing;
      restarted = await startAuthCheckServer(port, { authSecret: secret });
      assert.equal((await read()).user.id, ids[0]);
      await restarted.close(); restarted = await startAuthCheckServer(port, { authSecret: randomBytes(32).toString('hex') });
      assert.equal(await read(), null);
    } finally {
      await restarted?.close();
      await api.prisma.session.deleteMany({ where: { userId: ids[0], id: { notIn: previous.map(row => row.id) } } });
    }
  });
  it("公開用中継を実APIへつなぎ、Secure Cookieでログイン・取得・ログアウトする", async () => {
    const { startApiServer } = await import('../examples/mysql/api-server.ts');
    const { proxyPublicApi } = await import('../lib/siteflow/public-api-proxy.ts');
    const { readSchemaCheckSettings } = await import('../examples/mysql/schema-check-settings.mjs');
    const fromExample = createRequire(new URL('../examples/mysql/package.json', import.meta.url));
    const { PrismaMariaDb } = await import(pathToFileURL(fromExample.resolve('@prisma/adapter-mariadb')).href);
    const settings = readSchemaCheckSettings();
    const prisma = new api.prisma.constructor({ adapter: new PrismaMariaDb({ host: '127.0.0.1', port: settings.port, user: settings.user, password: settings.password, database: settings.database, connectionLimit: 2 }) });
    const previous = await api.prisma.session.findMany({ where: { userId: ids[0] }, select: { id: true } });
    const publicOrigin = 'https://demo.example.com'; let publicApi;
    try {
      publicApi = await startApiServer({ prisma, authSecret: randomBytes(32).toString('hex'), publicOrigin, secureCookies: true, port: 0 });
      let upstreamCode;
      const call = (path, options = {}) => proxyPublicApi(new Request(publicOrigin + '/api/siteflow/' + path, { ...options, headers: { Host: 'demo.example.com', ...options.headers } }), path.split('/'), { enabled: true, publicOrigin, backendOrigin: publicApi.origin, fetcher: async (...args) => { const response = await fetch(...args); if (!response.ok) upstreamCode = (await response.clone().json()).code; return response; } });
      const login = await call('auth/sign-in/email', { method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: verified, password }) });
      const loginBody = await login.json();
      assert.equal(login.status, 200, upstreamCode ?? loginBody?.code ?? 'PUBLIC_LOGIN_FAILED'); assert.deepEqual(loginBody, { ok: true });
      const cookies = login.headers.getSetCookie(); assert.ok(cookies.length);
      for (const value of cookies) { assert.match(value, /Secure/i); assert.match(value, /HttpOnly/i); assert.match(value, /Path=\/api\/siteflow/); }
      const publicCookie = cookies.map(value => value.split(';')[0]).join('; ');
      const session = await call('auth/get-session', { headers: { Cookie: publicCookie } });
      assert.deepEqual(await session.json(), { user: { id: ids[0], name: '認証検証用の架空ユーザー', email: verified } });
      assert.equal((await call('teams', { headers: { Cookie: publicCookie } })).status, 200);
      const logout = await call('auth/sign-out', { method: 'POST', headers: { Origin: publicOrigin, Cookie: publicCookie, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(logout.status, 200); assert.ok(logout.headers.getSetCookie().some(value => /Max-Age=0/i.test(value)));
      assert.equal(await (await call('auth/get-session', { headers: { Cookie: publicCookie } })).json(), null);
    } finally {
      if (publicApi) await publicApi.close(); else await prisma.$disconnect();
      await api.prisma.session.deleteMany({ where: { userId: ids[0], id: { notIn: previous.map(row => row.id) } } });
    }
  });
  it("不正な送信元からのログアウトは拒否され、正しいログアウトで旧Cookieも無効になる", async () => {
    assert.equal((await post("sign-out", {}, { Cookie: cookie, Origin: "https://example.invalid" })).status, 403);
    assert.equal(await api.prisma.session.count({ where: { userId: ids[0] } }), 1);
    assert.equal((await post("sign-out", {}, { Cookie: cookie })).status, 200);
    assert.equal(await api.prisma.session.count({ where: { userId: ids[0] } }), 0);
    const response = await request("get-session", { headers: { Cookie: cookie } });
    assert.equal(await response.json(), null);
    assert.equal((await readTeam(teams[0])).status, 401);
    assert.equal((await listProjects()).status, 401);
    assert.equal((await readProject()).status, 401);
    assert.equal((await readSupport()).status, 401);
    assert.equal((await readHistory()).status, 401);
    assert.equal((await readAssignments()).status, 401);
    assert.equal((await ownTeams()).status, 401);
    assert.equal((await createTeam({ name: "ログアウト後の架空チーム" })).status, 401);
    assert.equal((await editProject(projects[0].id, { expectedVersion: 1, name: 'ログアウト後' })).status, 401);
    assert.equal((await candidateMembers()).status, 401);
    assert.equal((await createProject()).status, 401);
    assert.equal((await changeAssignees(projects[0].id, assignmentBody())).status, 401);
    assert.equal((await updateProgress(projects[0].id, progressBody())).status, 401);
    assert.equal((await changeStatus(projects[0].id, statusBody())).status, 401);
    assert.equal((await archiveProject(projects[0].id)).status, 401);
    assert.equal((await restoreProject(archivedProjectId, { expectedVersion: 1 })).status, 401);
    assert.equal((await readArchive()).status, 401);
  });
});
