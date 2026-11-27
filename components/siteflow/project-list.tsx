'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { parseProjectSearchQuery, projectSearchKeys, withoutKnownTrackingParameters } from '@/lib/siteflow/domain';
import styles from './connected-workspace.module.css';
import { ApiError, message, request, statusLabels as labels, type Page, type Resource } from './workspace-api';
import { ProjectDetail } from './project-detail';
import { ProjectCreate } from './project-create';
import { changeWorkspaceLocation, useWorkspaceLocation } from './workspace-location';

type Project = { id: string; name: string; code: string | null; dueDate: string; progress: number; status: string; primaryAssignee: { name: string } };
type Results = Page<Project> & { total: number; collectionTotal: number };
type Member = { userId: string; name: string };
type Draft = Record<(typeof projectSearchKeys)[number], string>;
const empty: Draft = { q: '', primaryUserId: '', supportUserId: '', status: '', progressMin: '', progressMax: '' };
function draftParams(draft: Draft) {
  const params = new URLSearchParams();
  for (const key of projectSearchKeys) if (draft[key].trim()) params.set(key, draft[key].trim());
  return params;
}

type ListProps = { teamId: string; signedOut: () => void; savingChanged: (busy: boolean) => void; archived: boolean };
export function ProjectList(props: ListProps) {
  const location = useWorkspaceLocation();
  const params = withoutKnownTrackingParameters(new URLSearchParams(location)); params.delete('team'); params.delete('view');
  const applied = params.toString();
  return <ProjectSearchList key={props.teamId + '/' + props.archived + '?' + applied} {...props} applied={applied} />;
}
function ProjectSearchList({ teamId, signedOut, savingChanged, archived, applied }: ListProps & { applied: string }) {
  const params = new URLSearchParams(applied);
  const valid = parseProjectSearchQuery(params) !== null && !params.has('cursor') && !params.has('limit');
  const collection = archived ? 'archived-projects' : 'projects';
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(projectSearchKeys.map(key => [key, params.get(key) ?? ''])) as Draft);

  const [queryError, setQueryError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false); const [notice, setNotice] = useState('');
  const [projects, setProjects] = useState<Resource<Results>>(valid ? { phase: 'loading' } : { phase: 'error', message: 'URLの検索条件が不正です。条件を確認するかリセットしてください。' });
  const [reload, setReload] = useState(0); const [busy, setBusy] = useState(false); const [moreError, setMoreError] = useState('');
  const [members, setMembers] = useState<Resource<Page<Member>>>({ phase: 'loading' });
  const [membersBusy, setMembersBusy] = useState(false); const [membersError, setMembersError] = useState('');
  const opener = useRef<HTMLButtonElement | null>(null); const listTitle = useRef<HTMLHeadingElement>(null);
  const callbacks = useRef({ signedOut, savingChanged });
  const generation = useRef(0); const moreController = useRef<AbortController | null>(null);
  const membersController = useRef<AbortController | null>(null); const membersGeneration = useRef(0);
  useEffect(() => { callbacks.current = { signedOut, savingChanged }; }, [signedOut, savingChanged]);
  useEffect(() => { if (selected === null && !creating) { if (opener.current?.isConnected) opener.current.focus(); else listTitle.current?.focus(); } }, [selected, creating]);
  useEffect(() => {
    const controller = new AbortController(); const ticket = ++generation.current;
    if (valid) request<Results>(`teams/${teamId}/${collection}${applied ? '?' + applied : ''}`, controller.signal).then(value => {
      if (!controller.signal.aborted && ticket === generation.current) setProjects({ phase: 'ready', value });
    }).catch(error => { if (!controller.signal.aborted && ticket === generation.current) { if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut(); else setProjects({ phase: 'error', message: message(error) }); } });
    const more = moreController;
    return () => { controller.abort(); more.current?.abort(); generation.current = ticket + 1; };
  }, [teamId, collection, applied, valid, reload]);
  useEffect(() => {
    const controller = new AbortController(); membersController.current = controller; const ticket = ++membersGeneration.current;
    request<Page<Member>>(`teams/${teamId}/members`, controller.signal).then(value => { if (!controller.signal.aborted && ticket === membersGeneration.current) setMembers({ phase: 'ready', value }); })
      .catch(error => { if (!controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut(); else setMembers({ phase: 'error', message: message(error) }); } });
    return () => { controller.abort(); membersController.current?.abort(); membersGeneration.current = ticket + 1; };
  }, [teamId]);
  async function loadMembers() {
    if (membersBusy) return;
    const previous = members.phase === 'ready' ? members.value : null;
    if (previous && !previous.page.nextCursor) return;
    const ticket = ++membersGeneration.current; const controller = new AbortController(); membersController.current = controller;
    setMembersBusy(true); setMembersError('');
    try {
      const next = await request<Page<Member>>(`teams/${teamId}/members${previous ? '?cursor=' + encodeURIComponent(previous.page.nextCursor!) : ''}`, controller.signal);
      if (!controller.signal.aborted && ticket === membersGeneration.current) setMembers({ phase: 'ready', value: { ...next, items: [...(previous?.items ?? []), ...next.items] } });
    } catch (error) { if (!controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut(); else setMembersError(message(error)); } }
    finally { if (!controller.signal.aborted) setMembersBusy(false); }
  }
  async function more() {
    if (busy || projects.phase !== 'ready' || !projects.value.page.nextCursor) return;
    const previous = projects.value; const ticket = generation.current;
    const controller = new AbortController(); moreController.current?.abort(); moreController.current = controller; setBusy(true); setMoreError('');
    const query = new URLSearchParams(applied); query.set('cursor', previous.page.nextCursor!);
    try {
      const next = await request<Results>(`teams/${teamId}/${collection}?${query}`, controller.signal);
      if (!controller.signal.aborted && ticket === generation.current) setProjects({ phase: 'ready', value: { ...next, items: [...previous.items, ...next.items.filter(item => !previous.items.some(old => old.id === item.id))] } });
    } catch (error) { if (!controller.signal.aborted && ticket === generation.current) { if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut(); else setMoreError(message(error)); } }
    finally { if (!controller.signal.aborted && ticket === generation.current) setBusy(false); }
  }
  function apply(event?: FormEvent) {
    event?.preventDefault(); const query = draftParams(draft);
    if (!parseProjectSearchQuery(query)) { setQueryError('キーワードは100文字以内、進捗は0〜100の整数で最小≦最大にしてください。担当者・状態も確認してください。'); return; }
    query.set('team', teamId); query.set('view', archived ? 'archived' : 'projects');
    setSelected(null); setCreating(false); setQueryError(''); changeWorkspaceLocation(query); setProjects({ phase: 'loading' }); setMoreError(''); setReload(n => n + 1);
  }
  function reset() { setDraft(empty); setQueryError(''); changeWorkspaceLocation(new URLSearchParams({ team: teamId, view: archived ? 'archived' : 'projects' })); setReload(n => n + 1); }
  function changed() { setNotice('保存を確認しました。'); setReload(n => n + 1); }
  const current = projects.phase === 'ready' ? projects.value : null;
  const memberOptions = (value: string) => <><option value="">すべて</option>{value && (members.phase !== 'ready' || !members.value.items.some(m => m.userId === value)) && <option value={value}>指定済みの担当者（候補取得中・現在所属外の場合あり）</option>}{members.phase === 'ready' && members.value.items.map(m => <option key={m.userId} value={m.userId}>{m.name}</option>)}</>;
  return <>{notice && <p role="status" className={styles.success}>{notice}</p>}<section hidden={selected !== null || creating} className={styles.projectPanel} aria-labelledby="projects-title">
    <div className={styles.panelHeading}><div><p className={styles.eyebrow}>{archived ? 'ARCHIVED PROJECTS' : 'PROJECTS'}</p><h2 id="projects-title" ref={listTitle} tabIndex={-1}>{archived ? '保管一覧' : '案件一覧'}</h2></div><div className={styles.listActions}><span>納期が近い順</span>{!archived && <button className={styles.primary} onClick={e => { opener.current = e.currentTarget; setNotice(''); setCreating(true); }}>新しい案件を登録</button>}</div></div>
    <form className={styles.searchForm} onSubmit={apply} aria-label="案件の検索・絞り込み">
      <label htmlFor="project-keyword">案件名・案件番号<input id="project-keyword" type="search" maxLength={100} value={draft.q} onChange={e => setDraft({ ...draft, q: e.target.value })} placeholder="例：橋梁、LOCAL-001" /></label>
      <details className={styles.searchDetails}><summary>詳細条件{projectSearchKeys.slice(1).some(key => draft[key]) ? '（指定あり）' : ''}</summary><div className={styles.searchGrid}>
        <label htmlFor="search-primary">主担当<select id="search-primary" value={draft.primaryUserId} onChange={e => setDraft({ ...draft, primaryUserId: e.target.value })}>{memberOptions(draft.primaryUserId)}</select></label>
        <label htmlFor="search-support">副担当<select id="search-support" value={draft.supportUserId} onChange={e => setDraft({ ...draft, supportUserId: e.target.value })}>{memberOptions(draft.supportUserId)}</select></label>
        <label htmlFor="search-status">状態<select id="search-status" value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value })}><option value="">すべて</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <fieldset className={styles.searchProgress}><legend>進捗率（％）</legend><label htmlFor="search-min">最小<input id="search-min" type="number" min="0" max="100" step="1" value={draft.progressMin} onChange={e => setDraft({ ...draft, progressMin: e.target.value })} /></label><span>〜</span><label htmlFor="search-max">最大<input id="search-max" type="number" min="0" max="100" step="1" value={draft.progressMax} onChange={e => setDraft({ ...draft, progressMax: e.target.value })} /></label></fieldset>
      </div>{members.phase === 'loading' && <p role="status">担当者候補を取得しています…</p>}{members.phase === 'error' && <p role="alert">担当者候補を取得できませんでした。</p>}{membersError && <p role="alert">{membersError}</p>}{(members.phase === 'error' || members.phase === 'ready' && members.value.page.hasMore) && <button type="button" disabled={membersBusy} onClick={() => void loadMembers()}>{membersBusy ? '取得中…' : members.phase === 'error' ? '担当者候補を再取得' : '担当者候補をさらに表示'}</button>}</details>
      {queryError && <p role="alert" className={styles.error}>{queryError}</p>}<div className={styles.relatedButtons}><button className={styles.primary} type="submit">検索</button><button type="button" onClick={reset}>条件をリセット</button></div>
      <p className={styles.help}>適用中：{applied ? projectSearchKeys.filter(key => params.has(key)).map(key => key === 'q' ? `キーワード「${params.get(key)}」` : key === 'status' ? `状態：${labels[params.get(key)!] ?? '不正な値'}` : key === 'progressMin' ? `最小${params.get(key)}％` : key === 'progressMax' ? `最大${params.get(key)}％` : key === 'primaryUserId' ? '主担当指定' : '副担当指定').join('・') : '条件なし'}。入力後に「検索」で反映します。</p>
    </form>
    {!current && projects.phase !== 'error' && <p className={styles.feedback} role="status">案件を読み込んでいます…</p>}
    {projects.phase === 'error' && <div className={styles.feedback}><p role="alert" className={styles.error}>{projects.message}</p><button onClick={() => setReload(n => n + 1)}>案件を再取得する</button></div>}
    {current && <><p className={styles.searchCount} role="status">検索結果 {current.total}件・{current.items.length}件表示中</p>{!current.items.length ? <div className={styles.feedback}><h3>{current.collectionTotal === 0 ? archived ? '保管した案件はまだありません' : 'このチームの案件はまだありません' : '条件に一致する案件はありません'}</h3><p>{current.collectionTotal === 0 ? archived ? '通常の案件の詳細からアーカイブできます。' : '「新しい案件を登録」から追加できます。' : 'キーワードや条件を変更するか、条件をリセットしてください。'}</p></div> : <><ul className={styles.projects}>{current.items.map(project => <li key={project.id} data-project-id={project.id}><div><p className={styles.code}>{project.code ?? '番号未設定'}</p><h3><button className={styles.projectOpen} onClick={e => { opener.current = e.currentTarget; setSelected(project.id); }} aria-label={`${project.name}の詳細を開く`}>{project.name}<span aria-hidden="true"> →</span></button></h3><p className={styles.meta}>主担当：{project.primaryAssignee.name}<span>納期：<time dateTime={project.dueDate}>{project.dueDate.replaceAll('-', '/')}</time></span></p></div><div className={styles.progress}><span>{labels[project.status] ?? project.status}</span><p><strong>{project.progress}</strong>％</p><progress value={project.progress} max={100} aria-label={`${project.name}の進捗`} /></div></li>)}</ul><div className={styles.listFooter}><p>{current.items.length}件表示中{current.page.hasMore ? ' · 続きがあります' : ''}</p>{current.page.hasMore && <button onClick={more} disabled={busy}>{busy ? '読み込み中…' : '続きを読み込む'}</button>}{moreError && <p role="alert" className={styles.error}>{moreError}</p>}</div></>}</>}
  </section>{creating && <ProjectCreate teamId={teamId} signedOut={signedOut} savingChanged={savingChanged} cancel={() => setCreating(false)} created={id => { setCreating(false); setSelected(id); setNotice('案件を登録しました。'); setReload(n => n + 1); }} />}{selected && <ProjectDetail key={selected} archived={archived} teamId={teamId} projectId={selected} signedOut={signedOut} savingChanged={savingChanged} changed={changed} moved={action => { setSelected(null); setNotice(action === 'archive' ? 'アーカイブしました。' : '復元しました。'); setReload(n => n + 1); }} close={() => setSelected(null)} />}</>;
}
