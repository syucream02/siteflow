// UIに依存しない業務ルール。将来、APIでも同じルールを使えるように分離する。
export interface CurrentTeamMembership {
  teamId: string;
  userId: string;
  role: string;
}

export function parseCreateTeamInput(input: unknown): { name: string } | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'name')) return null;
  const name = (input as { name: unknown }).name;
  if (typeof name !== 'string' || /[\u0000-\u001f\u007f]/.test(name)) return null;
  const trimmed = name.trim();
  if (Array.from(trimmed).length < 1 || Array.from(trimmed).length > 80) return null;
  return { name: trimmed };
}

export function canCreateTeam(user: { emailVerified: boolean } | null): boolean {
  return user?.emailVerified === true;
}

export interface CreateProjectInput {
  name: string;
  dueDate: string;
  primaryUserId: string;
  supportUserIds: string[];
  code: string | null;
  summary: string | null;
  clientName: string | null;
  notes: string | null;
}

export function parseCreateProjectInput(input: unknown): CreateProjectInput | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  const allowed = ['name', 'dueDate', 'primaryUserId', 'supportUserIds', 'code', 'summary', 'clientName', 'notes'];
  if (Object.keys(body).some(key => !allowed.includes(key))) return null;
  if (typeof body.name !== 'string' || /[\u0000-\u001f\u007f]/.test(body.name)) return null;
  const name = body.name.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 200) return null;
  if (typeof body.dueDate !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(body.dueDate)) return null;
  const date = new Date(`${body.dueDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== body.dueDate) return null;
  if (typeof body.primaryUserId !== 'string' || !isUuid(body.primaryUserId)) return null;
  const primaryUserId = body.primaryUserId.toLowerCase();
  const supports = body.supportUserIds === undefined ? [] : body.supportUserIds;
  if (!Array.isArray(supports) || supports.length > 50 || supports.some(id => typeof id !== 'string' || !isUuid(id))) return null;
  const supportUserIds = supports.map((id: string) => id.toLowerCase());
  if (new Set(supportUserIds).size !== supportUserIds.length || supportUserIds.includes(primaryUserId)) return null;
  const optional: Record<string, string | null> = {};
  for (const [key, max, multiline] of [['code', 100, false], ['clientName', 200, false], ['summary', 2000, true], ['notes', 2000, true]] as const) {
    const value = body[key];
    if (value === undefined || value === null) { optional[key] = null; continue; }
    if (typeof value !== 'string' || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) return null;
    const trimmed = value.trim();
    if (Array.from(trimmed).length > max) return null;
    optional[key] = trimmed || null;
  }
  return { name, dueDate: body.dueDate, primaryUserId, supportUserIds, code: optional.code, clientName: optional.clientName, summary: optional.summary, notes: optional.notes };
}

// 作成は全メンバーに許可。編集・担当変更の許可には流用しない。
export function canCreateProject(userId: string, teamId: string, membership: CurrentTeamMembership | null): boolean {
  return canReadTeam(userId, teamId, membership);
}

export type ProjectBasicFields = Pick<CreateProjectInput, 'name' | 'dueDate' | 'code' | 'summary' | 'clientName' | 'notes'>;
export interface EditProjectInput {
  expectedVersion: number;
  changes: Partial<ProjectBasicFields>;
}

// PATCHでは省略した項目を保持する。null/空文字で消せるのは任意項目だけ。
export function parseEditProjectInput(input: unknown): EditProjectInput | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  const fields = ['name', 'dueDate', 'code', 'summary', 'clientName', 'notes'] as const;
  if (Object.keys(body).some(key => key !== 'expectedVersion' && !fields.some(field => field === key))) return null;
  if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)
    || body.expectedVersion < 1 || body.expectedVersion >= 2147483647) return null;
  const keys = fields.filter(key => Object.hasOwn(body, key));
  if (keys.length === 0 || keys.some(key => body[key] === undefined)) return null;
  // 作成と同じ文字数・日付ルールを使う。担当などの作成専用項目は受け付けない。
  const parsed = parseCreateProjectInput({ name: 'validation', dueDate: '2000-01-01',
    ...Object.fromEntries(keys.map(key => [key, body[key]])), primaryUserId: '00000000-0000-4000-8000-000000000000' });
  if (!parsed) return null;
  const changes = Object.fromEntries(keys.map(key => [key, parsed[key]])) as Partial<ProjectBasicFields>;
  return { expectedVersion: body.expectedVersion, changes };
}

export function canEditProject(userId: string, teamId: string, membership: CurrentTeamMembership | null,
  assignment: { primaryUserId: string; supportUserIds: readonly string[] }): boolean {
  return canReadTeam(userId, teamId, membership)
    && (membership?.role === 'admin' || assignment.primaryUserId === userId || assignment.supportUserIds.includes(userId));
}

// 保管は通常編集より権限を絞る。副担当であることだけでは許可しない。
export function canArchiveProject(userId: string, teamId: string, membership: CurrentTeamMembership | null,
  assignment: { primaryUserId: string }): boolean {
  return canReadTeam(userId, teamId, membership)
    && (membership?.role === 'admin' || assignment.primaryUserId === userId);
}

export interface ChangeProjectAssigneesInput {
  expectedVersion: number;
  primaryUserId: string;
  supportUserIds: string[];
}

// 担当一覧の置き換えなので、副担当0人も[]で明示する。
export function parseChangeProjectAssigneesInput(input: unknown): ChangeProjectAssigneesInput | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  if (Object.keys(body).length !== 3 || Object.keys(body).some(key => !['expectedVersion', 'primaryUserId', 'supportUserIds'].includes(key))) return null;
  if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)
    || body.expectedVersion < 1 || body.expectedVersion >= 2147483647) return null;
  if (typeof body.primaryUserId !== 'string' || !isUuid(body.primaryUserId)) return null;
  if (!Array.isArray(body.supportUserIds) || body.supportUserIds.length > 50
    || body.supportUserIds.some(id => typeof id !== 'string' || !isUuid(id))) return null;
  const primaryUserId = body.primaryUserId.toLowerCase();
  const supportUserIds = body.supportUserIds.map((id: string) => id.toLowerCase());
  if (new Set(supportUserIds).size !== supportUserIds.length || supportUserIds.includes(primaryUserId)) return null;
  return { expectedVersion: body.expectedVersion, primaryUserId, supportUserIds };
}

export function diffProjectAssignees(
  current: { primaryUserId: string; supportUserIds: readonly string[] },
  next: { primaryUserId: string; supportUserIds: readonly string[] },
): { primaryChanged: boolean; addedUserIds: string[]; removedUserIds: string[] } {
  const before = new Set(current.supportUserIds);
  const after = new Set(next.supportUserIds);
  return { primaryChanged: current.primaryUserId !== next.primaryUserId,
    addedUserIds: [...after].filter(id => !before.has(id)).sort(),
    removedUserIds: [...before].filter(id => !after.has(id)).sort() };
}

export interface UpdateProjectProgressInput {
  expectedVersion: number;
  progress: number;
  comment: string | null;
}

export function parseUpdateProjectProgressInput(input: unknown): UpdateProjectProgressInput | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !['expectedVersion', 'progress', 'comment'].includes(key))) return null;
  if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)
    || body.expectedVersion < 1 || body.expectedVersion >= 2147483647) return null;
  if (typeof body.progress !== 'number' || !Number.isInteger(body.progress) || body.progress < 0 || body.progress > 100) return null;
  let comment: string | null = null;
  if (body.comment !== undefined && body.comment !== null) {
    if (typeof body.comment !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.comment)) return null;
    const trimmed = body.comment.trim();
    if (Array.from(trimmed).length > 2000) return null;
    comment = trimmed || null;
  }
  return { expectedVersion: body.expectedVersion, progress: body.progress, comment };
}

// 進捗の変更では状態を自動変更しない。完了/再開は状態変更の操作で扱う。
export function planProjectProgressUpdate(current: { progress: number; status: string }, input: UpdateProjectProgressInput):
  { ok: true; changed: boolean } | { ok: false; code: 'PROJECT_COMPLETED' | 'COMMENT_WITHOUT_PROGRESS_CHANGE' } {
  if (current.progress === input.progress) {
    if (input.comment !== null) return { ok: false, code: 'COMMENT_WITHOUT_PROGRESS_CHANGE' };
    return { ok: true, changed: false };
  }
  if (current.status === 'DONE') return { ok: false, code: 'PROJECT_COMPLETED' };
  return { ok: true, changed: true };
}

export const projectStatuses = ['NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'ON_HOLD', 'DONE'] as const;
export type ProjectStatus = (typeof projectStatuses)[number];
export interface ChangeProjectStatusInput {
  expectedVersion: number;
  status: ProjectStatus;
  comment: string | null;
}

// 入力の形の確認。どの状態へ変更できるかは、業務ルールで別に判定する。
export function parseChangeProjectStatusInput(input: unknown): ChangeProjectStatusInput | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !['expectedVersion', 'status', 'comment'].includes(key))) return null;
  if (typeof body.status !== 'string' || !projectStatuses.some(status => status === body.status)) return null;
  // メモと版の規則を進捗更新とそろえる。progress自体は外部入力から受け付けない。
  const parsed = parseUpdateProjectProgressInput({ expectedVersion: body.expectedVersion, progress: 0, comment: body.comment });
  if (!parsed) return null;
  return { expectedVersion: parsed.expectedVersion, status: body.status as ProjectStatus, comment: parsed.comment };
}

const projectTransitions: Record<ProjectStatus, readonly ProjectStatus[]> = {
  NOT_STARTED: ['IN_PROGRESS', 'ON_HOLD'],
  IN_PROGRESS: ['REVIEW', 'ON_HOLD'],
  REVIEW: ['IN_PROGRESS', 'ON_HOLD', 'DONE'],
  ON_HOLD: ['IN_PROGRESS'],
  DONE: ['IN_PROGRESS'],
};

// 画面の選択肢も同じ遷移表を使う。完了の進捗条件や再開理由は別途判定する。
export function availableProjectStatusTargets(status: ProjectStatus): ProjectStatus[] {
  return [...projectTransitions[status]];
}

export function planProjectStatusChange(current: { status: ProjectStatus; progress: number }, input: ChangeProjectStatusInput):
  { ok: true; changed: boolean; reopening: boolean } |
  { ok: false; code: 'INVALID_STATUS_TRANSITION' | 'PROGRESS_REQUIRED_FOR_COMPLETION' | 'REOPEN_REASON_REQUIRED' | 'COMMENT_WITHOUT_STATUS_CHANGE' } {
  if (current.status === input.status) {
    if (input.comment !== null) return { ok: false, code: 'COMMENT_WITHOUT_STATUS_CHANGE' };
    return { ok: true, changed: false, reopening: false };
  }
  if (!projectTransitions[current.status].includes(input.status)) return { ok: false, code: 'INVALID_STATUS_TRANSITION' };
  if (input.status === 'DONE' && current.progress !== 100) return { ok: false, code: 'PROGRESS_REQUIRED_FOR_COMPLETION' };
  const reopening = current.status === 'DONE';
  if (reopening && !input.comment?.trim()) return { ok: false, code: 'REOPEN_REASON_REQUIRED' };
  return { ok: true, changed: true, reopening };
}

export interface ProjectArchiveInput {
  expectedVersion: number;
  archived: boolean;
  assignees?: { primaryUserId: string; supportUserIds: string[] };
}

export function parseProjectArchiveInput(input: unknown, action: 'archive' | 'restore'): ProjectArchiveInput | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  const allowed = action === 'restore' ? ['expectedVersion', 'primaryUserId', 'supportUserIds'] : ['expectedVersion'];
  if (Object.keys(body).some(key => !allowed.includes(key))) return null;
  if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)
    || body.expectedVersion < 1 || body.expectedVersion >= 2147483647) return null;
  const hasAssignees = Object.hasOwn(body, 'primaryUserId') || Object.hasOwn(body, 'supportUserIds');
  if (!hasAssignees) return { expectedVersion: body.expectedVersion, archived: action === 'archive' };
  const parsed = parseChangeProjectAssigneesInput(body);
  if (!parsed) return null;
  return { expectedVersion: parsed.expectedVersion, archived: false,
    assignees: { primaryUserId: parsed.primaryUserId, supportUserIds: parsed.supportUserIds } };
}

export function planProjectArchiveChange(currentArchived: boolean, input: ProjectArchiveInput):
  { ok: true; changed: boolean } | { ok: false; code: 'PROJECT_NOT_ARCHIVED' } {
  if (!currentArchived && !input.archived && input.assignees) return { ok: false, code: 'PROJECT_NOT_ARCHIVED' };
  return { ok: true, changed: currentArchived !== input.archived };
}

export function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

export const meetingProjectLimit = 500;

// 進行役ありの場合、管理者にも進行権限を自動で追加しない。
export function canRunMeeting(userId: string, teamId: string, membership: CurrentTeamMembership | null, facilitatorUserId: string | null): boolean {
  return canReadTeam(userId, teamId, membership) && (facilitatorUserId === null || facilitatorUserId === userId);
}

export type MeetingAction =
  | { action: 'confirm' | 'unconfirm'; expectedVersion: number; entryId: string }
  | { action: 'finish'; expectedVersion: number; allowUnconfirmed: boolean }
  | { action: 'facilitator'; expectedVersion: number; facilitatorUserId: string | null };

export function parseStartMeetingInput(value: unknown): { facilitatorUserId: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== 'facilitatorUserId')) return null;
  if (body.facilitatorUserId === undefined || body.facilitatorUserId === null) return { facilitatorUserId: null };
  if (typeof body.facilitatorUserId !== 'string' || !body.facilitatorUserId.trim() || body.facilitatorUserId.length > 191) return null;
  return { facilitatorUserId: body.facilitatorUserId };
}

export function parseMeetingAction(value: unknown): MeetingAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1 || (body.expectedVersion as number) >= 2147483647) return null;
  const expectedVersion = body.expectedVersion as number;
  if (body.action === 'confirm' || body.action === 'unconfirm') {
    if (Object.keys(body).some(key => !['action', 'expectedVersion', 'entryId'].includes(key)) || typeof body.entryId !== 'string' || !isUuid(body.entryId)) return null;
    return { action: body.action, expectedVersion, entryId: body.entryId.toLowerCase() };
  }
  if (body.action === 'finish') {
    if (Object.keys(body).some(key => !['action', 'expectedVersion', 'allowUnconfirmed'].includes(key)) || typeof body.allowUnconfirmed !== 'boolean') return null;
    return { action: 'finish', expectedVersion, allowUnconfirmed: body.allowUnconfirmed };
  }
  if (body.action === 'facilitator') {
    if (Object.keys(body).some(key => !['action', 'expectedVersion', 'facilitatorUserId'].includes(key)) || !Object.hasOwn(body, 'facilitatorUserId')) return null;
    const parsed = parseStartMeetingInput({ facilitatorUserId: body.facilitatorUserId });
    if (!parsed) return null;
    return { action: 'facilitator', expectedVersion, facilitatorUserId: parsed.facilitatorUserId };
  }
  return null;
}

// 案件・副担当など、UUIDを目印にする一覧の共通入力。
export function parseListPageQuery(input: { limit?: string; cursor?: string }): { limit: number; cursor?: string } | null {
  const limit = input.limit === undefined ? 20 : Number(input.limit);
  if (input.limit !== undefined && !/^[1-9]\d*$/.test(input.limit)) return null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return null;
  if (input.cursor !== undefined && !isUuid(input.cursor)) return null;
  return { limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor.toLowerCase() }) };
}

// チーム情報・案件と関連情報を読む許可。案件編集・所属管理の許可には流用しない。
export function canReadTeam(
  userId: string,
  teamId: string,
  membership: CurrentTeamMembership | null,
): boolean {
  return membership !== null
    && membership.userId === userId
    && membership.teamId === teamId
    && (membership.role === 'admin' || membership.role === 'member');
}

export const statuses = ['open', 'in_progress', 'review', 'done'] as const;
export type Status = (typeof statuses)[number];
export const statusLabels: Record<Status, string> = {
  open: '未対応',
  in_progress: '対応中',
  review: '確認待ち',
  done: '完了',
};
export interface Project {
  id: string;
  code: string;
  name: string;
  location: string;
  dueDate: string;
  owner: string;
}
export interface Issue {
  id: string;
  projectId: string;
  title: string;
  location: string;
  assignee: string;
  dueDate: string;
  priority: 'normal' | 'high';
  description: string;
  status: Status;
  response: string;
  history: { label: string; at: string }[];
}
export const members = ['山田 太郎', '佐藤 花', '田中 健'];
const transitions: Record<Status, Status[]> = {
  open: ['in_progress'],
  in_progress: ['review'],
  review: ['done', 'in_progress'],
  done: [],
};
export function availableTransitions(status: Status): Status[] {
  return transitions[status];
}
export function changeStatus(issue: Issue, target: Status, at: string): Issue {
  if (!transitions[issue.status].includes(target))
    throw new Error('この状態には変更できません。');
  if (target === 'review' && !issue.response.trim())
    throw new Error('確認依頼の前に対応内容を入力してください。');
  if (target === 'done' && !issue.response.trim())
    throw new Error('完了の前に対応内容を入力してください。');
  return {
    ...issue,
    status: target,
    history: [...issue.history, { label: statusLabels[target], at }],
  };
}
export function validateIssue(
  input: Pick<
    Issue,
    'title' | 'location' | 'assignee' | 'dueDate' | 'description'
  >,
): string | null {
  if (!input.title.trim() || input.title.trim().length > 80)
    return '件名は1〜80文字で入力してください。';
  if (!input.location.trim() || input.location.trim().length > 100)
    return '場所は1〜100文字で入力してください。';
  if (!members.includes(input.assignee)) return '担当者を選んでください。';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate))
    return '期限を入力してください。';
  const date = new Date(`${input.dueDate}T00:00:00Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== input.dueDate
  )
    return '有効な日付を入力してください。';
  if (input.description.length > 2000)
    return '詳細は2000文字以内で入力してください。';
  return null;
}
export function todayInTokyo(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export function isOverdue(issue: Issue, today: string): boolean {
  return issue.status !== 'done' && issue.dueDate < today;
}
export function completionRate(issues: Issue[]): number {
  return issues.length
    ? Math.round(
        (issues.filter((i) => i.status === 'done').length / issues.length) *
          100,
      )
    : 0;
}
