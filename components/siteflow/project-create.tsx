'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { parseCreateProjectInput } from '@/lib/siteflow/domain';
import { ApiError, message, request, type Page, type Resource } from './workspace-api';
import styles from './connected-workspace.module.css';

type Member = { userId: string; name: string; role: string };
type Draft = { name: string; dueDate: string; code: string; clientName: string; summary: string; notes: string };
const empty: Draft = { name: '', dueDate: '', code: '', clientName: '', summary: '', notes: '' };

export function ProjectCreate({ teamId, signedOut, created, cancel, savingChanged }: {
  teamId: string; signedOut: () => void; created: (id: string) => void; cancel: () => void; savingChanged: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState(empty);
  const [members, setMembers] = useState<Resource<Page<Member>>>({ phase: 'loading' });
  const [primary, setPrimary] = useState(''); const [supports, setSupports] = useState<string[]>([]);
  const [reload, setReload] = useState(0); const [loadingMore, setLoadingMore] = useState(false);
  const [candidateError, setCandidateError] = useState(''); const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); const posting = useRef(false);
  const [uncertain, setUncertain] = useState(false); const [confirmed, setConfirmed] = useState(false);
  const active = useRef(true); const moreController = useRef<AbortController | null>(null);
  const callbacks = useRef({ signedOut, created, savingChanged });
  useEffect(() => { callbacks.current = { signedOut, created, savingChanged }; }, [signedOut, created, savingChanged]);
  const heading = useRef<HTMLHeadingElement>(null);
  const errorText = useRef<HTMLParagraphElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { if (error) errorText.current?.focus(); }, [error]);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; moreController.current?.abort(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    request<Page<Member>>(`teams/${teamId}/members`, controller.signal).then(page => {
      if (!controller.signal.aborted) setMembers({ phase: 'ready', value: page });
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut();
      else setMembers({ phase: 'error', message: message(error) });
    });
    return () => controller.abort();
  }, [teamId, reload]);
  function refreshMembers() {
    moreController.current?.abort(); setLoadingMore(false); setCandidateError('');
    setMembers({ phase: 'loading' }); setReload(value => value + 1);
    // 選んだIDは入力として保持。候補から消えた人は保存前に選び直す。
  }
  async function moreMembers() {
    if (loadingMore || members.phase !== 'ready' || !members.value.page.nextCursor) return;
    const previous = members.value; setLoadingMore(true); setCandidateError('');
    const controller = new AbortController(); moreController.current = controller;
    try {
      const next = await request<Page<Member>>(`teams/${teamId}/members?cursor=${encodeURIComponent(previous.page.nextCursor!)}`, controller.signal);
      if (active.current && !controller.signal.aborted) setMembers({ phase: 'ready', value: { items: [...previous.items, ...next.items], page: next.page } });
    } catch (error) {
      if (active.current && !controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut(); else setCandidateError(message(error)); }
    } finally { if (active.current && !controller.signal.aborted) setLoadingMore(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (posting.current || members.phase !== 'ready' || uncertain && !confirmed) return;
    setError('');
    const input = parseCreateProjectInput({ ...draft, primaryUserId: primary, supportUserIds: supports });
    if (!input) { setError('案件名は1〜200文字、納期は実在する日付、主担当1人・副担当50人以内を指定してください。番号100文字・取引先200文字・概要と備考2000文字以内で、制御文字は使えません。'); return; }
    const selected = [primary, ...supports];
    if (selected.some(id => !members.value.items.some(person => person.userId === id))) { setError('選択した担当者を現在の候補で確認できません。続きを取得するか、担当者を選び直してください。入力は残っています。'); return; }
    posting.current = true; setBusy(true); callbacks.current.savingChanged(true);
    try {
      // POSTは自動再送しない。保存結果が不明な場合は一覧確認を促す。
      const result = await request<{ project: { id: string } }>(`teams/${teamId}/projects`, undefined, input);
      if (!result.project?.id) throw new Error('登録結果を確認できませんでした。');
      if (active.current) callbacks.current.created(result.project.id);
    } catch (error) {
      if (!active.current) return;
      if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut();
      else {
        const unknownResult = !(error instanceof ApiError) || error.status >= 500;
        setUncertain(unknownResult); setConfirmed(false);
        setError(unknownResult ? '登録結果を確認できません。保存済みの可能性があります。同じチームの一覧を別タブで確認し、未登録の場合だけ再送してください。入力は保持しています。' : message(error));
      }
    } finally {
      posting.current = false;
      // 成功時の画面切替直後にも親の操作ロックを解除する。
      callbacks.current.savingChanged(false);
      if (active.current) setBusy(false);
    }
  }
  const people = members.phase === 'ready' ? members.value.items : [];
  const unavailable = [primary, ...supports].filter(id => id && !people.some(person => person.userId === id));
  const update = (key: keyof Draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  return <section className={styles.projectPanel} aria-labelledby="create-title" data-project-create>
    <div className={styles.panelHeading}><div><p className={styles.eyebrow}>NEW PROJECT</p><h2 id="create-title" ref={heading} tabIndex={-1}>案件を登録</h2></div></div>
    <form onSubmit={submit} className={styles.createForm} aria-busy={busy}>
      <p className={styles.help}>必須項目を入力してください。未着手・進捗0％で登録されます。チーム切替・画面移動では入力を破棄します。</p>
      <fieldset disabled={busy} className={styles.createFields}><legend>基本情報</legend>
        <label htmlFor="project-name">案件名（必須・200文字以内）</label><input id="project-name" required maxLength={200} value={draft.name} onChange={event => update('name', event.target.value)} />
        <label htmlFor="project-due">納期（必須）</label><input id="project-due" type="date" required min="1000-01-01" max="9999-12-31" value={draft.dueDate} onChange={event => update('dueDate', event.target.value)} />
        <label htmlFor="project-code">案件番号（任意・100文字以内）</label><input id="project-code" maxLength={100} value={draft.code} onChange={event => update('code', event.target.value)} />
        <label htmlFor="project-client">取引先（任意・200文字以内）</label><input id="project-client" maxLength={200} value={draft.clientName} onChange={event => update('clientName', event.target.value)} />
        <label htmlFor="project-summary">概要（任意・2000文字以内）</label><textarea id="project-summary" rows={3} maxLength={2000} value={draft.summary} onChange={event => update('summary', event.target.value)} />
        <label htmlFor="project-notes">備考（任意・2000文字以内）</label><textarea id="project-notes" rows={3} maxLength={2000} value={draft.notes} onChange={event => update('notes', event.target.value)} />
      </fieldset>
      <fieldset disabled={busy} className={styles.createFields}><legend>担当者</legend>
        {members.phase === 'loading' && <p role="status">担当候補を読み込んでいます…</p>}
        {members.phase === 'error' && <><p className={styles.error} role="alert">{members.message}</p><button type="button" onClick={refreshMembers}>担当候補を再取得する</button></>}
        {members.phase === 'ready' && <>
          {people.length === 0 && <p>担当候補がいません。チームへの所属を確認してください。</p>}
          <label htmlFor="project-primary">主担当（必須）</label><select id="project-primary" required value={primary} onChange={event => { const id = event.target.value; setPrimary(id); setSupports(previous => previous.filter(value => value !== id)); }}>
            <option value="">主担当を選択</option>{primary && !people.some(person => person.userId === primary) && <option value={primary}>候補を再取得・選び直してください</option>}
            {people.map(person => <option key={person.userId} value={person.userId}>{person.name}</option>)}
          </select>
          <fieldset className={styles.supportChoices}><legend>副担当（任意・最大50人）</legend><p className={styles.help}>主担当に選んだ人は副担当から外れます。</p>
            {people.filter(person => person.userId !== primary).map(person => <label key={person.userId}><input type="checkbox" value={person.userId} checked={supports.includes(person.userId)} disabled={!supports.includes(person.userId) && supports.length >= 50} onChange={event => setSupports(previous => event.target.checked ? [...previous, person.userId] : previous.filter(id => id !== person.userId))} />{person.name}</label>)}
          </fieldset>
          {unavailable.length > 0 && <p className={styles.error}>選択した担当者のうち{unavailable.length}人を現在の候補で確認できません。候補の続きを取得するか、選択を解除してください。<button type="button" onClick={() => { if (!people.some(person => person.userId === primary)) setPrimary(''); setSupports(previous => previous.filter(id => people.some(person => person.userId === id))); }}>確認できない選択を解除する</button></p>}
          {members.value.page.hasMore && <button type="button" disabled={loadingMore} onClick={moreMembers}>{loadingMore ? '候補を読み込み中…' : '担当候補の続きを取得する'}</button>}
          {candidateError && <p className={styles.error} role="alert">{candidateError} 続きの取得をもう一度試すか、候補を再取得してください。</p>}
          <button type="button" disabled={loadingMore} onClick={refreshMembers}>担当候補を再取得する</button>
        </>}
      </fieldset>
      {error && <p className={styles.error} role="alert" ref={errorText} tabIndex={-1}>{error}</p>}
      {uncertain && <div className={styles.uncertain}><a href="/workspace" target="_blank" rel="noopener">別タブで同じチームの一覧を確認する</a><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />同じチームで未登録と確認しました。再送します。</label></div>}
      <div className={styles.createActions}><button className={styles.primary} disabled={busy || loadingMore || members.phase !== 'ready' || people.length === 0 || uncertain && !confirmed}>{busy ? '登録しています…' : '案件を登録する'}</button><button type="button" disabled={busy} onClick={cancel}>入力を破棄して一覧へ戻る</button></div>
    </form>
  </section>;
}
