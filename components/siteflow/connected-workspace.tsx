'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import styles from './connected-workspace.module.css';
import { ApiError, invalidateRequests, message, request, type Page, type Resource } from './workspace-api';
import { clearDraftGuards, confirmNavigation } from './draft-guard';
import { ProjectList } from './project-list';
import { isUuid } from '@/lib/siteflow/domain';
import { changeWorkspaceLocation, useWorkspaceLocation } from './workspace-location';
import { MeetingWorkspace } from './meeting-workspace';
import { TeamCreate } from './team-create';
import { TeamInvitations } from './team-invitations';
import { TeamSettings } from './team-settings';

type User = { id: string; name: string; email: string };
type Team = { id: string; name: string; role: 'admin' | 'member' };
// 画面内状態だけを管理。パスワードやセッションをブラウザー保存へ書き込まない。
export function ConnectedWorkspace({ connection = 'local' }: { connection?: 'local' | 'public' }) {
  const [session, setSession] = useState<Resource<User | null>>({ phase: 'loading' });
  const [reload, setReload] = useState(0);
  const [authNotice, setAuthNotice] = useState('');
  useEffect(() => {
    const expired = () => { clearDraftGuards(); setAuthNotice('ログインの有効期限が切れました。業務画面と下書きを破棄しました。もう一度ログインしてください。'); setSession({ phase: 'ready', value: null }); };
    const unknownLogout = () => setAuthNotice('ログアウトの結果とセッション状態を確認できません。安全のため業務画面を非表示にしました。通信復旧後にログイン状態を確認し、必要なら再度ログアウトしてください。');
    window.addEventListener('siteflow-session-expired', expired);
    window.addEventListener('siteflow-logout-unknown', unknownLogout);
    return () => { window.removeEventListener('siteflow-session-expired', expired); window.removeEventListener('siteflow-logout-unknown', unknownLogout); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    request<{ user: User } | null>('auth/get-session', controller.signal)
      .then(data => setSession({ phase: 'ready', value: data?.user ?? null }))
      .catch(error => { if (!controller.signal.aborted) setSession({ phase: 'error', message: message(error) }); });
    return () => controller.abort();
  }, [reload]);
  const retry = () => { setSession({ phase: 'loading' }); setReload(value => value + 1); };
  return <div className={styles.shell}>
      <header className={styles.header}><Link href="/workspace" className={styles.brand}>SiteFlow<span>チームの仕事を、ひとつの場所に。</span></Link><Link href="/" onClick={event => { if (!confirmNavigation()) event.preventDefault(); }}>トップページへ</Link></header>
    <main className={styles.main}>
      <p className={styles.eyebrow}>{connection === 'public' ? 'WORKSPACE PREVIEW' : 'LOCAL WORKSPACE'}</p><h1>案件ワークスペース</h1>
      <p className={styles.intro}>チームを選んで、保存されている案件を確認できます。</p>
      <p className={styles.notice}>{connection === 'public' ? '動作確認用のプレビュー · 架空のデータで操作をお試しください。' : 'ローカル接続版 · 案件の登録から完了・保管・復元まで利用できます。'}</p>
      {authNotice && <p role="alert" className={styles.notice}>{authNotice}</p>}
      {session.phase === 'loading' && <div className={styles.panel} role="status">ログイン状態を確認しています…</div>}
      {session.phase === 'error' && <div className={styles.panel}><p role="alert">{session.message}</p><button onClick={retry}>もう一度接続する</button></div>}
      {session.phase === 'ready' && (session.value
        ? <TeamWorkspace key={session.value.id} user={session.value} signedOut={() => setSession({ phase: 'ready', value: null })} />
        : <Login connection={connection} signedIn={user => { setAuthNotice(''); setSession({ phase: 'ready', value: user }); }} />)}
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
  const location = useWorkspaceLocation();
  const requestedTeam = (new URLSearchParams(location).get('team') ?? '').toLowerCase();
  const screen = new URLSearchParams(location).get('view');
  const [teams, setTeams] = useState<Resource<Page<Team>>>({ phase: 'loading' });
  const [teamId, setTeamId] = useState(''); const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [moreError, setMoreError] = useState(''); const active = useRef(true);
  const reloadTeams = useCallback(() => setReload(n => n + 1), []);
  const enterTeam = (id: string) => { setSaving(false); changeWorkspaceLocation(new URLSearchParams({ team: id, view: 'projects' })); reloadTeams(); };
  const leaveTeam = useCallback(() => { clearDraftGuards(); setSaving(false); setTeamId(''); setTeams({ phase: 'loading' }); changeWorkspaceLocation(new URLSearchParams({ view: 'projects' }), true); setReload(n => n + 1); }, []);
  useEffect(() => {
    const denied = (e: Event) => { if ((e as CustomEvent<string>).detail === teamId) leaveTeam(); };
    window.addEventListener('siteflow-team-access-denied', denied);
    return () => window.removeEventListener('siteflow-team-access-denied', denied);
  }, [teamId, leaveTeam]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const failure = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) signedOut();
    else if (error instanceof ApiError && error.code === 'TEAM_ACCESS_DENIED') leaveTeam();
    else setTeams({ phase: 'error', message: message(error) });
  }, [signedOut, leaveTeam]);
  // signedOutをeffectの依存にしないよう、この画面にいる間の呼び出し先を保持する。
  const onFailure = useRef(failure); useEffect(() => { onFailure.current = failure; }, [failure]);
  useEffect(() => {
    const controller = new AbortController();
    request<Page<Team>>('teams', controller.signal).then(async page => {
      if (requestedTeam) {
        if (!isUuid(requestedTeam)) throw new Error('URLのチーム指定が不正です。');
        if (!page.items.some(team => team.id === requestedTeam)) {
          const access = await request<{ team: { id: string; name: string }; role: 'admin' | 'member' }>('teams/' + requestedTeam + '/access', controller.signal);
          page = { ...page, items: [{ ...access.team, role: access.role }, ...page.items] };
        }
      }
      if (controller.signal.aborted) return;
      setTeams({ phase: 'ready', value: page }); setTeamId(requestedTeam || page.items[0]?.id || '');
    }).catch(error => { if (!controller.signal.aborted) onFailure.current(error); });
    return () => controller.abort();
  }, [reload, requestedTeam]);
  async function moreTeams() {
    if (busy || teams.phase !== 'ready' || !teams.value.page.nextCursor) return;
    const previous = teams.value; setBusy(true); setMoreError('');
    try { const next = await request<Page<Team>>('teams?cursor=' + encodeURIComponent(previous.page.nextCursor!)); if (active.current) setTeams({ phase: 'ready', value: { items: [...previous.items, ...next.items], page: next.page } }); }
    catch (error) { if (active.current) { if (error instanceof ApiError && error.status === 401) signedOut(); else setMoreError(message(error)); } }
    finally { if (active.current) setBusy(false); }
  }
  async function logout() {
    if (busy || !confirmNavigation()) return; setBusy(true); setError('');
    try { await request('auth/sign-out', undefined, {}); invalidateRequests(); clearDraftGuards(); signedOut(); }
    catch {
      try {
        const latest = await request<{ user: User } | null>('auth/get-session');
        if (!latest?.user || latest.user.id !== user.id) { invalidateRequests(); clearDraftGuards(); signedOut(); }
        else { setError('ログアウトを確認できません。セッションは有効です。もう一度ログアウトしてください。'); setBusy(false); }
      } catch { invalidateRequests(); clearDraftGuards(); window.dispatchEvent(new Event('siteflow-logout-unknown')); signedOut(); }
    }
  }
  return <>
    <div className={styles.account}><p><strong>{user.name}</strong><span>ログイン中</span></p><button onClick={logout} disabled={busy || saving}>ログアウト</button></div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {teams.phase === 'ready' && <div className={styles.relatedButtons} role="group" aria-label="チーム管理の入口">
      <button disabled={saving} onClick={() => changeWorkspaceLocation(new URLSearchParams({ ...(teamId ? { team: teamId } : {}), view: 'create-team' }))}>チームを作成</button>
      <button disabled={saving} onClick={() => changeWorkspaceLocation(new URLSearchParams({ ...(teamId ? { team: teamId } : {}), view: 'invitations' }))}>自分宛ての招待</button>
      <button disabled={saving} onClick={() => changeWorkspaceLocation(new URLSearchParams({ ...(teamId ? { team: teamId } : {}), view: 'projects' }))}>所属チームへ戻る</button>
    </div>}
    {teams.phase === 'loading' && <div className={styles.panel} role="status">所属チームを読み込んでいます…</div>}
    {teams.phase === 'error' && <div className={styles.panel}><p role="alert">{teams.message}</p><button onClick={() => { setTeams({ phase: 'loading' }); setTeamId(''); setReload(n => n + 1); }}>チームを再取得する</button></div>}
    {teams.phase === 'ready' && (screen === 'create-team'
      ? <TeamCreate created={enterTeam} blockedChanged={setSaving} signedOut={signedOut} checkTeams={() => { setSaving(false); changeWorkspaceLocation(new URLSearchParams({ view: 'projects' })); reloadTeams(); }} />
      : screen === 'invitations' ? <TeamInvitations joined={enterTeam} signedOut={signedOut} blockedChanged={setSaving} />
      : teams.value.items.length === 0
      ? <div className={styles.panel}><h2>所属チームはまだありません</h2><p>上の「チームを作成」または「自分宛ての招待」から始められます。</p></div>
      : <><section className={styles.teamPicker} aria-label="表示するチーム"><div><label htmlFor="team-select">チーム</label><select id="team-select" disabled={saving} value={teamId} onChange={e => changeWorkspaceLocation(new URLSearchParams({ team: e.target.value, view: 'projects' }))}>{teams.value.items.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></div><p>{teams.value.items.find(t => t.id === teamId)?.role === 'admin' ? '管理者' : 'メンバー'}</p>{teams.value.page.hasMore && <button onClick={moreTeams} disabled={busy || saving}>ほかのチームを読み込む</button>}</section>
        {moreError && <p className={styles.error} role="alert">{moreError}</p>}
        <ProjectBrowser key={teamId} userId={user.id} teamId={teamId} signedOut={signedOut} savingChanged={setSaving} teamChanged={reloadTeams} exited={leaveTeam} />
      </>)}
  </>;
}

function ProjectBrowser({ teamId, userId, signedOut, savingChanged, teamChanged, exited }: { teamId: string; userId: string; signedOut: () => void; savingChanged: (busy: boolean) => void; teamChanged: () => void; exited: () => void }) {
  const [saving, setSaving] = useState(false);
  const location = useWorkspaceLocation();
  const view = new URLSearchParams(location).get('view') ?? 'projects';
  const archived = view === 'archived'; const meeting = view === 'meeting'; const settings = view === 'team-settings';
  const selectView = (next: string) => changeWorkspaceLocation(new URLSearchParams({ team: teamId, view: next }));
  const updateSaving = useCallback((value: boolean) => { setSaving(value); savingChanged(value); }, [savingChanged]);
  return <><div className={styles.relatedButtons} role="group" aria-label="案件の一覧切替"><button aria-pressed={!archived && !meeting && !settings} disabled={saving} onClick={() => selectView('projects')}>通常の案件</button><button aria-pressed={archived && !meeting} disabled={saving} onClick={() => selectView('archived')}>保管一覧</button><button aria-pressed={meeting} disabled={saving} onClick={() => selectView('meeting')}>会議</button><button aria-pressed={settings} disabled={saving} onClick={() => selectView('team-settings')}>チーム設定</button></div>
    {settings ? <TeamSettings teamId={teamId} userId={userId} blockedChanged={updateSaving} changed={teamChanged} exited={exited} signedOut={signedOut} navigate={params => changeWorkspaceLocation(new URLSearchParams(params))} />
      : meeting ? <MeetingWorkspace key={new URLSearchParams(location).get('meeting') ?? ''} teamId={teamId} initialMeetingId={new URLSearchParams(location).get('meeting') ?? undefined} initialEntryId={new URLSearchParams(location).get('entry') ?? undefined} signedOut={signedOut} savingChanged={updateSaving} /> : <ProjectList key={String(archived)} archived={archived} teamId={teamId} signedOut={signedOut} savingChanged={updateSaving} />}
  </>;
}
