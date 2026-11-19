'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { parseProjectArchiveInput, availableProjectStatusTargets, parseChangeProjectStatusInput, planProjectStatusChange, parseChangeProjectAssigneesInput, parseEditProjectInput, parseUpdateProjectProgressInput, type ProjectBasicFields, type ProjectStatus } from '@/lib/siteflow/domain';
import { ApiError, message, request, statusLabels, type Page, type Resource } from './workspace-api';
import styles from './connected-workspace.module.css';

export type EditMode = 'basic' | 'assignees' | 'progress' | 'status' | 'archive' | 'restore';
type Person = { userId: string; name: string; isCurrentMember?: boolean };
type Project = ProjectBasicFields & { id: string; version: number; progress: number; status: ProjectStatus; primaryAssignee: Person; archivedAt?: string | null };
type Snapshot = { project: Project; supports: Person[] };
const titles: Record<EditMode, string> = { basic: '基本情報を編集', assignees: '担当者を変更', progress: '進捗を更新', status: '状態変更・完了・再開', archive: '案件をアーカイブ', restore: '担当を確認して復元' };
const fieldLabels = { name: '案件名', dueDate: '納期', code: '案件番号', clientName: '取引先', summary: '概要', notes: '備考' };
const limits = { name: 200, code: 100, clientName: 200, summary: 2000, notes: 2000 };

async function readSnapshot(path: string, mode: EditMode, signal: AbortSignal): Promise<Snapshot> {
  const { project } = await request<{ project: Project }>(path, signal);
  const supports: Person[] = [];
  if (mode === 'assignees' || mode === 'restore') {
    let cursor: string | null = null;
    do {
      const page: Page<Person> = await request(path + '/support-members' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), signal);
      supports.push(...page.items); cursor = page.page.hasMore ? page.page.nextCursor : null;
    } while (cursor);
  }
  return { project, supports };
}

export function ProjectEditor({ teamId, projectId, mode, signedOut, saved, cancel, savingChanged }: {
  teamId: string; projectId: string; mode: EditMode; signedOut: () => void; saved: () => void; cancel: () => void; savingChanged: (busy: boolean) => void;
}) {
  const [initial, setInitial] = useState<Resource<Snapshot>>({ phase: 'loading' });
  const [saving, setSaving] = useState(false); const heading = useRef<HTMLHeadingElement>(null);
  const updateSaving = useCallback((value: boolean) => { setSaving(value); savingChanged(value); }, [savingChanged]);
  useEffect(() => { heading.current?.focus(); }, [initial.phase]);
  const [reload, setReload] = useState(0); const onSignedOut = useRef(signedOut);
  useEffect(() => { onSignedOut.current = signedOut; }, [signedOut]);
  const path = `teams/${teamId}/${mode === 'restore' ? 'archived-projects' : 'projects'}/${projectId}`;
  useEffect(() => {
    const controller = new AbortController();
    readSnapshot(path, mode, controller.signal).then(value => { if (!controller.signal.aborted) setInitial({ phase: 'ready', value }); })
      .catch(error => { if (!controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) onSignedOut.current(); else setInitial({ phase: 'error', message: message(error) }); } });
    return () => controller.abort();
  }, [path, mode, reload]);
  return <section className={styles.projectPanel} aria-labelledby="editor-title" data-project-editor={mode}>
    <div className={styles.panelHeading}><h2 id="editor-title" ref={heading} tabIndex={-1}>{titles[mode]}</h2><button disabled={saving} onClick={cancel}>入力を破棄して戻る</button></div>
    {initial.phase === 'loading' && <p className={styles.feedback} role="status">編集前の情報を読み込んでいます…</p>}
    {initial.phase === 'error' && <div className={styles.feedback}><p role="alert" className={styles.error}>{initial.message}</p><button onClick={() => { setInitial({ phase: 'loading' }); setReload(value => value + 1); }}>編集情報を再取得する</button><button onClick={cancel}>詳細へ戻る</button></div>}
    {initial.phase === 'ready' && <EditorForm initial={initial.value} path={path} teamId={teamId} mode={mode} signedOut={signedOut} saved={saved} cancel={cancel} savingChanged={updateSaving} />}
  </section>;
}

function EditorForm({ initial, path, teamId, mode, signedOut, saved, cancel, savingChanged }: {
  initial: Snapshot; path: string; teamId: string; mode: EditMode; signedOut: () => void; saved: () => void; cancel: () => void; savingChanged: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => Object.fromEntries(Object.keys(fieldLabels).map(key => [key, initial.project[key as keyof ProjectBasicFields] ?? ''])) as Record<keyof ProjectBasicFields, string>);
  const [primary, setPrimary] = useState(initial.project.primaryAssignee.userId);
  const [supports, setSupports] = useState(initial.supports.map(person => person.userId));
  const [progress, setProgress] = useState(String(initial.project.progress)); const [comment, setComment] = useState('');
  const [version, setVersion] = useState(initial.project.version);
  const [status, setStatus] = useState<ProjectStatus | ''>('');
  const [reviewedProject, setReviewedProject] = useState(initial.project);
  const [members, setMembers] = useState<Resource<Page<Person>>>({ phase: 'loading' });
  const [memberReload, setMemberReload] = useState(0); const [memberBusy, setMemberBusy] = useState(false); const [memberError, setMemberError] = useState('');
  const [busy, setBusy] = useState(false); const posting = useRef(false); const active = useRef(true);
  const [error, setError] = useState(''); const [needsReview, setNeedsReview] = useState(false);
  const [latest, setLatest] = useState<Resource<Snapshot> | null>(null);
  const readController = useRef<AbortController | null>(null); const moreController = useRef<AbortController | null>(null);
  const callbacks = useRef({ signedOut, saved, savingChanged });
  useEffect(() => { callbacks.current = { signedOut, saved, savingChanged }; }, [signedOut, saved, savingChanged]);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; readController.current?.abort(); moreController.current?.abort(); }; }, []);
  useEffect(() => { if (error) alert.current?.focus(); }, [error]);
  useEffect(() => {
    if (mode !== 'assignees' && mode !== 'restore') return;
    const controller = new AbortController();
    request<Page<Person>>(`teams/${teamId}/members`, controller.signal).then(value => { if (!controller.signal.aborted) setMembers({ phase: 'ready', value }); })
      .catch(error => { if (!controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut(); else setMembers({ phase: 'error', message: message(error) }); } });
    return () => controller.abort();
  }, [mode, teamId, memberReload]);
  async function moreMembers() {
    if (memberBusy || members.phase !== 'ready' || !members.value.page.nextCursor) return;
    const before = members.value; const controller = new AbortController(); moreController.current = controller; setMemberBusy(true); setMemberError('');
    try {
      const next = await request<Page<Person>>(`teams/${teamId}/members?cursor=${encodeURIComponent(before.page.nextCursor!)}`, controller.signal);
      if (active.current && !controller.signal.aborted) setMembers({ phase: 'ready', value: { items: [...before.items, ...next.items], page: next.page } });
    } catch (error) { if (active.current && !controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut(); else setMemberError(message(error)); } }
    finally { if (active.current && !controller.signal.aborted) setMemberBusy(false); }
  }
  async function compareLatest() {
    readController.current?.abort(); const controller = new AbortController(); readController.current = controller; setLatest({ phase: 'loading' });
    try { const value = await readSnapshot(path, mode, controller.signal); if (active.current && !controller.signal.aborted) setLatest({ phase: 'ready', value }); }
    catch (error) { if (active.current && !controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut(); else setLatest({ phase: 'error', message: message(error) + (error instanceof ApiError && error.status === 404 && (mode === 'archive' || mode === 'restore') ? ' 一覧の対象が移動した可能性があります。通常の案件と保管一覧で結果を確認してください。' : '') }); } }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (posting.current || needsReview || latest?.phase === 'loading') return;
    setError(''); let body: object; let target = path.replace('/archived-projects/', '/projects/'); let method: 'POST' | 'PATCH' | 'PUT' = 'PATCH';
    if (mode === 'basic') {
      const changes = Object.fromEntries((Object.keys(fieldLabels) as (keyof ProjectBasicFields)[]).flatMap(key => {
        const value = key === 'name' || key === 'dueDate' ? draft[key].trim() : draft[key].trim() || null;
        return value === initial.project[key] ? [] : [[key, value]];
      }));
      const parsed = parseEditProjectInput({ expectedVersion: version, ...changes });
      if (!parsed) { setError('変更する項目を入力してください。名前は1〜200文字、納期は実在する日付、番号100文字・取引先200文字・概要と備考2000文字以内で、制御文字は使えません。'); return; }
      body = { expectedVersion: version, ...parsed.changes };
    } else if (mode === 'assignees') {
      const parsed = parseChangeProjectAssigneesInput({ expectedVersion: version, primaryUserId: primary, supportUserIds: supports });
      if (!parsed) { setError('主担当1人と、副担当50人以内を選んでください。主副担当は重複できません。'); return; }
      body = parsed; target += '/assignees'; method = 'PUT';
    } else if (mode === 'progress') {
      const parsed = parseUpdateProjectProgressInput({ expectedVersion: version, progress: progress === '' ? null : Number(progress), comment });
      if (!parsed) { setError('進捗は0〜100の整数、メモは2000文字以内で入力してください。'); return; }
      body = parsed; target += '/progress';
    } else if (mode === 'status') {
      const parsed = parseChangeProjectStatusInput({ expectedVersion: version, status, comment });
      if (!parsed) { setError('変更先を選び、メモ・再開理由は2000文字以内で入力してください。'); return; }
      const plan = planProjectStatusChange(reviewedProject, parsed);
      if (!plan.ok) {
        const explanations = { INVALID_STATUS_TRANSITION: 'この状態へは変更できません。現在の状態と変更先を確認してください。', PROGRESS_REQUIRED_FOR_COMPLETION: '完了には確認待ち・進捗100％が必要です。詳細へ戻って進捗を更新してください。', REOPEN_REASON_REQUIRED: '再開する理由を入力してください。空白だけでは保存できません。', COMMENT_WITHOUT_STATUS_CHANGE: '状態が同じままではメモだけを保存できません。最新の状態を確認してください。' };
        setError(explanations[plan.code]); return;
      }
      body = parsed; target += '/status';
    } else {
      const input = mode === 'archive' ? { expectedVersion: version } : { expectedVersion: version, primaryUserId: primary, supportUserIds: supports };
      if (!parseProjectArchiveInput(input, mode)) { setError('版と担当者を確認してください。主担当1人・副担当50人以内で、主副の重複はできません。'); return; }
      body = input; target += '/' + mode; method = 'POST';
    }
    posting.current = true; setBusy(true); callbacks.current.savingChanged(true);
    try { await request(target, undefined, body, method); if (active.current) callbacks.current.saved(); }
    catch (error) {
      if (!active.current) return;
      if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut();
      else {
        const review = !(error instanceof ApiError) || error.status === 409 || error.status >= 500;
        setNeedsReview(review); setLatest(null);
        setError(review ? message(error) + ' 入力は保持しています。最新の内容を確認し、比較してから保存し直してください。' : message(error));
      }
    } finally { posting.current = false; callbacks.current.savingChanged(false); if (active.current) setBusy(false); }
  }
  const candidates = new Map<string, Person>();
  const statusTargets = availableProjectStatusTargets(reviewedProject.status);
  for (const person of [initial.project.primaryAssignee, ...initial.supports, ...(members.phase === 'ready' ? members.value.items : [])]) candidates.set(person.userId, person);
  return <form aria-label={titles[mode]} className={styles.createForm} onSubmit={submit} aria-busy={busy}>
    <p className={styles.help}>管理者・現在の主担当・副担当が保存できます。チーム切替・画面移動では入力を破棄します。</p>
    {mode === 'basic' && <p className={styles.help}>編集開始時から変更した項目だけを保存します。変更しない項目は、他の人が保存した最新の値を保持します。</p>}
    {(mode === 'archive' || mode === 'restore') && <div className={styles.notice}><strong>{reviewedProject.name}</strong><p>状態：{statusLabels[reviewedProject.status]} · 進捗 {reviewedProject.progress}％</p>{mode === 'archive' ? <p>通常一覧から外して保管します。案件と履歴は削除せず、状態・進捗も変えません。</p> : <p>通常一覧へ戻します。担当者全員を確認し、必要なら選び直してください。状態と進捗は保持し、完了済みでも自動で再開しません。</p>}</div>}
    <fieldset disabled={busy} className={styles.createFields}><legend>{titles[mode]}</legend>
      {mode === 'basic' && (Object.keys(fieldLabels) as (keyof ProjectBasicFields)[]).map(key => <div className={styles.editField} key={key}><label htmlFor={`edit-${key}`}>{fieldLabels[key]}{key === 'name' || key === 'dueDate' ? '（必須）' : '（任意）'}</label>
        {key === 'summary' || key === 'notes' ? <textarea id={`edit-${key}`} rows={3} maxLength={limits[key]} value={draft[key]} onChange={e => setDraft(previous => ({ ...previous, [key]: e.target.value }))} />
          : <input id={`edit-${key}`} type={key === 'dueDate' ? 'date' : 'text'} required={key === 'name' || key === 'dueDate'} maxLength={key === 'dueDate' ? undefined : limits[key]} min={key === 'dueDate' ? '1000-01-01' : undefined} max={key === 'dueDate' ? '9999-12-31' : undefined} value={draft[key]} onChange={e => setDraft(previous => ({ ...previous, [key]: e.target.value }))} />}</div>)}
      {mode === 'progress' && <><label htmlFor="edit-progress">進捗（必須・0〜100の整数）</label><input id="edit-progress" type="number" min={0} max={100} step={1} required value={progress} onChange={e => setProgress(e.target.value)} /><label htmlFor="edit-comment">変更メモ（任意・2000文字以内）</label><textarea id="edit-comment" rows={3} maxLength={2000} value={comment} onChange={e => setComment(e.target.value)} /><p className={styles.help}>100％でも自動で完了にはなりません。メモだけを保存することはできません。</p></>}
      {mode === 'status' && <>
        <p className={styles.detailStatus}>確認した現在の状態：{statusLabels[reviewedProject.status]} · 進捗 {reviewedProject.progress}％</p>
        <p className={styles.help}>完了は「確認待ち・進捗100％」のときに選べます。進捗はこの操作では変更しません。</p>
        <label htmlFor="edit-status">変更先（必須）</label><select id="edit-status" required value={status} onChange={e => setStatus(e.target.value as ProjectStatus | '')}>
          <option value="">変更先を選択</option>
          {status && !statusTargets.includes(status) && <option value={status} disabled>選択中：{statusLabels[status]}（最新の状態を確認して選び直してください）</option>}
          {statusTargets.map(value => <option key={value} value={value} disabled={value === 'DONE' && reviewedProject.progress !== 100}>{statusLabels[value]}{value === 'DONE' && reviewedProject.progress !== 100 ? '（進捗100％が必要）' : ''}</option>)}
        </select>
        <label htmlFor="edit-status-comment">{reviewedProject.status === 'DONE' ? '再開理由（必須・2000文字以内）' : '変更メモ（任意・2000文字以内）'}</label>
        <textarea id="edit-status-comment" rows={3} maxLength={2000} required={reviewedProject.status === 'DONE'} value={comment} onChange={e => setComment(e.target.value)} />
        {status === 'DONE' && <p className={styles.notice}>保存すると案件が完了になります。進捗を再び変更するには、理由付きの再開が必要です。</p>}
        {reviewedProject.status === 'DONE' && <p className={styles.notice}>理由を記録して進行中へ戻します。進捗は保持します。元所属の担当がいる場合は、詳細へ戻って担当者を変更してから再開してください。</p>}
      </>}
      {(mode === 'assignees' || mode === 'restore') && <>
        {members.phase === 'loading' && <p role="status">担当候補を読み込んでいます…</p>}
        {members.phase === 'error' && <p role="alert" className={styles.error}>{members.message}</p>}
        {members.phase === 'ready' && members.value.items.length === 0 && <p>現在の担当候補がいません。所属を確認し、候補を再取得してください。</p>}
        <label htmlFor="edit-primary">主担当（必須）</label><select id="edit-primary" required value={primary} onChange={e => { const id = e.target.value; setPrimary(id); setSupports(previous => previous.filter(value => value !== id)); }}>{[...candidates.values()].map(person => <option key={person.userId} value={person.userId}>{person.name}{person.isCurrentMember === false ? '（現在は所属なし）' : ''}</option>)}</select>
        <fieldset className={styles.supportChoices}><legend>副担当（任意・最大50人）</legend><p className={styles.help}>旧主担当を副担当に残す場合はチェックしてください。現在は所属していない担当は解除するか、選び直してください。</p>{[...candidates.values()].filter(person => person.userId !== primary).map(person => <label key={person.userId}><input type="checkbox" value={person.userId} checked={supports.includes(person.userId)} disabled={person.isCurrentMember === false && !supports.includes(person.userId) || supports.length >= 50 && !supports.includes(person.userId)} onChange={e => setSupports(previous => e.target.checked ? [...previous, person.userId] : previous.filter(id => id !== person.userId))} />{person.name}{person.isCurrentMember === false ? '（現在は所属なし）' : ''}</label>)}</fieldset>
        {members.phase === 'ready' && members.value.page.hasMore && <button type="button" disabled={memberBusy} onClick={moreMembers}>{memberBusy ? '候補を読み込み中…' : '担当候補の続きを取得する'}</button>}
        {memberError && <p role="alert" className={styles.error}>{memberError}</p>}
        <button type="button" disabled={memberBusy} onClick={() => { setMembers({ phase: 'loading' }); setMemberError(''); setMemberReload(value => value + 1); }}>担当候補を再取得する</button>
      </>}
    </fieldset>
    {error && <p ref={alert} role="alert" tabIndex={-1} className={styles.error}>{error}</p>}
    {needsReview && <div className={styles.reviewPanel}><h3>保存前と最新の内容を比較</h3><p>あなたの入力はフォームに残っています。下の最新情報を読んでも、入力や保存する版は自動で変わりません。</p><button type="button" disabled={latest?.phase === 'loading'} onClick={compareLatest}>最新の内容を確認する</button>
      {latest?.phase === 'loading' && <p role="status">最新情報を読み込んでいます…</p>}
      {latest?.phase === 'error' && <p role="alert" className={styles.error}>{latest.message}</p>}
      {latest?.phase === 'ready' && <><dl className={styles.detailFields}><div><dt>版</dt><dd>保存しようとした版：{version} → 最新：{latest.value.project.version}</dd></div>
        {mode === 'basic' && (Object.keys(fieldLabels) as (keyof ProjectBasicFields)[]).map(key => <div key={key}><dt>{fieldLabels[key]}</dt><dd>編集開始時：{initial.project[key] ?? '未設定'}<br />最新：{latest.value.project[key] ?? '未設定'}<br />あなたの入力：{draft[key] || '未設定'}</dd></div>)}
        {(mode === 'assignees' || mode === 'restore') && <><div><dt>主担当</dt><dd>編集開始時：{initial.project.primaryAssignee.name}<br />最新：{latest.value.project.primaryAssignee.name}<br />あなたの選択：{candidates.get(primary)?.name}</dd></div><div><dt>副担当</dt><dd>編集開始時：{initial.supports.map(p => p.name).join('、') || 'なし'}<br />最新：{latest.value.supports.map(p => p.name).join('、') || 'なし'}<br />あなたの選択：{supports.map(id => candidates.get(id)?.name).join('、') || 'なし'}</dd></div></>}
        {(mode === 'archive' || mode === 'restore') && <div><dt>保管と内容</dt><dd>最新：{latest.value.project.name}<br />状態：{statusLabels[latest.value.project.status]}・進捗 {latest.value.project.progress}％<br />保管日時：{latest.value.project.archivedAt ?? '未保管'}</dd></div>}
        {mode === 'progress' && <div><dt>進捗・状態</dt><dd>編集開始時：{initial.project.progress}％<br />最新：{latest.value.project.progress}％・{statusLabels[latest.value.project.status]}<br />あなたの入力：{progress}％</dd></div>}
        {mode === 'status' && <><div><dt>状態・進捗</dt><dd>編集開始時：{statusLabels[initial.project.status]}・{initial.project.progress}％<br />最新：{statusLabels[latest.value.project.status]}・{latest.value.project.progress}％<br />あなたの変更先：{status ? statusLabels[status] : '未選択'}</dd></div><div><dt>入力したメモ・理由</dt><dd>{comment || 'なし'}</dd></div></>}
      </dl><button type="button" onClick={() => { setVersion(latest.value.project.version); setReviewedProject(latest.value.project); setNeedsReview(false); setLatest(null); setError(''); }}>比較しました。入力を保持して保存可能にする</button></>}
    </div>}
    <div className={styles.createActions}><button className={styles.primary} disabled={busy || needsReview || latest?.phase === 'loading' || (mode === 'assignees' || mode === 'restore') && (members.phase !== 'ready' || memberBusy)}>{busy ? '保存しています…' : mode === 'archive' ? 'アーカイブを確定する' : mode === 'restore' ? '担当を確認して復元する' : '変更を保存する'}</button><button type="button" disabled={busy} onClick={cancel}>入力を破棄して詳細へ戻る</button></div>
  </form>;
}
