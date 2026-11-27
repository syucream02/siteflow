'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, message, request, resultUnknown, type Page } from './workspace-api';
import { confirmNavigation, useDraftGuard } from './draft-guard';
import { invitationLabels } from './team-invitations';
import styles from './connected-workspace.module.css';

type Settings = { team: { id: string; name: string; version: number }; role: string; counts: { members: number; admins: number }; orphanedCount: number; orphanedMeetings: { id: string }[] };
type Member = { userId: string; name: string; role: string };
type Invite = { id: string; email: string; status: string; expiresAt: string; expired: boolean };
type Blockers = { allowed: boolean; lastAdmin: boolean; counts: { projects: number; meetings: number; actions: number };
  projects: { id: string; name: string }[]; meetings: { id: string }[]; actions: { id: string; content: string; originEntryId: string; originEntry: { meetingId: string } }[] };
export function TeamSettings({ teamId, userId, blockedChanged, changed, exited, signedOut, navigate }: {
  teamId: string; userId: string; blockedChanged: (v: boolean) => void; changed: () => void; exited: () => void; signedOut: () => void; navigate: (params: Record<string, string>) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null), [members, setMembers] = useState<Page<Member> | null>(null), [invites, setInvites] = useState<Page<Invite> | null>(null);
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [role, setRole] = useState<{ userId: string; name: string; role: string } | null>(null);
  const [removal, setRemoval] = useState<{ userId: string; name: string; version: number; blockers: Blockers } | null>(null);
  const [conflict, setConflict] = useState<Settings | null>(null);
  const [outcome, setOutcome] = useState<'none' | 'unknown' | 'refresh_failed'>('none');
  const active = useRef(true), dirtyRef = useRef(false), baseVersion = useRef(0), busyRef = useRef(false);
  const callbacks = useRef({ blockedChanged, changed, exited, signedOut, navigate });
  useEffect(() => { callbacks.current = { blockedChanged, changed, exited, signedOut, navigate }; }, [blockedChanged, changed, exited, signedOut, navigate]);
  const path = `teams/${teamId}`;
  const dirty = Boolean(settings && name !== settings.team.name || email || role || removal);
  const releaseGuard = useDraftGuard(dirty || outcome === 'unknown', busy, () => { setEmail(''); setRole(null); setRemoval(null); if (settings) setName(settings.team.name); });
  const report = useCallback((e: unknown) => { if (e instanceof ApiError && e.status === 401) callbacks.current.signedOut(); else setError(message(e)); }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const current = await request<Settings>(path + '/settings', signal);
      const list = await request<Page<Member>>(path + '/members', signal);
      const invitations = current.role === 'admin' ? await request<Page<Invite>>(path + '/invitations', signal) : null;
      if (!signal?.aborted && active.current) { setSettings(current); setMembers(list); setInvites(invitations);
        if (!dirtyRef.current) { setName(current.team.name); baseVersion.current = current.team.version; } }
      return true;
    } catch (e) { if (!signal?.aborted && active.current) report(e); return false; }
  }, [path, report]);
  useEffect(() => { active.current = true; const c = new AbortController(); queueMicrotask(() => { if (!c.signal.aborted) void load(c.signal); });
    return () => { active.current = false; c.abort(); callbacks.current.blockedChanged(false); }; }, [load]);
  useEffect(() => { dirtyRef.current = dirty; callbacks.current.blockedChanged(busy); }, [dirty, busy]);
  async function run(route: string, body: object, method: 'POST' | 'PATCH' | 'DELETE' = 'POST', leave = false) {
    if (busyRef.current || outcome !== 'none' || conflict) return; busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await request(path + route, undefined, { expectedVersion: baseVersion.current, ...body }, method);
      if (!active.current) return;
      releaseGuard(); dirtyRef.current = false; setRole(null); setRemoval(null); setEmail(''); setConflict(null); callbacks.current.blockedChanged(false);
      if (leave) callbacks.current.exited(); else { const refreshed = await load(); callbacks.current.changed(); setOutcome(refreshed ? 'none' : 'refresh_failed'); setNotice(refreshed ? '保存済み' : '保存済みです。表示の再取得に失敗しました。再保存せず再取得してください。'); }
    } catch (e) {
      if (active.current) { report(e); if (resultUnknown(e)) setOutcome('unknown'); if (e instanceof ApiError && (e.status === 409 || e.code === 'TEAM_MANAGE_DENIED')) {
        try { const latest = await request<Settings>(path + '/settings'); if (active.current) setConflict(latest); } catch (readError) { report(readError); }
      } }
    } finally { busyRef.current = false; if (active.current) setBusy(false); }
  }
  function discard() { if (busyRef.current || !confirmNavigation()) return; dirtyRef.current = false; setRole(null); setRemoval(null); setEmail(''); setConflict(null); setError(''); if (settings) setName(settings.team.name); void load(); }
  async function check(member: Member) {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError('');
    try { const result = await request<{ version: number; blockers: Blockers }>(`${path}/members/${member.userId}/removal-check`);
      if (active.current) setRemoval({ ...result, userId: member.userId, name: member.name });
    } catch (e) { if (active.current) report(e); } finally { busyRef.current = false; if (active.current) setBusy(false); }
  }
  async function more(kind: 'members' | 'invitations') {
    if (busyRef.current || dirty) return;
    const previous = kind === 'members' ? members : invites; if (!previous?.page.nextCursor) return;
    busyRef.current = true; setBusy(true);
    try { if (kind === 'members') { const next = await request<Page<Member>>(`${path}/members?cursor=${previous.page.nextCursor}`); if (active.current) setMembers(old => ({ ...next, items: [...(old?.items ?? []), ...next.items] })); }
      else { const next = await request<Page<Invite>>(`${path}/invitations?cursor=${previous.page.nextCursor}`); if (active.current) setInvites(old => ({ ...next, items: [...(old?.items ?? []), ...next.items] })); }
    } catch (e) { report(e); } finally { busyRef.current = false; if (active.current) setBusy(false); }
  }
  function go(params: Record<string, string>) { dirtyRef.current = false; callbacks.current.blockedChanged(false); callbacks.current.navigate({ team: teamId, ...params }); }
  const admin = (conflict ?? settings)?.role === 'admin';
  return <section className={styles.projectPanel} aria-labelledby="team-settings-title"><div className={styles.detailBody}>
    <h2 id="team-settings-title">チーム設定</h2>
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.success} role="status">{notice}</p>}
    {outcome !== 'none' && <div className={styles.notice}><p>{outcome === 'unknown' ? '保存結果は不明です。再送は停止しています。現在の所属・招待・役割を確認し、不明な場合は管理者へ確認してください。再取得だけでは再送可能になりません。' : '保存は完了しています。表示を再取得してください。'}</p><button disabled={busy} onClick={async () => { if (await load()) setOutcome(old => old === 'refresh_failed' ? 'none' : old); }}>保存後の状態を確認</button></div>}
    {!settings && !error && <p role="status">設定を読み込んでいます…</p>}
    <button disabled={busy || dirty} onClick={() => void load()}>チーム設定を再取得</button>
    {dirty && <p className={styles.notice}>未保存の入力・確認中の操作があります。<button disabled={busy} onClick={discard}>入力・確認を破棄</button></p>}
    {conflict && <div className={styles.reviewPanel}><p>最新のチーム名：{conflict.team.name} · 管理者{conflict.counts.admins}人。入力は保持しています。</p>
      <button disabled={busy} onClick={() => { baseVersion.current = conflict.team.version; setSettings(conflict); setConflict(null); setError(''); }}>最新情報を確認して再試行する</button></div>}
    {settings && <>
      <p>メンバー{settings.counts.members}人 · 管理者{settings.counts.admins}人 · あなたは{admin ? '管理者' : '一般メンバー'}です。</p>
      {!!settings.orphanedCount && <div className={styles.notice}><p>現在所属していない進行役の会議が{settings.orphanedCount}件あります。自動復旧しません。管理者へ確認してください。</p>{settings.orphanedMeetings.map(m => <button key={m.id} disabled={dirty || busy} onClick={() => go({ view: 'meeting', meeting: m.id })}>該当会議を確認</button>)}</div>}
      <form onSubmit={e => { e.preventDefault(); void run('/settings', { name }, 'PATCH'); }}><div className={styles.createFields}><label htmlFor="settings-team-name">チーム名</label><input id="settings-team-name" maxLength={160} readOnly={!admin} disabled={busy || Boolean(email || role || removal)} value={name} onChange={e => setName(e.target.value)} /></div>
        {admin && <button disabled={busy || Boolean(email || role || removal || conflict) || name === settings.team.name || !name.trim()}>チーム名を保存</button>}</form>
      <h3>メンバー</h3><ul className={styles.historyList}>{members?.items.map(m => <li key={m.userId} data-member-id={m.userId}><strong>{m.name}{m.userId === userId ? '（自分）' : ''}</strong><p>{m.role === 'admin' ? '管理者' : '一般メンバー'}</p>
        {admin && <><button disabled={busy || dirty} onClick={() => setRole({ ...m, role: m.role === 'admin' ? 'member' : 'admin' })}>{m.role === 'admin' ? '一般メンバーに変更' : '管理者に変更'}</button>
          {m.userId !== userId && <button disabled={busy || dirty} onClick={() => void check(m)}>所属解除を確認</button>}</>}
      </li>)}</ul>
      {members?.page.hasMore && <button disabled={busy || dirty} onClick={() => void more('members')}>メンバーをさらに表示</button>}
      {role && <div className={styles.reviewPanel} role="alertdialog" aria-labelledby="role-confirm-title"><h3 id="role-confirm-title">{role.name}を{role.role === 'admin' ? '管理者' : '一般メンバー'}に変更しますか？</h3><p>降格時は、この人が発行した保留招待も取消されます。</p><button disabled={busy || Boolean(conflict) || !admin} onClick={() => void run('/members/' + role.userId, { role: role.role }, 'PATCH')}>役割変更を確定</button><button disabled={busy} onClick={() => setRole(null)}>変更をやめる</button></div>}
      {admin && <><h3>メンバーを招待</h3><p>既存の認証済みアカウントが本人専用一覧から参加します。新規登録・メール送信は行いません。期限7日、参加時は一般メンバーです。</p>
        <form onSubmit={e => { e.preventDefault(); void run('/invitations', { email }); }}><div className={styles.createFields}><label htmlFor="team-invite-email">招待先メールアドレス</label><input id="team-invite-email" type="email" maxLength={254} required value={email} disabled={busy || Boolean(role || removal) || name !== settings.team.name} onChange={e => setEmail(e.target.value)} /></div><button disabled={busy || Boolean(role || removal || conflict) || !email.trim() || name !== settings.team.name}>招待を作成</button></form>
        <h3>このチームの招待</h3>{invites && !invites.items.length && <p>招待はまだありません。</p>}
        <ul className={styles.historyList}>{invites?.items.map(i => <li key={i.id} data-team-invite-id={i.id}><p>{i.email}</p><p>{i.status === 'pending' && i.expired ? '期限切れ' : invitationLabels[i.status] ?? '利用不可'} · {new Date(i.expiresAt).toLocaleString('ja-JP')}</p>{i.status === 'pending' && <button disabled={busy || dirty} onClick={() => void run('/invitations/' + i.id + '/cancel', {})}>招待を取消</button>}</li>)}</ul>
        {invites?.page.hasMore && <button disabled={busy || dirty} onClick={() => void more('invitations')}>チームの招待をさらに表示</button>}
      </>}
      <button disabled={busy || dirty} onClick={() => void check({ userId, name: '自分', role: settings.role })}>このチームから退出</button>
      {removal && <div className={styles.reviewPanel} role="alertdialog" aria-labelledby="removal-title"><h3 id="removal-title">{removal.name}の{removal.userId === userId ? '退出' : '所属解除'}</h3>
        <p>過去の記録とアカウントは削除しません。発行した保留招待は取消します。他チームの所属は維持します。</p>
        {removal.blockers.lastAdmin && <p className={styles.error}>最後の管理者です。先に別の管理者を設定してください。</p>}
        <p>未完了案件{removal.blockers.counts.projects}件・進行役{removal.blockers.counts.meetings}件・未対応事項{removal.blockers.counts.actions}件。全対象から検査し、各先頭20件を表示しています。対応後に再確認してください。</p>
        {removal.blockers.projects.map(p => <button key={p.id} disabled={busy} onClick={() => go({ view: 'projects', q: p.name })}>{p.name}を確認</button>)}
        {removal.blockers.meetings.map(m => <button key={m.id} disabled={busy} onClick={() => go({ view: 'meeting', meeting: m.id })}>進行役を交代する会議へ</button>)}
        {removal.blockers.actions.map(a => <button key={a.id} disabled={busy} onClick={() => go({ view: 'meeting', meeting: a.originEntry.meetingId, entry: a.originEntryId })}>{a.content}の元会議へ</button>)}
        {!!removal.blockers.counts.actions && <p>終了済み会議の事項は、次の会議で引き継いで再割当してください。保管案件の場合は案件の復元を先に検討します。</p>}
        {!removal.blockers.allowed && <p className={styles.notice}>今は解除できません。既存画面で引き継ぎ・終了を済ませてください。</p>}
        <button disabled={busy || !removal.blockers.allowed || Boolean(conflict)} onClick={() => void run(removal.userId === userId ? '/leave' : '/members/' + removal.userId, { expectedVersion: removal.version }, removal.userId === userId ? 'POST' : 'DELETE', removal.userId === userId)}>所属解除・退出を確定</button>
        <button disabled={busy} onClick={() => setRemoval(null)}>解除をやめる</button>
      </div>}
    </>}
  </div></section>;
}
