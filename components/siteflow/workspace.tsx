"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Building2, MapPin, Plus, ClipboardList, CalendarDays, CheckCheck, CircleAlert, ChevronRight, HardHat, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { availableTransitions, changeStatus, completionRate, isOverdue, members, statuses, statusLabels, todayInTokyo, validateIssue, type Issue, type Status } from "@/lib/siteflow/domain";
import { projects, seedIssues } from "@/lib/siteflow/seed";

const transitionLabels: Record<Status, string> = { open: "未対応", in_progress: "対応を開始", review: "確認を依頼", done: "承認して完了" };
function StatusBadge({ status }: { status: Status }) { return <span className={`status status-${status}`}>{statusLabels[status]}</span>; }
function Choice({ value, onChange, label, options }: { value: string; onChange: (v: string) => void; label: string; options: { value: string; label: string }[] }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="choice"><SelectValue /></SelectTrigger><SelectContent>{options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>;
}

export function Workspace() {
  const [issues, setIssues] = useState<Issue[]>(seedIssues);
  const [projectId, setProjectId] = useState("p1");
  const [view, setView] = useState("issues");
  const [filter, setFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [response, setResponse] = useState("");
  const [error, setError] = useState("");
  const [today, setToday] = useState("");
  const [draft, setDraft] = useState({ title: "", location: "", assignee: members[0], dueDate: "", priority: "normal", description: "" });
  useEffect(() => { setToday(todayInTokyo()); }, []);
  const project = projects.find(p => p.id === projectId)!;
  const projectIssues = issues.filter(i => i.projectId === projectId);
  const visible = projectIssues.filter(i => filter === "all" || (filter === "overdue" ? isOverdue(i, today) : i.status === filter));
  const selected = issues.find(i => i.id === selectedId);
  const overdue = projectIssues.filter(i => isOverdue(i, today)).length;
  const done = projectIssues.filter(i => i.status === "done").length;
  const review = projectIssues.filter(i => i.status === "review").length;

  function openIssue(issue: Issue) { setSelectedId(issue.id); setResponse(issue.response); setError(""); }
  function createIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { ...draft, dueDate: String(new FormData(event.currentTarget).get("dueDate") ?? "") };
    const message = validateIssue(input);
    if (message) { setError(message); return; }
    const issue: Issue = { ...input, title: draft.title.trim(), location: draft.location.trim(), priority: draft.priority === "high" ? "high" : "normal", id: `SF-${String(Math.max(0, ...issues.map(i => Number(i.id.slice(3)))) + 1).padStart(3, "0")}`, projectId, status: "open", response: "", history: [{ label: "登録", at: new Date().toISOString() }] };
    setIssues(current => [...current, issue]); setCreating(false); setFilter("all");
    setDraft({ title: "", location: "", assignee: members[0], dueDate: "", priority: "normal", description: "" });
    toast.success("指摘事項を登録しました");
  }
  function transition(target: Status) {
    if (!selected) return;
    if (response.length > 2000) { setError("対応内容は2000文字以内で入力してください。"); return; }
    try {
      const updated = changeStatus({ ...selected, response: response.trim() }, target, new Date().toISOString());
      setIssues(current => current.map(i => i.id === updated.id ? updated : i)); setError("");
      toast.success(target === "in_progress" && selected.status === "review" ? "対応中に差し戻しました" : `${statusLabels[target]}に変更しました`);
    } catch (e) { setError(e instanceof Error ? e.message : "変更に失敗しました。"); }
  }
  // 未対応ブラウザでは何もしない。状態参照用のツールだけを公開する。
  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: object, options: { signal: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context) return;
    const lifecycle = new AbortController();
    try { void Promise.resolve(context.registerTool({ name: "list_siteflow_issues", description: "現在のデモ画面の指摘事項を読む。データは変更しない。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute(input: unknown) { if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new Error("空のオブジェクトを指定してください。"); return issues.map(({ id, projectId, title, status }) => ({ id, projectId, title, status })); } }, { signal: lifecycle.signal })).catch(() => {}); } catch { /* 通常の画面操作には影響させない。 */ }
    return () => lifecycle.abort();
  }, [issues]);

  return <div className="workspace">
    <a href="#main" className="skip-link">本文へ移動</a>
    <header className="topbar"><div className="brand"><span className="brand-icon"><HardHat size={23} /></span>SiteFlow<span className="brand-caption">FIELD OPERATIONS</span></div><div className="topbar-right"><span className="demo-pill">デモワークスペース</span><span className="avatar">山</span></div></header>
    <main id="main" className="main-shell">
      <div className="page-heading"><div><p className="eyebrow">PROJECT WORKSPACE</p><h1>プロジェクト管理</h1><p className="subtitle">現場の気づきを、確実な対応へ。</p></div><div className="workspace-name"><Building2 size={18} /> 青葉調査チーム</div></div>
      <Tabs value={view} onValueChange={setView} className="workspace-tabs"><TabsList variant="line" className="workspace-tab-list"><TabsTrigger value="issues"><ClipboardList size={17} />案件の指摘事項</TabsTrigger><TabsTrigger value="projects"><Building2 size={17} />プロジェクト一覧</TabsTrigger></TabsList>
        <TabsContent value="issues">
          <section className="project-overview" aria-label="選択中のプロジェクト"><div><div className="project-code">{project.code}<span>進行中</span></div><h2>{project.name}</h2><div className="project-meta"><span><MapPin size={15} />{project.location}</span><span><CalendarDays size={15} />案件期限 {project.dueDate}</span><span><UserRound size={15} />{project.owner}</span></div></div><div className="project-picker"><label>プロジェクト切替</label><Choice label="プロジェクト切替" value={projectId} onChange={v => { setProjectId(v); setFilter("all"); }} options={projects.map(p => ({ value: p.id, label: p.name }))} /></div></section>
          <section className="metrics" aria-label="案件の状況"><article className="metric"><span>指摘事項</span><strong>{projectIssues.length}<small>件</small></strong><ClipboardList className="metric-icon" /></article><article className="metric"><span>期限超過</span><strong className={overdue ? "danger-text" : ""}>{overdue}<small>件</small></strong><CircleAlert className="metric-icon" /></article><article className="metric"><span>確認待ち</span><strong>{review}<small>件</small></strong><CheckCheck className="metric-icon" /></article><article className="metric progress-metric"><div><span>完了率</span><strong>{completionRate(projectIssues)}<small>%</small></strong></div><Progress value={completionRate(projectIssues)} aria-label="指摘事項の完了率" /><p>{done} / {projectIssues.length} 件が完了</p></article></section>
          <section className="issue-panel"><div className="panel-heading"><div><h2>指摘事項<span>{projectIssues.length}</span></h2><p>担当・期限・対応状況をまとめて確認</p></div><Button onClick={() => { setError(""); setCreating(true); }} className="primary-button"><Plus size={17} />指摘を登録</Button></div>
            <div className="filter-bar"><Choice label="状態で絞り込み" value={filter} onChange={setFilter} options={[{ value: "all", label: "すべての状態" }, ...statuses.map(s => ({ value: s, label: statusLabels[s] })), { value: "overdue", label: "期限超過" }]} /><span>{visible.length} 件を表示</span></div>
            <div className="issue-list">{visible.map(issue => <button key={issue.id} className="issue-row" onClick={() => openIssue(issue)} aria-label={`${issue.id} ${issue.title}の詳細`}><div className="issue-main"><div className="issue-heading"><span className="issue-id">{issue.id}</span>{issue.priority === "high" && <span className="priority">優先</span>}</div><h3>{issue.title}</h3><p><MapPin size={14} />{issue.location}</p></div><div className="issue-assignee"><span className="member-avatar">{issue.assignee[0]}</span>{issue.assignee}</div><div className={`issue-due ${isOverdue(issue, today) ? "danger-text" : ""}`}><CalendarDays size={14} />{issue.dueDate}{isOverdue(issue, today) && <small>期限超過</small>}</div><StatusBadge status={issue.status} /><ChevronRight size={18} className="row-chevron" /></button>)}{!visible.length && <div className="empty-state"><ClipboardList size={32} /><h3>{projectIssues.length ? "該当する指摘事項はありません" : "まだ指摘事項がありません"}</h3><p>{projectIssues.length ? "別の状態を選ぶと、他の指摘を確認できます。" : "現場で見つけた内容を「指摘を登録」から追加してください。"}</p></div>}</div>
          </section>
        </TabsContent>
        <TabsContent value="projects"><div className="project-grid">{projects.map(p => { const items = issues.filter(i => i.projectId === p.id); return <button className="project-card" key={p.id} onClick={() => { setProjectId(p.id); setFilter("all"); setView("issues"); }}><div className="project-code">{p.code}<Building2 size={20} /></div><h2>{p.name}</h2><p><MapPin size={15} />{p.location}</p><div className="project-card-count">指摘 {items.length}件<span>完了 {completionRate(items)}%</span></div><Progress value={completionRate(items)} aria-label={`${p.name}の完了率`} /><div className="project-card-footer">期限 {p.dueDate}<ChevronRight size={17} /></div></button>; })}</div></TabsContent>
      </Tabs>
      <footer className="workspace-footer"><span>学習用デモ · すべて架空の案件です</span><span>操作内容は再読み込みでリセットされます</span></footer>
    </main>

    <Dialog open={creating} onOpenChange={v => { setCreating(v); setError(""); }}><DialogContent className="issue-dialog" showCloseButton={false}><DialogHeader><DialogTitle>指摘事項を登録</DialogTitle><DialogDescription>{project.name}に新しい指摘を追加します。</DialogDescription></DialogHeader><form onSubmit={createIssue} className="issue-form"><label>件名 <span>必須</span><input required maxLength={80} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="例：橋脚Aのひび割れを再確認" /></label><label>場所 <span>必須</span><input required maxLength={100} value={draft.location} onChange={e => setDraft({ ...draft, location: e.target.value })} placeholder="例：橋脚A・南側" /></label><div className="form-grid"><div className="form-field"><label>担当者</label><Choice label="担当者" value={draft.assignee} onChange={v => setDraft({ ...draft, assignee: v })} options={members.map(m => ({ value: m, label: m }))} /></div><label>対応期限 <span>必須</span><input type="date" name="dueDate" required value={draft.dueDate} onChange={e => setDraft({ ...draft, dueDate: e.target.value })} /></label></div><div className="form-field"><label>優先度</label><Choice label="優先度" value={draft.priority} onChange={v => setDraft({ ...draft, priority: v })} options={[{ value: "normal", label: "通常" }, { value: "high", label: "優先" }]} /></div><label>詳細<textarea maxLength={2000} rows={3} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="調査・対応してほしい内容" /></label>{error && <p role="alert" className="form-error">{error}</p>}<div className="form-actions"><Button type="button" variant="outline" onClick={() => setCreating(false)}>キャンセル</Button><Button type="submit" className="primary-button">登録する</Button></div></form></DialogContent></Dialog>

    <Sheet open={!!selected} onOpenChange={v => { if (!v) setSelectedId(null); }}><SheetContent className="issue-sheet" showCloseButton={false}>{selected && <><SheetHeader><div className="sheet-top"><span className="issue-id">{selected.id}</span><Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>閉じる</Button></div><SheetTitle>{selected.title}</SheetTitle><SheetDescription>{projects.find(p => p.id === selected.projectId)?.name}</SheetDescription></SheetHeader><div className="sheet-body"><StatusBadge status={selected.status} /><dl className="detail-grid"><div><dt>場所</dt><dd>{selected.location}</dd></div><div><dt>担当者</dt><dd>{selected.assignee}</dd></div><div><dt>期限</dt><dd>{selected.dueDate}</dd></div><div><dt>優先度</dt><dd>{selected.priority === "high" ? "優先" : "通常"}</dd></div></dl><section><h3>指摘内容</h3><p className="detail-description">{selected.description || "詳細の記入はありません。"}</p></section><label className="response-label">対応内容<textarea rows={5} maxLength={2000} readOnly={selected.status === "done"} value={response} onChange={e => setResponse(e.target.value)} placeholder="実施した調査・対応内容を入力" /></label>{selected.status === "in_progress" && <p className="field-help">確認を依頼するには、対応内容が必要です。</p>}{error && <p role="alert" className="form-error">{error}</p>}<div className="transition-actions">{availableTransitions(selected.status).map(target => <Button key={target} variant={target === "in_progress" && selected.status === "review" ? "outline" : "default"} onClick={() => transition(target)}>{target === "in_progress" && selected.status === "review" ? "差し戻す" : transitionLabels[target]}</Button>)}{selected.status !== "done" && <Button variant="outline" onClick={() => { if (response.length > 2000) return; setIssues(current => current.map(i => i.id === selected.id ? { ...i, response: response.trim() } : i)); toast.success("対応内容を更新しました"); }}>対応内容を更新</Button>}</div>{selected.status === "done" && <p className="completed-note"><CheckCheck size={18} />対応・確認が完了しています。</p>}<section className="history"><h3>状態の履歴</h3><ol>{selected.history.map((h, index) => <li key={index}><span>{h.label}</span><time>{new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(h.at))}</time></li>)}</ol></section><p className="field-help">デモでは同じ利用者が対応と承認を試せます。</p></div></>}</SheetContent></Sheet>
    <Toaster position="bottom-right" />
  </div>;
}
