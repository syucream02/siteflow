'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import styles from './connected-workspace.module.css';
import { ApiError, message, request, statusLabels as labels, type Page, type Resource } from './workspace-api';
import { ProjectDetail } from './project-detail';
import { ProjectCreate } from './project-create';
import { MeetingWorkspace } from './meeting-workspace';

type User = { id: string; name: string; email: string };
type Team = { id: string; name: string; role: 'admin' | 'member' };
type Project = { id: string; name: string; code: string | null; dueDate: string; progress: number; status: string; primaryAssignee: { name: string } };
// 画面内状態だけを管理。パスワードやセッションをブラウザー保存へ書き込まない。
export function ConnectedWorkspace({ connection = 'local' }: { connection?: 'local' | 'public' }) {
  const [session, setSession] = useState<Resource<User | null>>({ phase: 'loading' });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    request<{ user: User } | null>('auth/get-session', controller.signal)
      .then(data => setSession({ phase: 'ready', value: data?.user ?? null }))
      .catch(error => { if (!controller.signal.aborted) setSession({ phase: 'error', message: message(error) }); });
    return () => controller.abort();
  }, [reload]);
  const retry = () => { setSession({ phase: 'loading' }); setReload(value => value + 1); };
  return <div className={styles.shell}>
    <header className={styles.header}><Link href="/workspace" className={styles.brand}>SiteFlow<span>チームの仕事を、ひとつの場所に。</span></Link><Link href="/">指摘管理デモへ</Link></header>
    <main className={styles.main}>
      <p className={styles.eyebrow}>{connection === 'public' ? 'WORKSPACE PREVIEW' : 'LOCAL WORKSPACE'}</p><h1>案件ワークスペース</h1>
      <p className={styles.intro}>チームを選んで、保存されている案件を確認できます。</p>
      <p className={styles.notice}>{connection === 'public' ? '動作確認用のプレビュー · 架空のデータで操作をお試しください。' : 'ローカル接続版 · 案件の登録から完了・保管・復元まで利用できます。'}</p>
      {session.phase === 'loading' && <div className={styles.panel} role="status">ログイン状態を確認しています…</div>}
      {session.phase === 'error' && <div className={styles.panel}><p role="alert">{session.message}</p><button onClick={retry}>もう一度接続する</button></div>}
      {session.phase === 'ready' && (session.value
        ? <TeamWorkspace key={session.value.id} user={session.value} signedOut={() => setSession({ phase: 'ready', value: null })} />
        : <Login connection={connection} signedIn={user => setSession({ phase: 'ready', value: user })} />)}
    </main>
    <footer className={styles.footer}>SiteFlow · 架空のチーム・案件で試す学習用ポートフォリオ</footer>
  </div>;
}

function Login({ signedIn, connection }: { signedIn: (user: User) => void; connection: 'local' | 'public' }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      await request('auth/sign-in/email', undefined, { email: email.trim(), password });
      const data = await request<{ user: User } | null>('auth/get-session');
      if (!data?.user) throw new Error('ログインを確認できませんでした。もう一度お試しください。');
      setPassword(''); signedIn(data.user);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  return <section className={styles.login} aria-labelledby="login-title"><div><p className={styles.eyebrow}>WELCOME BACK</p><h2 id="login-title">ログインして始める</h2><p>あなたが所属するチームの案件を表示します。</p><p className={styles.help}>{connection === 'public' ? '案内されたプレビュー用アカウントでログインしてください。新規登録・招待は準備中です。' : '現在は準備済みのローカル用アカウントを使います。新規登録・招待は準備中です。'}</p></div>
    <form onSubmit={submit} aria-busy={busy}>
      <label htmlFor="login-email">メールアドレス</label><input id="login-email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={busy} />
      <label htmlFor="login-password">パスワード</label><input id="login-password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} />
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button className={styles.primary} disabled={busy}>{busy ? 'ログインしています…' : 'ログイン'}</button>
      <p className={styles.help}>失敗しても入力は残ります。パスワードはこの画面を離れると消えます。</p>
    </form></section>;
}

function TeamWorkspace({ user, signedOut }: { user: User; signedOut: () => void }) {
  const [saving, setSaving] = useState(false);
  const [teams, setTeams] = useState<Resource<Page<Team>>>({ phase: 'loading' });
  const [teamId, setTeamId] = useState(''); const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [moreError, setMoreError] = useState(''); const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const failure = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) signedOut();
    else setTeams({ phase: 'error', message: message(error) });
  }, [signedOut]);
  // signedOutをeffectの依存にしないよう、この画面にいる間の呼び出し先を保持する。
  const onFailure = useRef(failure); useEffect(() => { onFailure.current = failure; }, [failure]);
  useEffect(() => {
    const controller = new AbortController();
    request<Page<Team>>('teams', controller.signal).then(page => {
      if (controller.signal.aborted) return; setTeams({ phase: 'ready', value: page }); setTeamId(page.items[0]?.id ?? '');
    }).catch(error => { if (!controller.signal.aborted) onFailure.current(error); });
    return () => controller.abort();
  }, [reload]);
  async function moreTeams() {
    if (busy || teams.phase !== 'ready' || !teams.value.page.nextCursor) return;
    const previous = teams.value; setBusy(true); setMoreError('');
    try { const next = await request<Page<Team>>('teams?cursor=' + encodeURIComponent(previous.page.nextCursor!)); if (active.current) setTeams({ phase: 'ready', value: { items: [...previous.items, ...next.items], page: next.page } }); }
    catch (error) { if (active.current) { if (error instanceof ApiError && error.status === 401) signedOut(); else setMoreError(message(error)); } }
    finally { if (active.current) setBusy(false); }
  }
  async function logout() {
    if (busy) return; setBusy(true); setError('');
    try { await request('auth/sign-out', undefined, {}); signedOut(); }
    catch (error) { setError(message(error)); setBusy(false); }
  }
  return <>
    <div className={styles.account}><p><strong>{user.name}</strong><span>ログイン中</span></p><button onClick={logout} disabled={busy || saving}>ログアウト</button></div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {teams.phase === 'loading' && <div className={styles.panel} role="status">所属チームを読み込んでいます…</div>}
    {teams.phase === 'error' && <div className={styles.panel}><p role="alert">{teams.message}</p><button onClick={() => { setTeams({ phase: 'loading' }); setTeamId(''); setReload(n => n + 1); }}>チームを再取得する</button></div>}
    {teams.phase === 'ready' && (teams.value.items.length === 0
      ? <div className={styles.panel}><h2>所属チームはまだありません</h2><p>チーム作成・招待の画面は準備中です。</p></div>
      : <><section className={styles.teamPicker} aria-label="表示するチーム"><div><label htmlFor="team-select">チーム</label><select id="team-select" disabled={saving} value={teamId} onChange={e => setTeamId(e.target.value)}>{teams.value.items.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></div><p>{teams.value.items.find(t => t.id === teamId)?.role === 'admin' ? '管理者' : 'メンバー'}</p>{teams.value.page.hasMore && <button onClick={moreTeams} disabled={busy || saving}>ほかのチームを読み込む</button>}</section>
        {moreError && <p className={styles.error} role="alert">{moreError}</p>}
        <ProjectBrowser key={teamId} teamId={teamId} signedOut={signedOut} savingChanged={setSaving} />
      </>)}
  </>;
}

function ProjectBrowser({ teamId, signedOut, savingChanged }: { teamId: string; signedOut: () => void; savingChanged: (busy: boolean) => void }) {
  const [archived, setArchived] = useState(false); const [saving, setSaving] = useState(false);
  const [meeting, setMeeting] = useState(false);
  const updateSaving = useCallback((value: boolean) => { setSaving(value); savingChanged(value); }, [savingChanged]);
  return <><div className={styles.relatedButtons} role="group" aria-label="案件の一覧切替"><button aria-pressed={!archived && !meeting} disabled={saving} onClick={() => { setArchived(false); setMeeting(false); }}>通常の案件</button><button aria-pressed={archived && !meeting} disabled={saving} onClick={() => { setArchived(true); setMeeting(false); }}>保管一覧</button><button aria-pressed={meeting} disabled={saving} onClick={() => setMeeting(true)}>会議</button></div>
    {meeting ? <MeetingWorkspace teamId={teamId} signedOut={signedOut} savingChanged={updateSaving} /> : <ProjectList key={String(archived)} archived={archived} teamId={teamId} signedOut={signedOut} savingChanged={updateSaving} />}
  </>;
}

function ProjectList({ teamId, signedOut, savingChanged, archived }: { teamId: string; signedOut: () => void; savingChanged: (busy: boolean) => void; archived: boolean }) {
  const collection = archived ? 'archived-projects' : 'projects';
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false); const [notice, setNotice] = useState('');
  const opener = useRef<HTMLButtonElement | null>(null);
  const listTitle = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (selected === null && !creating) { if (opener.current?.isConnected) opener.current.focus(); else listTitle.current?.focus(); } }, [selected, creating]);
  const [projects, setProjects] = useState<Resource<Page<Project>>>({ phase: 'loading' });
  const [reload, setReload] = useState(0); const [busy, setBusy] = useState(false); const [moreError, setMoreError] = useState('');
  const active = useRef(true); const onSignedOut = useRef(signedOut);
  useEffect(() => { onSignedOut.current = signedOut; }, [signedOut]);
  useEffect(() => {
    const controller = new AbortController(); active.current = true;
    request<Page<Project>>(`teams/${teamId}/${collection}`, controller.signal).then(page => { if (!controller.signal.aborted) setProjects({ phase: 'ready', value: page }); })
      .catch(error => { if (!controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) onSignedOut.current(); else setProjects({ phase: 'error', message: message(error) }); } });
    return () => { active.current = false; controller.abort(); };
  }, [teamId, collection, reload]);
  async function more() {
    if (busy || projects.phase !== 'ready' || !projects.value.page.nextCursor) return;
    const previous = projects.value; setBusy(true); setMoreError('');
    try { const next = await request<Page<Project>>(`teams/${teamId}/${collection}?cursor=${encodeURIComponent(previous.page.nextCursor!)}`); if (active.current) setProjects({ phase: 'ready', value: { items: [...previous.items, ...next.items], page: next.page } }); }
    catch (error) { if (active.current) { if (error instanceof ApiError && error.status === 401) onSignedOut.current(); else setMoreError(message(error)); } }
    finally { if (active.current) setBusy(false); }
  }
  return <>{notice && <p role="status" className={styles.success}>{notice}</p>}<section hidden={selected !== null || creating} className={styles.projectPanel} aria-labelledby="projects-title"><div className={styles.panelHeading}><div><p className={styles.eyebrow}>{archived ? 'ARCHIVED PROJECTS' : 'PROJECTS'}</p><h2 id="projects-title" ref={listTitle} tabIndex={-1}>{archived ? '保管一覧' : '案件一覧'}</h2></div><div className={styles.listActions}><span>納期が近い順</span>{!archived && <button className={styles.primary} onClick={event => { opener.current = event.currentTarget; setNotice(''); setCreating(true); }}>新しい案件を登録</button>}</div></div>
    {projects.phase === 'loading' && <p className={styles.feedback} role="status">案件を読み込んでいます…</p>}
    {projects.phase === 'error' && <div className={styles.feedback}><p className={styles.error} role="alert">{projects.message}</p><button onClick={() => { setProjects({ phase: 'loading' }); setReload(n => n + 1); }}>案件を再取得する</button></div>}
    {projects.phase === 'ready' && (projects.value.items.length === 0
      ? <div className={styles.feedback}><h3>{archived ? '保管した案件はまだありません' : 'このチームの案件はまだありません'}</h3><p>{archived ? '通常の案件の詳細からアーカイブできます。' : '「新しい案件を登録」から追加できます。'}</p></div>
      : <><ul className={styles.projects}>{projects.value.items.map(project => <li key={project.id} data-project-id={project.id}><div><p className={styles.code}>{project.code ?? '番号未設定'}</p><h3><button className={styles.projectOpen} onClick={event => { opener.current = event.currentTarget; setSelected(project.id); }} aria-label={`${project.name}の詳細を開く`}>{project.name}<span aria-hidden="true"> →</span></button></h3><p className={styles.meta}>主担当：{project.primaryAssignee.name}<span>納期：<time dateTime={project.dueDate}>{project.dueDate.replaceAll('-', '/')}</time></span></p></div><div className={styles.progress}><span>{labels[project.status] ?? project.status}</span><p><strong>{project.progress}</strong>％</p><progress value={project.progress} max={100} aria-label={`${project.name}の進捗`} /></div></li>)}</ul>
        <div className={styles.listFooter}><p>{projects.value.items.length}件表示中{projects.value.page.hasMore ? ' · 続きがあります' : ''}</p>{projects.value.page.hasMore && <button onClick={more} disabled={busy}>{busy ? '読み込み中…' : '続きを読み込む'}</button>}{moreError && <p role="alert" className={styles.error}>{moreError}</p>}</div>
      </>)}
  </section>{creating && <ProjectCreate teamId={teamId} signedOut={signedOut} savingChanged={savingChanged} cancel={() => setCreating(false)} created={id => { setCreating(false); setSelected(id); setNotice('案件を登録しました。'); setProjects({ phase: 'loading' }); setMoreError(''); setReload(value => value + 1); }} />}{selected && <ProjectDetail key={selected} archived={archived} teamId={teamId} projectId={selected} signedOut={signedOut} savingChanged={savingChanged} changed={() => { setNotice('保存を確認しました。'); setProjects({ phase: 'loading' }); setMoreError(''); setReload(value => value + 1); }} moved={action => { setSelected(null); setNotice(action === 'archive' ? 'アーカイブしました。保管一覧から確認できます。' : '復元しました。通常の案件から確認できます。'); setProjects({ phase: 'loading' }); setMoreError(''); setReload(value => value + 1); }} close={() => setSelected(null)} />}</>;
}
