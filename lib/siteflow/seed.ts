import type { Issue, Project } from "./domain";
export const projects: Project[] = [
  { id: "p1", code: "PRJ-001", name: "青葉橋 定期点検", location: "東京都・青葉地区", dueDate: "2026-10-15", owner: "山田 太郎" },
  { id: "p2", code: "PRJ-002", name: "中央通り 道路現況調査", location: "東京都・中央地区", dueDate: "2026-10-23", owner: "佐藤 花" },
  { id: "p3", code: "PRJ-003", name: "東地区 排水施設調査", location: "東京都・東地区", dueDate: "2026-11-06", owner: "田中 健" },
];
// 架空のサンプル。実在の顧客・現場情報ではない。
export const seedIssues: Issue[] = [
  { id: "SF-001", projectId: "p1", title: "橋脚Aのひび割れを再確認", location: "橋脚A・南側", assignee: "山田 太郎", dueDate: "2026-09-29", priority: "high", description: "前回の点検記録と比較し、ひび割れの幅と範囲を確認してください。", status: "open", response: "", history: [{ label: "登録", at: "2026-09-25T09:00:00+09:00" }] },
  { id: "SF-002", projectId: "p1", title: "伸縮装置の追加調査", location: "橋面・東側", assignee: "佐藤 花", dueDate: "2026-10-02", priority: "normal", description: "伸縮装置周辺の状態を追加で確認してください。", status: "in_progress", response: "現地での追加調査を実施中。", history: [{ label: "登録", at: "2026-09-26T09:00:00+09:00" }] },
  { id: "SF-003", projectId: "p1", title: "排水口の堆積状況を確認", location: "橋面・西側", assignee: "田中 健", dueDate: "2026-10-03", priority: "normal", description: "排水口の堆積状況と通水状況を確認してください。", status: "review", response: "堆積状況を確認し、調査記録に追記しました。内容の確認をお願いします。", history: [{ label: "登録", at: "2026-09-26T09:00:00+09:00" }, { label: "確認待ち", at: "2026-09-28T14:30:00+09:00" }] },
  { id: "SF-004", projectId: "p1", title: "高欄の腐食箇所を記録", location: "高欄・北側", assignee: "山田 太郎", dueDate: "2026-09-28", priority: "normal", description: "腐食箇所の位置と範囲を記録してください。", status: "done", response: "位置・範囲を調査記録に反映し、確認済み。", history: [{ label: "登録", at: "2026-09-24T09:00:00+09:00" }, { label: "完了", at: "2026-09-28T10:00:00+09:00" }] },
  { id: "SF-005", projectId: "p2", title: "側溝の破損箇所を確認", location: "中央通り・第2区間", assignee: "佐藤 花", dueDate: "2026-10-05", priority: "high", description: "側溝の破損範囲を測定してください。", status: "open", response: "", history: [{ label: "登録", at: "2026-09-28T09:00:00+09:00" }] },
  { id: "SF-006", projectId: "p2", title: "路面標示の摩耗を記録", location: "中央通り・交差点", assignee: "田中 健", dueDate: "2026-10-07", priority: "normal", description: "路面標示の摩耗状況を記録してください。", status: "done", response: "記録と確認が完了。", history: [{ label: "完了", at: "2026-09-29T10:00:00+09:00" }] },
];
