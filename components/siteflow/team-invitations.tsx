'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, message, request, resultUnknown, type Page } from './workspace-api';
import styles from './connected-workspace.module.css';
import { useDraftGuard } from './draft-guard';

type Invite = { id: string; teamId: string; teamName: string; inviterName: string; status: string; expiresAt: string; expired: boolean };
export const invitationLabels: Record<string, string> = { pending: '参加待ち', accepted: '承認済み', rejected: '辞退', canceled: '取消済み' };
export function TeamInvitations({ joined, signedOut, blockedChanged }: { joined: (id: string) => void; signedOut: () => void; blockedChanged: (v: boolean) => void }) {
  const [page, setPage] = useState<Page<Invite> | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const active = useRef(true), callbacks = useRef({ joined, signedOut, blockedChanged });
  const posting = useRef(false);
  const [uncertainId, setUncertainId] = useState<string | null>(null);
  const releaseGuard = useDraftGuard(false, busy, () => {});
  useEffect(() => { callbacks.current = { joined, signedOut, blockedChanged }; }, [joined, signedOut, blockedChanged]);
  const load = useCallback(async (cursor?: string, signal?: AbortSignal) => {
    try { const result = await request<Page<Invite>>('me/invitations' + (cursor ? '?cursor=' + cursor : ''), signal);
      if (!signal?.aborted && active.current) { setPage(old => cursor && old ? { ...result, items: [...old.items, ...result.items] } : result); setError(''); }
    } catch (e) { if (!signal?.aborted && active.current) { if (e instanceof ApiError && e.status === 401) callbacks.current.signedOut(); else setError(message(e)); } }
  }, []);
  useEffect(() => { active.current = true; const c = new AbortController(); queueMicrotask(() => { if (!c.signal.aborted) void load(undefined, c.signal); });
    return () => { active.current = false; c.abort(); callbacks.current.blockedChanged(false); }; }, [load]);
  async function answer(id: string, action: 'accept' | 'decline') {
    if (posting.current || uncertainId) return; posting.current = true; setBusy(true); callbacks.current.blockedChanged(true); setError('');
    try { const result = await request<{ teamId: string }>(`me/invitations/${id}/${action}`, undefined, {});
      if (active.current) { if (action === 'accept') { releaseGuard(); callbacks.current.blockedChanged(false); callbacks.current.joined(result.teamId); } else await load(); }
    } catch (e) { if (active.current) { if (e instanceof ApiError && e.status === 401) callbacks.current.signedOut(); else { if (resultUnknown(e)) setUncertainId(id); await load(); if (active.current) setError(message(e) + ' 招待と所属一覧で結果を確認してください。'); } } }
    finally { posting.current = false; if (active.current) { setBusy(false); callbacks.current.blockedChanged(false); } }
  }
  return <section className={styles.projectPanel} aria-labelledby="my-invitations-title"><div className={styles.detailBody}><h2 id="my-invitations-title">自分宛ての招待</h2>
    <p>既存のメール認証済みアカウントで参加します。新規登録・メール送信は行いません。</p>
    <button disabled={busy} onClick={() => void load()}>招待を再取得</button>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {uncertainId && <p role="status">回答結果は不明です。再送を停止しています。招待と所属を確認してください。不明な場合は管理者へ確認してください。</p>}
    {!page && !error && <p role="status">招待を読み込んでいます…</p>}
    {page && !page.items.length && <p>自分宛ての招待はありません。</p>}
    <ul className={styles.historyList}>{page?.items.map(i => {
      const valid = i.status === 'pending' && !i.expired && !uncertainId;
      return <li key={i.id} data-invitation-id={i.id}><h3>{i.teamName}</h3><p>招待者：{i.inviterName} · 参加時の役割：一般メンバー</p>
        <p>{i.status === 'pending' && i.expired ? '期限切れ' : invitationLabels[i.status] ?? '利用不可'} · 期限：{new Date(i.expiresAt).toLocaleString('ja-JP')}</p>
        {valid && <><button className={styles.primary} disabled={busy} onClick={() => void answer(i.id, 'accept')}>参加する</button><button disabled={busy} onClick={() => void answer(i.id, 'decline')}>辞退する</button></>}
      </li>;
    })}</ul>
    {page?.page.hasMore && <button disabled={busy} onClick={() => void load(page.page.nextCursor!)}>招待をさらに表示</button>}
  </div></section>;
}
