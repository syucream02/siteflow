// UIに依存しない業務ルール。将来、APIでも同じルールを使えるように分離する。
export const statuses = ["open", "in_progress", "review", "done"] as const;
export type Status = (typeof statuses)[number];
export const statusLabels: Record<Status, string> = { open: "未対応", in_progress: "対応中", review: "確認待ち", done: "完了" };
export interface Project { id: string; code: string; name: string; location: string; dueDate: string; owner: string; }
export interface Issue {
  id: string; projectId: string; title: string; location: string; assignee: string;
  dueDate: string; priority: "normal" | "high"; description: string; status: Status;
  response: string; history: { label: string; at: string }[];
}
export const members = ["山田 太郎", "佐藤 花", "田中 健"];
const transitions: Record<Status, Status[]> = { open: ["in_progress"], in_progress: ["review"], review: ["done", "in_progress"], done: [] };
export function availableTransitions(status: Status): Status[] { return transitions[status]; }
export function changeStatus(issue: Issue, target: Status, at: string): Issue {
  if (!transitions[issue.status].includes(target)) throw new Error("この状態には変更できません。");
  if (target === "review" && !issue.response.trim()) throw new Error("確認依頼の前に対応内容を入力してください。");
  return { ...issue, status: target, history: [...issue.history, { label: statusLabels[target], at }] };
}
export function validateIssue(input: Pick<Issue, "title" | "location" | "assignee" | "dueDate" | "description">): string | null {
  if (!input.title.trim() || input.title.trim().length > 80) return "件名は1〜80文字で入力してください。";
  if (!input.location.trim() || input.location.trim().length > 100) return "場所は1〜100文字で入力してください。";
  if (!members.includes(input.assignee)) return "担当者を選んでください。";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) return "期限を入力してください。";
  const date = new Date(`${input.dueDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input.dueDate) return "有効な日付を入力してください。";
  if (input.description.length > 2000) return "詳細は2000文字以内で入力してください。";
  return null;
}
export function todayInTokyo(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export function isOverdue(issue: Issue, today: string): boolean { return issue.status !== "done" && issue.dueDate < today; }
export function completionRate(issues: Issue[]): number { return issues.length ? Math.round(issues.filter(i => i.status === "done").length / issues.length * 100) : 0; }
