'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, message, request, resultUnknown } from './workspace-api';
import styles from './connected-workspace.module.css';
import { confirmNavigation, useDraftGuard } from './draft-guard';

export function TeamCreate({ created, blockedChanged, checkTeams, signedOut }: {
  created: (id: string) => void; blockedChanged: (value: boolean) => void; checkTeams: () => void; signedOut: () => void;
}) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const callbacks = useRef({ created, blockedChanged });
  const nameField = useRef<HTMLInputElement>(null);
  const posting = useRef(false);
  const releaseGuard = useDraftGuard(Boolean(name) || uncertain, busy, () => setName(''));
  useEffect(() => { nameField.current?.focus(); }, []);
  useEffect(() => { callbacks.current = { created, blockedChanged }; }, [created, blockedChanged]);
  useEffect(() => { callbacks.current.blockedChanged(busy); return () => callbacks.current.blockedChanged(false); }, [busy]);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (posting.current || uncertain) return; posting.current = true; setBusy(true); setError('');
    try { const result = await request<{ team: { id: string } }>('teams', undefined, { name }); releaseGuard(); setName(''); callbacks.current.blockedChanged(false); callbacks.current.created(result.team.id); }
    catch (e) { if (e instanceof ApiError && e.status === 401) signedOut(); else { setError(message(e)); if (resultUnknown(e)) setUncertain(true); } }
    finally { posting.current = false; setBusy(false); }
  }
  return <section className={styles.projectPanel} aria-labelledby="team-create-title"><div className={styles.detailBody}>
    <h2 id="team-create-title">チームを作成</h2><p>作成者が管理者になります。同じ表示名も使用できます。</p>
    <form onSubmit={submit}><div className={styles.createFields}><label htmlFor="new-team-name">チーム名（1〜80文字）</label><input ref={nameField} id="new-team-name" value={name} maxLength={160} required disabled={busy || uncertain} onChange={e => setName(e.target.value)} /></div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {uncertain && <p className={styles.notice}>作成結果を確認できません。作成済みの可能性があるため、自動再送しません。所属一覧を確認してください。</p>}
      <button className={styles.primary} disabled={busy || uncertain || !name.trim()}>{busy ? '作成中…' : 'チームを作成する'}</button></form>
    <button disabled={busy} onClick={() => { if (confirmNavigation()) { setName(''); callbacks.current.blockedChanged(false); checkTeams(); } }}>入力を破棄して所属一覧を確認</button>
  </div></section>;
}
