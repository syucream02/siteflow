import type { PrismaClient } from './generated/integrated/client.ts';
import { isUuid, parseListPageQuery, parseTeamManagementInput } from '../../lib/siteflow/domain.ts';
import { readJsonBody } from './json-body.ts';
import { changeTeamMembership, checkTeamRemoval, readTeamSettings, teamFailure } from './team-membership-service.ts';
import { answerTeamInvitation, cancelTeamInvitation, createTeamInvitation, readMyInvitations, readTeamInvitations } from './team-invitation-service.ts';

export function matchTeamManagement(path: string) {
  const patterns = [
    [/^\/api\/teams\/([^/]+)\/settings$/, ['GET', 'PATCH'], 'settings'],
    [/^\/api\/teams\/([^/]+)\/members\/([^/]+)\/removal-check$/, ['GET'], 'check'],
    [/^\/api\/teams\/([^/]+)\/members\/([^/]+)$/, ['PATCH', 'DELETE'], 'member'],
    [/^\/api\/teams\/([^/]+)\/leave$/, ['POST'], 'leave'],
    [/^\/api\/teams\/([^/]+)\/invitations$/, ['GET', 'POST'], 'invitations'],
    [/^\/api\/teams\/([^/]+)\/invitations\/([^/]+)\/cancel$/, ['POST'], 'cancel'],
    [/^\/api\/me\/invitations$/, ['GET'], 'mine'],
    [/^\/api\/me\/invitations\/([^/]+)\/(accept|decline)$/, ['POST'], 'answer'],
  ] as const;
  for (const [pattern, methods, kind] of patterns) {
    const match = pattern.exec(path); if (match) return { methods: methods as readonly string[], kind, ids: match.slice(1) };
  }
  return null;
}

export async function handleTeamManagement(prisma: PrismaClient, userId: string, route: NonNullable<ReturnType<typeof matchTeamManagement>>, req: Request, url: URL) {
  const { kind } = route;
  const ids = route.ids.map((id, i) => kind === 'answer' && i === 1 ? id : id.toLowerCase());
  if (ids.some((id, i) => !(kind === 'answer' && i === 1) && !isUuid(id))) return teamFailure(400, 'INVALID_TEAM_INPUT');
  if (req.method === 'GET') {
    if (kind === 'settings' || kind === 'check') {
      if (url.searchParams.size) return teamFailure(400, 'INVALID_TEAM_QUERY');
      return kind === 'settings' ? readTeamSettings(prisma, userId, ids[0]) : checkTeamRemoval(prisma, userId, ids[0], ids[1]);
    }
    if ([...url.searchParams.keys()].some(k => !['cursor', 'limit'].includes(k) || url.searchParams.getAll(k).length !== 1)) return teamFailure(400, 'INVALID_TEAM_QUERY');
    const page = parseListPageQuery({ limit: url.searchParams.get('limit') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined });
    if (!page) return teamFailure(400, 'INVALID_TEAM_QUERY');
    return kind === 'mine' ? readMyInvitations(prisma, userId, page) : readTeamInvitations(prisma, userId, ids[0], page);
  }
  if (url.searchParams.size) return teamFailure(400, 'INVALID_TEAM_QUERY');
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return teamFailure(415, 'UNSUPPORTED_MEDIA_TYPE');
  const body = await readJsonBody(req, 4096);
  if (body.tooLarge) return teamFailure(413, 'BODY_TOO_LARGE');
  if (body.invalid) return teamFailure(400, 'INVALID_TEAM_INPUT');
  if (kind === 'answer') {
    if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value) || Object.keys(body.value).length) return teamFailure(400, 'INVALID_TEAM_INPUT');
    return answerTeamInvitation(prisma, userId, ids[0], ids[1] as 'accept' | 'decline');
  }
  const action = kind === 'settings' ? 'rename' : kind === 'member' ? req.method === 'DELETE' ? 'remove' : 'role' : kind === 'invitations' ? 'invite' : kind;
  const parsed = parseTeamManagementInput(action, body.value);
  if (!parsed) return teamFailure(400, 'INVALID_TEAM_INPUT', '入力項目とチームの版番号を確認してください。');
  if (parsed.action === 'invite') return createTeamInvitation(prisma, userId, ids[0], parsed.email, parsed.expectedVersion);
  if (parsed.action === 'cancel') return cancelTeamInvitation(prisma, userId, ids[0], ids[1], parsed.expectedVersion);
  return changeTeamMembership(prisma, userId, ids[0], ids[1] ?? null, parsed);
}
