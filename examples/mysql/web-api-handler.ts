import { randomUUID } from "node:crypto";
import type { PrismaClient } from "./generated/integrated/client.ts";
import { canReadTeam, canArchiveProject, isUuid, parseChangeProjectAssigneesInput, parseEditProjectInput, parseCreateProjectInput, parseCreateTeamInput, parseListPageQuery } from "../../lib/siteflow/domain.ts";
import { createTeamForUser } from "./team-service.ts";
import { changeProjectAssigneesForUser, createProjectForUser, editProjectForUser } from "./project-service.ts";
import { readJsonBody } from "./json-body.ts";
import { parseUpdateProjectProgressInput } from "../../lib/siteflow/domain.ts";
import { updateProjectProgressForUser } from "./project-service.ts";
import { parseChangeProjectStatusInput } from "../../lib/siteflow/domain.ts";
import { changeProjectStatusForUser } from "./project-service.ts";
import { parseProjectArchiveInput } from "../../lib/siteflow/domain.ts";
import { changeProjectArchiveForUser } from "./project-archive-service.ts";
import { parseMeetingAction, parseStartMeetingInput } from '../../lib/siteflow/domain.ts';
import { actOnMeetingForUser, readMeetingForUser, startMeetingForUser } from './meeting-service.ts';

type ApiDependencies = {
  prisma: PrismaClient;
  origin: string;
  host: string;
  pathPrefix?: string;
  authHandler: (request: Request) => Promise<Response>;
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>;
};

// DBや認証の起動方法を知らず、受け取った依存でHTTPリクエストを処理する。
export function createWebApiHandler({ prisma, origin, host, authHandler, getSession, pathPrefix = "/api" }: ApiDependencies) {
  const methods = new Map([
    ["/api/auth/sign-in/email", "POST"],
    ["/api/auth/get-session", "GET"],
    ["/api/auth/sign-out", "POST"],
  ]);
  const handle = async (req: Request): Promise<Response> => {
    const headers = new Headers();
    function reply(status: number, data: unknown, extra: Record<string, string> = {}) {
      return Response.json(data, { status, headers: { ...Object.fromEntries(headers), ...extra } });
    }
    function error(status: number, code: string, message = "APIへのリクエストを確認してください。") {
      return reply(status, { code, message });
    }
    try {
      if (req.headers.get("host") !== host) {
        return error(403, "INVALID_HOST");
      }
      const url = new URL(req.url ?? "/", origin);
      if (!url.pathname.startsWith(pathPrefix + "/")) return error(404, "NOT_FOUND");
      const pathname = "/api" + url.pathname.slice(pathPrefix.length);
      const teamRoute = /^\/api\/teams\/([^/]+)\/(access|projects|members|archived-projects)$/.exec(pathname);
      const detailRoute = /^\/api\/teams\/([^/]+)\/projects\/([^/]+)$/.exec(pathname);
      const archivedDetailRoute = /^\/api\/teams\/([^/]+)\/archived-projects\/([^/]+)$/.exec(pathname);
      const supportRoute = /^\/api\/teams\/([^/]+)\/(?:projects|archived-projects)\/([^/]+)\/support-members$/.exec(pathname);
      const progressRoute = /^\/api\/teams\/([^/]+)\/(?:projects|archived-projects)\/([^/]+)\/progress-history$/.exec(pathname);
      const assignmentRoute = /^\/api\/teams\/([^/]+)\/(?:projects|archived-projects)\/([^/]+)\/assignment-history$/.exec(pathname);
      const assigneesRoute = /^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/assignees$/.exec(pathname);
      const progressUpdateRoute = /^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/progress$/.exec(pathname);
      const statusRoute = /^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/status$/.exec(pathname);
      const archiveRoute = /^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/(archive|restore)$/.exec(pathname);
      const meetingRoute = /^\/api\/teams\/([^/]+)\/meetings(?:\/([^/]+))?$/.exec(pathname);
      const scopedRoute = teamRoute ?? detailRoute ?? archivedDetailRoute ?? supportRoute ?? progressRoute ?? assignmentRoute ?? assigneesRoute ?? progressUpdateRoute ?? statusRoute ?? archiveRoute ?? meetingRoute;
      const isTeams = pathname === "/api/teams";
      const allowsPost = isTeams || teamRoute?.[2] === "projects" || Boolean(meetingRoute && !meetingRoute[2]);
      const method = meetingRoute?.[2] ? (req.method === 'PATCH' ? 'PATCH' : 'GET') : archiveRoute ? "POST" : statusRoute || progressUpdateRoute ? "PATCH" : assigneesRoute ? "PUT" : detailRoute && req.method === "PATCH" ? "PATCH" : allowsPost ? (req.method === "POST" ? "POST" : "GET") : scopedRoute ? "GET" : methods.get(pathname);
      if (!method) { return error(404, "NOT_FOUND"); }
      if (req.method !== method) {
        headers.set("Allow", detailRoute || meetingRoute?.[2] ? "GET, PATCH" : allowsPost ? "GET, POST" : method);
        return error(405, "METHOD_NOT_ALLOWED");
      }
      if ((method !== "GET" && req.headers.get("origin") !== origin)
        || (req.headers.has("origin") && req.headers.get("origin") !== origin)
        || req.headers.get("sec-fetch-site") === "cross-site") {
        return error(403, "INVALID_ORIGIN");
      }
      if (isTeams) {
        const session = await getSession(req.headers);
        if (!session) { return error(401, "UNAUTHENTICATED", "ログインが必要です。"); }
        if (method === "POST") {
          if (url.searchParams.size !== 0) { return error(400, "INVALID_TEAM_QUERY"); }
          if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
            return error(415, "UNSUPPORTED_MEDIA_TYPE", "application/jsonで送信してください。");
          }
          const body = await readJsonBody(req, 4096);
          if (body.tooLarge) { headers.set("Connection", "close"); return error(413, "BODY_TOO_LARGE", "送信内容は4096バイト以内にしてください。"); }
          const input = body.invalid ? null : parseCreateTeamInput(body.value);
          if (!input) { return error(400, "INVALID_TEAM_INPUT", "nameだけを指定してください。チーム名は改行等を含まない1〜80文字です。"); }
          const result = await createTeamForUser(prisma, session.user.id, input.name);
          if (!result.ok) { return error(result.status, result.code, result.message); }
          return reply(201, { team: result.team, role: result.role }, { Location: `${pathPrefix}/teams/${result.team.id}/access` });
        }
        const params = url.searchParams;
        const query = parseListPageQuery({ limit: params.get("limit") ?? undefined, cursor: params.get("cursor") ?? undefined });
        if (!query || Array.from(params.keys()).some(key => !["limit", "cursor"].includes(key) || params.getAll(key).length !== 1)) {
          return error(400, "INVALID_TEAM_QUERY");
        }
        if (query.cursor && !await prisma.teamMembership.findFirst({
          where: { userId: session.user.id, teamId: query.cursor, role: { in: ["admin", "member"] } }, select: { id: true },
        })) { return error(400, "INVALID_TEAM_CURSOR"); }
        const rows = await prisma.teamMembership.findMany({
          where: { userId: session.user.id, role: { in: ["admin", "member"] }, ...(query.cursor ? { teamId: { gt: query.cursor } } : {}) },
          orderBy: { teamId: "asc" }, take: query.limit + 1,
          select: { role: true, team: { select: { id: true, name: true } } },
        });
        const hasMore = rows.length > query.limit;
        const items = rows.slice(0, query.limit).map(row => ({ ...row.team, role: row.role }));
        return reply(200, { items, page: { limit: query.limit, hasMore, nextCursor: hasMore ? items[items.length - 1].id : null } });
      }
      if (scopedRoute) {
        const teamId = scopedRoute[1].toLowerCase();
        if (!isUuid(teamId)) {
          return error(400, "INVALID_TEAM_ID", "チームIDの形式が不正です。");
        }
        const projectRoute = detailRoute ?? archivedDetailRoute ?? supportRoute ?? progressRoute ?? assignmentRoute ?? assigneesRoute ?? progressUpdateRoute ?? statusRoute ?? archiveRoute;
        if (projectRoute && !isUuid(projectRoute[2])) {
          return error(400, "INVALID_PROJECT_ID", "案件IDの形式が不正です。");
        }
        const session = await getSession(req.headers);
        if (!session) {
          return error(401, "UNAUTHENTICATED", "ログインが必要です。");
        }
        // URLやヘッダーのuserId/role、選択中チームではなく、本人の現在の所属を読む。
        const membership = await prisma.teamMembership.findUnique({
          where: { teamId_userId: { teamId, userId: session.user.id } },
          select: { teamId: true, userId: true, role: true, team: { select: { id: true, name: true } } },
        });
        if (!canReadTeam(session.user.id, teamId, membership) || !membership) {
          // 存在しないチームも同じ応答とし、他チームの有無を知らせない。
          return error(403, "TEAM_ACCESS_DENIED", "このチームへのアクセスは許可されていません。");
        }
        if (meetingRoute) {
          const meetingId = meetingRoute[2]?.toLowerCase();
          if (meetingId && !isUuid(meetingId)) return error(400, 'INVALID_MEETING_ID');
          if (method !== 'GET') {
            if (url.searchParams.size) return error(400, 'INVALID_MEETING_QUERY');
            if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return error(415, 'UNSUPPORTED_MEDIA_TYPE');
            const body = await readJsonBody(req, 4096);
            if (body.tooLarge) return error(413, 'BODY_TOO_LARGE');
            if (body.invalid) return error(400, 'INVALID_MEETING_INPUT');
            if (meetingId) {
              const input = parseMeetingAction(body.value);
              if (!input) return error(400, 'INVALID_MEETING_INPUT', '操作と会議の版番号を確認してください。');
              const result = await actOnMeetingForUser(prisma, session.user.id, teamId, meetingId, input);
              return result.ok ? reply(200, { meeting: result.meeting, changed: result.changed }) : error(result.status, result.code, result.message);
            }
            const input = parseStartMeetingInput(body.value);
            if (!input) return error(400, 'INVALID_MEETING_INPUT');
            const result = await startMeetingForUser(prisma, session.user.id, teamId, input.facilitatorUserId);
            return result.ok ? reply(201, { meeting: result.meeting }, { Location: `${pathPrefix}/teams/${teamId}/meetings/${result.meeting.id}` }) : error(result.status, result.code, result.message);
          }
          if (meetingId) {
            if (url.searchParams.size) return error(400, 'INVALID_MEETING_QUERY');
            const result = await readMeetingForUser(prisma, session.user.id, teamId, meetingId);
            return result.ok ? reply(200, { meeting: result.meeting }) : error(result.status, result.code, result.message);
          }
          const params = url.searchParams;
          const query = parseListPageQuery({ limit: params.get('limit') ?? undefined, cursor: params.get('cursor') ?? undefined });
          if (!query || [...params.keys()].some(key => !['limit', 'cursor'].includes(key) || params.getAll(key).length !== 1)) return error(400, 'INVALID_MEETING_QUERY');
          const cursor = query.cursor ? await prisma.meeting.findFirst({ where: { id: query.cursor, teamId }, select: { startedAt: true, id: true } }) : null;
          if (query.cursor && !cursor) return error(400, 'INVALID_MEETING_CURSOR');
          const rows = await prisma.meeting.findMany({ where: { teamId,
            team: { teammemberships: { some: { userId: session.user.id, role: { in: ['admin', 'member'] } } } },
            ...(cursor ? { OR: [{ startedAt: { lt: cursor.startedAt } }, { startedAt: cursor.startedAt, id: { lt: cursor.id } }] } : {}) },
            orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: query.limit + 1, select: { id: true, startedAt: true, endedAt: true } });
          const items = rows.slice(0, query.limit), hasMore = rows.length > query.limit;
          return reply(200, { items, page: { hasMore, nextCursor: hasMore ? items[items.length - 1].id : null } });
        }
        if (archiveRoute) {
          if (url.searchParams.size !== 0) { return error(400, "INVALID_PROJECT_QUERY"); }
          if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") { return error(415, "UNSUPPORTED_MEDIA_TYPE"); }
          const body = await readJsonBody(req, 32768);
          if (body.tooLarge) { headers.set("Connection", "close"); return error(413, "BODY_TOO_LARGE"); }
          const input = body.invalid ? null : parseProjectArchiveInput(body.value, archiveRoute[3] as "archive" | "restore");
          if (!input) { return error(400, "INVALID_ARCHIVE_INPUT", "expectedVersionを指定してください。復元で担当を変える場合は主担当と副担当一覧も両方指定してください。"); }
          const result = await changeProjectArchiveForUser(prisma, session.user.id, teamId, archiveRoute[2].toLowerCase(), input);
          if (!result.ok) { return error(result.status, result.code, result.message); }
          return reply(200, { project: result.project, changed: result.changed });
        }
        if (archivedDetailRoute) {
          if (url.searchParams.size !== 0) { return error(400, "INVALID_PROJECT_QUERY"); }
          const project = await prisma.project.findFirst({ where: { id: archivedDetailRoute[2].toLowerCase(), teamId, archivedAt: { not: null },
            team: { teammemberships: { some: { userId: session.user.id, role: { in: ["admin", "member"] } } } } }, select: {
            id: true, name: true, code: true, dueDate: true, progress: true, status: true, summary: true, clientName: true, notes: true,
            version: true, archivedAt: true, createdAt: true, updatedAt: true, createdByParticipantId: true, createdByNameSnapshot: true,
            primaryParticipant: { select: { id: true, userId: true, user: { select: { name: true, teammemberships: { where: { teamId, role: { in: ["admin", "member"] } }, select: { id: true }, take: 1 } } } } },
          } });
          if (!project) { return error(404, "PROJECT_NOT_FOUND"); }
          return reply(200, { project: { id: project.id, name: project.name, code: project.code, dueDate: project.dueDate.toISOString().slice(0, 10),
            canArchive: canArchiveProject(session.user.id, teamId, membership, { primaryUserId: project.primaryParticipant.userId }),
            progress: project.progress, status: project.status, summary: project.summary, clientName: project.clientName, notes: project.notes,
            version: project.version, archivedAt: project.archivedAt!.toISOString(), createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString(),
            primaryAssignee: { participantId: project.primaryParticipant.id, userId: project.primaryParticipant.userId, name: project.primaryParticipant.user.name, isCurrentMember: project.primaryParticipant.user.teammemberships.length > 0 },
            createdBy: { participantId: project.createdByParticipantId, nameSnapshot: project.createdByNameSnapshot } } });
        }
        if (statusRoute) {
          if (url.searchParams.size !== 0) { return error(400, "INVALID_PROJECT_QUERY"); }
          if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") { return error(415, "UNSUPPORTED_MEDIA_TYPE"); }
          const body = await readJsonBody(req, 32768);
          if (body.tooLarge) { headers.set("Connection", "close"); return error(413, "BODY_TOO_LARGE"); }
          const input = body.invalid ? null : parseChangeProjectStatusInput(body.value);
          if (!input) { return error(400, "INVALID_STATUS_INPUT", "expectedVersionと5種類のstatus、必要なら2000文字以内のcommentを指定してください。進捗や変更者は指定できません。"); }
          const result = await changeProjectStatusForUser(prisma, session.user.id, teamId, statusRoute[2].toLowerCase(), input);
          if (!result.ok) { return error(result.status, result.code, result.message); }
          return reply(200, { project: result.project, changed: result.changed });
        }
        if (progressUpdateRoute) {
          if (url.searchParams.size !== 0) { return error(400, "INVALID_PROJECT_QUERY"); }
          if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") { return error(415, "UNSUPPORTED_MEDIA_TYPE"); }
          const body = await readJsonBody(req, 32768);
          if (body.tooLarge) { headers.set("Connection", "close"); return error(413, "BODY_TOO_LARGE"); }
          const input = body.invalid ? null : parseUpdateProjectProgressInput(body.value);
          if (!input) { return error(400, "INVALID_PROGRESS_INPUT", "expectedVersionと0〜100の整数progress、必要なら2000文字以内のcommentを指定してください。状態や変更者は指定できません。"); }
          const result = await updateProjectProgressForUser(prisma, session.user.id, teamId, progressUpdateRoute[2].toLowerCase(), input);
          if (!result.ok) { return error(result.status, result.code, result.message); }
          return reply(200, { project: result.project, changed: result.changed });
        }
        if (assigneesRoute) {
          if (url.searchParams.size !== 0) { return error(400, "INVALID_PROJECT_QUERY"); }
          if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") { return error(415, "UNSUPPORTED_MEDIA_TYPE"); }
          const body = await readJsonBody(req, 32768);
          if (body.tooLarge) { headers.set("Connection", "close"); return error(413, "BODY_TOO_LARGE"); }
          const input = body.invalid ? null : parseChangeProjectAssigneesInput(body.value);
          if (!input) { return error(400, "INVALID_ASSIGNEES_INPUT", "expectedVersion、主担当のuserId、重複しない副担当のuserId一覧（0〜50人）だけを指定してください。"); }
          const result = await changeProjectAssigneesForUser(prisma, session.user.id, teamId, assigneesRoute[2].toLowerCase(), input);
          if (!result.ok) { return error(result.status, result.code, result.message); }
          return reply(200, { project: result.project, changed: result.changed });
        }
        if (teamRoute?.[2] === "members") {
          const params = url.searchParams;
          const query = parseListPageQuery({ limit: params.get("limit") ?? undefined, cursor: params.get("cursor") ?? undefined });
          if (!query || Array.from(params.keys()).some(key => !["limit", "cursor"].includes(key) || params.getAll(key).length !== 1)) {
            return error(400, "INVALID_MEMBER_QUERY");
          }
          if (query.cursor && !await prisma.teamMembership.findFirst({
            where: { teamId, userId: query.cursor, role: { in: ["admin", "member"] } }, select: { id: true },
          })) { return error(400, "INVALID_MEMBER_CURSOR"); }
          const rows = await prisma.teamMembership.findMany({
            where: { teamId, role: { in: ["admin", "member"] }, ...(query.cursor ? { userId: { gt: query.cursor } } : {}),
              team: { teammemberships: { some: { userId: session.user.id, role: { in: ["admin", "member"] } } } } },
            orderBy: { userId: "asc" }, take: query.limit + 1, select: { userId: true, role: true, user: { select: { name: true } } },
          });
          const hasMore = rows.length > query.limit;
          const items = rows.slice(0, query.limit).map(row => ({ userId: row.userId, name: row.user.name, role: row.role }));
          return reply(200, { items, page: { limit: query.limit, hasMore, nextCursor: hasMore ? items[items.length - 1].userId : null } });
        }
        if (teamRoute?.[2] === "projects" && method === "POST") {
          if (url.searchParams.size !== 0) { return error(400, "INVALID_PROJECT_QUERY"); }
          if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
            return error(415, "UNSUPPORTED_MEDIA_TYPE", "application/jsonで送信してください。");
          }
          const body = await readJsonBody(req, 32768);
          if (body.tooLarge) { headers.set("Connection", "close"); return error(413, "BODY_TOO_LARGE", "送信内容は32768バイト以内にしてください。"); }
          const input = body.invalid ? null : parseCreateProjectInput(body.value);
          if (!input) { return error(400, "INVALID_PROJECT_INPUT", "案件名・実在する納期・主担当・重複しない副担当と、項目の文字数を確認してください。"); }
          const result = await createProjectForUser(prisma, session.user.id, teamId, input);
          if (!result.ok) { return error(result.status, result.code, result.message); }
          return reply(201, { project: result.project }, { Location: `${pathPrefix}/teams/${teamId}/projects/${result.project.id}` });
        }
        const collectionRoute = supportRoute ?? progressRoute ?? assignmentRoute;
        if (collectionRoute) {
          const projectId = collectionRoute[2].toLowerCase();
          const archivedCollection = pathname.includes("/archived-projects/");
          const projectWhere = {
            id: projectId, teamId, archivedAt: archivedCollection ? { not: null } : null,
            team: { teammemberships: { some: { userId: session.user.id, role: { in: ["admin", "member"] as ("admin" | "member")[] } } } },
          };
          if (!await prisma.project.findFirst({ where: projectWhere, select: { id: true } })) {
            return error(404, "PROJECT_NOT_FOUND", "案件が見つかりません。");
          }
          const params = url.searchParams;
          const query = parseListPageQuery({ limit: params.get("limit") ?? undefined, cursor: params.get("cursor") ?? undefined });
          if (!query || Array.from(params.keys()).some(key => !["limit", "cursor"].includes(key) || params.getAll(key).length !== 1)) {
            return error(400, progressRoute || assignmentRoute ? "INVALID_HISTORY_QUERY" : "INVALID_SUPPORT_QUERY", "limitは1〜50、cursorは前の応答のnextCursorを1つ指定してください。");
          }
          if (assignmentRoute) {
            const cursor = query.cursor ? await prisma.projectAssignmentHistory.findFirst({
              where: { id: query.cursor, teamId, projectId, project: projectWhere }, select: { id: true, changedAt: true },
            }) : null;
            if (query.cursor && !cursor) {
              return error(400, "INVALID_HISTORY_CURSOR", "続きの目印が使えません。cursorを外して最初から取得してください。");
            }
            const rows = await prisma.projectAssignmentHistory.findMany({
              where: {
                teamId, projectId, project: projectWhere,
                ...(cursor ? { OR: [{ changedAt: { lt: cursor.changedAt } }, { changedAt: cursor.changedAt, id: { lt: cursor.id } }] } : {}),
              },
              orderBy: [{ changedAt: "desc" }, { id: "desc" }], take: query.limit + 1,
              select: {
                id: true, kind: true, changedAt: true, previousParticipantId: true, nextParticipantId: true,
                previousNameSnapshot: true, nextNameSnapshot: true, changedByParticipantId: true, changedByNameSnapshot: true,
              },
            });
            const hasMore = rows.length > query.limit;
            const items = rows.slice(0, query.limit).map(row => ({
              id: row.id, kind: row.kind, changedAt: row.changedAt.toISOString(),
              previousAssignee: row.previousParticipantId === null ? null : { participantId: row.previousParticipantId, nameSnapshot: row.previousNameSnapshot },
              nextAssignee: row.nextParticipantId === null ? null : { participantId: row.nextParticipantId, nameSnapshot: row.nextNameSnapshot },
              changedBy: { participantId: row.changedByParticipantId, nameSnapshot: row.changedByNameSnapshot },
            }));
            return reply(200, { items, page: { limit: query.limit, hasMore, nextCursor: hasMore ? items[items.length - 1].id : null } });
          }
          if (progressRoute) {
            const cursor = query.cursor ? await prisma.projectProgressHistory.findFirst({
              where: { id: query.cursor, teamId, projectId, project: projectWhere }, select: { id: true, changedAt: true },
            }) : null;
            if (query.cursor && !cursor) {
              return error(400, "INVALID_HISTORY_CURSOR", "続きの目印が使えません。cursorを外して最初から取得してください。");
            }
            const rows = await prisma.projectProgressHistory.findMany({
              where: {
                teamId, projectId, project: projectWhere,
                ...(cursor ? { OR: [{ changedAt: { lt: cursor.changedAt } }, { changedAt: cursor.changedAt, id: { lt: cursor.id } }] } : {}),
              },
              orderBy: [{ changedAt: "desc" }, { id: "desc" }], take: query.limit + 1,
              select: {
                id: true, changedAt: true, previousProgress: true, nextProgress: true,
                previousStatus: true, nextStatus: true, comment: true,
                changedByParticipantId: true, changedByNameSnapshot: true,
              },
            });
            const hasMore = rows.length > query.limit;
            const items = rows.slice(0, query.limit).map(row => ({
              id: row.id, changedAt: row.changedAt.toISOString(),
              previousProgress: row.previousProgress, nextProgress: row.nextProgress,
              previousStatus: row.previousStatus, nextStatus: row.nextStatus, comment: row.comment,
              changedBy: { participantId: row.changedByParticipantId, nameSnapshot: row.changedByNameSnapshot },
            }));
            return reply(200, { items, page: { limit: query.limit, hasMore, nextCursor: hasMore ? items[items.length - 1].id : null } });
          }
          if (query.cursor && !await prisma.projectSupportMember.findFirst({
            where: { teamId, projectId, participantId: query.cursor, project: projectWhere }, select: { participantId: true },
          })) {
            return error(400, "INVALID_SUPPORT_CURSOR", "続きの目印が使えません。cursorを外して最初から取得してください。");
          }
          const rows = await prisma.projectSupportMember.findMany({
            where: { teamId, projectId, project: projectWhere, ...(query.cursor ? { participantId: { gt: query.cursor } } : {}) },
            orderBy: { participantId: "asc" }, take: query.limit + 1,
            select: { participantId: true, participant: { select: { userId: true,
              user: { select: { name: true, teammemberships: { where: { teamId }, select: { id: true }, take: 1 } } },
            } } },
          });
          const hasMore = rows.length > query.limit;
          const items = rows.slice(0, query.limit).map(row => ({
            participantId: row.participantId, name: row.participant.user.name,
            isCurrentMember: row.participant.user.teammemberships.length > 0,
            userId: row.participant.userId,
          }));
          return reply(200, { items, page: { limit: query.limit, hasMore, nextCursor: hasMore ? items[items.length - 1].participantId : null } });
        }
        if (detailRoute) {
          if (url.searchParams.size !== 0) {
            return error(400, "INVALID_PROJECT_QUERY", "案件詳細に検索条件は指定できません。");
          }
          if (method === "PATCH") {
            if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
              return error(415, "UNSUPPORTED_MEDIA_TYPE", "application/jsonで送信してください。");
            }
            const body = await readJsonBody(req, 32768);
            if (body.tooLarge) { headers.set("Connection", "close"); return error(413, "BODY_TOO_LARGE"); }
            const input = body.invalid ? null : parseEditProjectInput(body.value);
            if (!input) { return error(400, "INVALID_PROJECT_EDIT_INPUT", "正しいexpectedVersionと、変更する基本項目を指定してください。名前は1〜200文字、納期は実在するYYYY-MM-DDです。"); }
            const result = await editProjectForUser(prisma, session.user.id, teamId, detailRoute[2].toLowerCase(), input);
            if (!result.ok) { return error(result.status, result.code, result.message); }
            return reply(200, { project: result.project });
          }
          // IDが分かっても読めないよう、案件ID・チーム・現在の所属で検索する。
          const project = await prisma.project.findFirst({
            where: {
              id: detailRoute[2].toLowerCase(), teamId, archivedAt: null,
              team: { teammemberships: { some: { userId: session.user.id, role: { in: ["admin", "member"] } } } },
            },
            select: {
              id: true, name: true, code: true, dueDate: true, progress: true, status: true,
              summary: true, clientName: true, notes: true, version: true, createdAt: true, updatedAt: true,
              createdByParticipantId: true, createdByNameSnapshot: true,
              primaryParticipant: { select: { id: true, userId: true, user: { select: { name: true } } } },
            },
          });
          if (!project) {
            return error(404, "PROJECT_NOT_FOUND", "案件が見つかりません。");
          }
          return reply(200, { project: {
            canArchive: canArchiveProject(session.user.id, teamId, membership, { primaryUserId: project.primaryParticipant.userId }),
            id: project.id, name: project.name, code: project.code, dueDate: project.dueDate.toISOString().slice(0, 10),
            progress: project.progress, status: project.status, summary: project.summary, clientName: project.clientName,
            notes: project.notes, version: project.version, createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString(),
            primaryAssignee: { participantId: project.primaryParticipant.id, userId: project.primaryParticipant.userId, name: project.primaryParticipant.user.name },
            createdBy: { participantId: project.createdByParticipantId, nameSnapshot: project.createdByNameSnapshot },
          } });
        }
        if (teamRoute?.[2] === "projects" || teamRoute?.[2] === "archived-projects") {
          const archivedOnly = teamRoute[2] === "archived-projects";
          const archivedAt = archivedOnly ? { not: null } : null;
          const params = url.searchParams;
          const query = parseListPageQuery({ limit: params.get("limit") ?? undefined, cursor: params.get("cursor") ?? undefined });
          if (!query || Array.from(params.keys()).some(key => !["limit", "cursor"].includes(key) || params.getAll(key).length !== 1)) {
            return error(400, "INVALID_PROJECT_QUERY", "limitは1〜50、cursorは前の応答のnextCursorを1つ指定してください。");
          }
          // カーソルも、対象チームの取得中の一覧（通常/保管）にある案件に限定する。
          const cursor = query.cursor ? await prisma.project.findFirst({
            where: { id: query.cursor, teamId, archivedAt }, select: { id: true, dueDate: true },
          }) : null;
          if (query.cursor && !cursor) {
            return error(400, "INVALID_PROJECT_CURSOR", "続きの目印が使えません。cursorを外して最初から取得してください。");
          }
          const rows = await prisma.project.findMany({
            where: {
              teamId, archivedAt,
              // 実際に案件を読むクエリも、現在の所属で絞る。
              team: { teammemberships: { some: { userId: session.user.id, role: { in: ["admin", "member"] } } } },
              ...(cursor ? { OR: [{ dueDate: { gt: cursor.dueDate } }, { dueDate: cursor.dueDate, id: { gt: cursor.id } }] } : {}),
            },
            orderBy: [{ dueDate: "asc" }, { id: "asc" }],
            take: query.limit + 1,
            select: {
              id: true, name: true, code: true, dueDate: true, progress: true, status: true,
              archivedAt: true, version: true,
              primaryParticipant: { select: { id: true, user: { select: { name: true } } } },
            },
          });
          const hasMore = rows.length > query.limit;
          const items = rows.slice(0, query.limit).map(row => ({
            id: row.id, name: row.name, code: row.code, dueDate: row.dueDate.toISOString().slice(0, 10),
            progress: row.progress, status: row.status,
            primaryAssignee: { participantId: row.primaryParticipant.id, name: row.primaryParticipant.user.name },
            ...(archivedOnly ? { archivedAt: row.archivedAt!.toISOString(), version: row.version } : {}),
          }));
          return reply(200, { items, page: { limit: query.limit, hasMore, nextCursor: hasMore ? items[items.length - 1].id : null } });
        }
        return reply(200, { team: membership.team, role: membership.role });
      }
      return await authHandler(req);
    } catch {
      // DB例外には接続設定が含まれ得るため、詳細を返さない。
      return error(500, "AUTH_CHECK_FAILED");
    }
  };
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    const response = await handle(request);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Vary", "Cookie");
    response.headers.set("X-Request-Id", requestId);
    console.info(JSON.stringify({ event: "siteflow_api", requestId, status: response.status }));
    return response;
  };
}
