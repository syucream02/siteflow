'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, message, request, resultUnknown } from './workspace-api';
import { useDraftGuard } from './draft-guard';
import styles from './connected-workspace.module.css';

type Item = { id: string; actionId: string; content: string; status: string; dueDate: string | null;
  assigneeUserId: string; assigneeName: string; itemVersion: number; currentVersion?: number | null;
  currentStatus?: string | null; stale?: boolean; sourceSnapshotId?: string; sourceMeetingId: string | null;
  recordedAt?: string; recordedBy?: string; sourceEntryId?: string | null };
type Records = { note: { consultation: string; decision: string; updatedAt: string; updatedByNameSnapshot: string } | null;
  meetingVersion: number; ended: boolean; canOperate: boolean; items: Item[]; page: { hasMore: boolean; nextCursor: string | null } };
const labels: Record<string, string> = { OPEN: '未対応', DONE: '対応済み', CANCELLED: '取消' };
const blank = { content: '', assigneeUserId: '', dueDate: '', status: 'OPEN' };

export function MeetingRecords({ teamId, meetingId, entryId, ended, memberChoices, memberFeedback, changed, blockedChanged, signedOut, openSource }: {
  teamId: string; meetingId: string; entryId: string; ended: boolean; memberChoices: React.ReactNode; memberFeedback: React.ReactNode;
  changed: () => Promise<unknown>; blockedChanged: (value: boolean) => void; signedOut: () => void; openSource: (meetingId: string, entryId?: string) => void;
}) {
  const [records, setRecords] = useState<Records | null>(null), [candidates, setCandidates] = useState<Records | null>(null);
  const [notes, setNotes] = useState({ consultation: '', decision: '' }), [draft, setDraft] = useState(blank);
  const [editing, setEditing] = useState<Item | null>(null), [carrying, setCarrying] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [baselineNotes, setBaselineNotes] = useState({ consultation: '', decision: '' });
  const [uncertain, setUncertain] = useState(false), [needsReview, setNeedsReview] = useState(false);
  const baseDraft = editing ? { content: editing.content, assigneeUserId: editing.assigneeUserId, dueDate: editing.dueDate?.slice(0, 10) ?? '', status: editing.status } : blank;
  const dirty = notes.consultation !== baselineNotes.consultation || notes.decision !== baselineNotes.decision || Boolean(carrying) || Object.keys(blank).some(k => draft[k as keyof typeof blank] !== baseDraft[k as keyof typeof blank]);
  useDraftGuard(dirty || uncertain, busy, () => { setNotes(baselineNotes); setDraft(blank); setEditing(null); setCarrying(null); });
  const [review, setReview] = useState<Records | null>(null);
  const state = useRef({ dirty: false, busy: false }), callbacks = useRef({ changed, blockedChanged, signedOut });
  const sequence = useRef(0), expanded = useRef(false), baseVersion = useRef(0);
  const path = `teams/${teamId}/meetings/${meetingId}`, entryPath = `${path}/entries/${entryId}`;
  useEffect(() => { callbacks.current = { changed, blockedChanged, signedOut }; }, [changed, blockedChanged, signedOut]);
  const mark = (value: boolean) => { state.current.dirty = value; };
  useLayoutEffect(() => { state.current.dirty = dirty; callbacks.current.blockedChanged(busy); }, [dirty, busy]);
  const fail = useCallback((e: unknown) => { if (e instanceof ApiError && e.status === 401) callbacks.current.signedOut(); else setError(message(e)); }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    const ticket = ++sequence.current;
    try {
      const value = await request<Records>(entryPath + '/records', signal);
      if (signal?.aborted || ticket !== sequence.current) return;
      setRecords(value);
      if (!state.current.dirty && !state.current.busy) {
        baseVersion.current = value.meetingVersion;
        const saved = { consultation: value.note?.consultation ?? '', decision: value.note?.decision ?? '' };
        setNotes(saved); setBaselineNotes(saved);
      }
      return true;
    } catch (e) { if (!signal?.aborted && ticket === sequence.current) fail(e); return false; }
  }, [entryPath, fail]);
  useEffect(() => {
    const controller = new AbortController();
    const counter = sequence;
    queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); });
    const timer = setInterval(() => { if (!state.current.dirty && !state.current.busy && !expanded.current) void load(controller.signal); }, 10000);
    return () => { controller.abort(); clearInterval(timer); counter.current++; callbacks.current.blockedChanged(false); };
  }, [load]);
  function discard() {
    if (state.current.busy) return;
    mark(false); setNotes(baselineNotes); setEditing(null); setCarrying(null); setDraft(blank); setReview(null); setNeedsReview(false); setError(''); void load();
  }
  async function save(action: string, extra: object) {
    if (state.current.busy || ended || !records?.canOperate || uncertain || needsReview) return;
    state.current.busy = true; setBusy(true); callbacks.current.blockedChanged(true); setError(''); setNotice(''); sequence.current++;
    try {
      await request(path, undefined, { action, entryId, expectedVersion: baseVersion.current, ...extra }, 'PATCH');
      mark(false); setEditing(null); setCarrying(null); setDraft(blank); setReview(null); setCandidates(null);
      state.current.busy = false; expanded.current = false;
      const refreshed = await load(); const parent = await callbacks.current.changed(); setNotice(refreshed && parent ? '保存済み' : '保存済みです。最新表示の再取得に失敗しました。再保存せず再取得してください。');
    } catch (e) {
      fail(e);
      if (resultUnknown(e)) setUncertain(true);
      if (e instanceof ApiError && e.status === 409 || resultUnknown(e)) {
        setNeedsReview(true);
        try { setReview(await request<Records>(entryPath + '/records')); } catch (readError) { fail(readError); }
      }
    } finally { state.current.busy = false; setBusy(false); callbacks.current.blockedChanged(state.current.dirty); }
  }
  async function more(kind: 'records' | 'carry-candidates') {
    const current = kind === 'records' ? records : candidates;
    if (busy || dirty) return;
    try {
      const value = await request<Records>(entryPath + '/' + kind + (current?.page.nextCursor ? '?cursor=' + current.page.nextCursor : ''));
      const next = current && current.page.nextCursor ? { ...value, items: [...current.items, ...value.items] } : value;
      if (kind === 'records') { expanded.current = true; setRecords(next); } else setCandidates(next);
    } catch (e) { fail(e); }
  }
  const readonly = ended || !records?.canOperate;
  const notesChanged = notes.consultation !== (records?.note?.consultation ?? '') || notes.decision !== (records?.note?.decision ?? '');
  const actionDraft = Boolean(editing || carrying || draft.content || draft.assigneeUserId || draft.dueDate || draft.status !== 'OPEN');
  return <section aria-labelledby="meeting-records-title" className={styles.recordsPanel}>
    <h3 id="meeting-records-title">相談・決定・次回までの対応</h3>
    {!records && !error && <p role="status">記録を読み込んでいます…</p>}
    {error && <p role="alert" className={styles.error}>{error}<button disabled={busy || dirty} onClick={() => void load()}>記録を再取得</button></p>}
    {notice && <p role="status" className={styles.success}>{notice}</p>}
    {uncertain && <div className={styles.notice}><p>保存結果は不明です。再送を停止しています。記録を確認し、新規対応事項は重複の可能性があるため再登録しないでください。不明な場合は管理者へ確認してください。</p><button disabled={busy} onClick={async () => { try { setReview(await request<Records>(entryPath + '/records')); } catch (e) { fail(e); } }}>保存後の記録を確認</button></div>}
    {dirty && <p className={styles.notice}>未保存の入力があります。案件移動・会議終了・チーム切替の前に、保存するか破棄を確認します。<button disabled={busy} onClick={discard}>入力を破棄</button></p>}
    {review && <div className={styles.notice}><p>{uncertain ? '保存結果の確認用に取得した記録です。入力は保持しています。成否は自動判定しません。' : '競合しました。入力は保持しています。'}最新の相談：{review.note?.consultation || '記録なし'}／決定：{review.note?.decision || '記録なし'}</p>
      {review.items.map(item => <p key={item.id}>最新の会議記録：{item.content}（{labels[item.status]}）</p>)}
      <p>対応事項が他の会議で変更された場合は、入力を控えたうえで破棄し、「最新の対応を確認」を行ってください。</p>
      <button disabled={busy || uncertain || !review.canOperate || Boolean(editing || carrying)} onClick={() => { baseVersion.current = review.meetingVersion; setRecords(review); setReview(null); setNeedsReview(false); setError(''); }}>最新のメモを確認したうえで自分の入力を再保存する</button></div>}
    {records && <>
      {records.ended && <p className={styles.help}>終了時点の記録（閲覧専用）。現在の対応事項の値で書き換えません。</p>}
      <div className={styles.editField}><label htmlFor="meeting-consultation">相談内容</label><textarea id="meeting-consultation" maxLength={2000} readOnly={readonly} disabled={busy || actionDraft} value={notes.consultation} onChange={e => { setNotes({ ...notes, consultation: e.target.value }); mark(true); }} /></div>
      <div className={styles.editField}><label htmlFor="meeting-decision">決定事項</label><textarea id="meeting-decision" maxLength={2000} readOnly={readonly} disabled={busy || actionDraft} value={notes.decision} onChange={e => { setNotes({ ...notes, decision: e.target.value }); mark(true); }} /></div>
      {!readonly && <button disabled={busy || uncertain || needsReview || !dirty || actionDraft} onClick={() => void save('save_notes', notes)}>相談・決定を保存</button>}
      {records.note && <p className={styles.help}>記録者：{records.note.updatedByNameSnapshot} · {new Date(records.note.updatedAt).toLocaleString('ja-JP')}</p>}
      <h4>この会議の対応事項</h4>
      {!records.items.length && <p>対応事項はまだありません。</p>}
      <ul className={styles.historyList}>{records.items.map(item => <li key={item.id}><strong>{labels[item.status]}</strong><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.content}</p>
        <p>担当：{item.assigneeName} · 期限：{item.dueDate?.slice(0, 10) ?? '指定なし'}</p>
        {item.recordedBy && <p className={styles.help}>記録：{item.recordedBy} · {new Date(item.recordedAt!).toLocaleString('ja-JP')}</p>}
        {item.sourceMeetingId && <button disabled={busy || dirty} onClick={() => openSource(item.sourceMeetingId!, item.sourceEntryId ?? undefined)}>引き継ぎ元の会議を見る</button>}
        {item.stale && <p className={styles.notice}>他の会議で変更されています。現在の状態：{labels[item.currentStatus!]}</p>}
        {!readonly && (item.stale ? <button disabled={busy || dirty} onClick={() => void save('refresh_action', { actionId: item.actionId, itemVersion: item.currentVersion })}>最新の対応を確認</button>
          : item.status === 'OPEN' && <button disabled={busy || dirty} onClick={() => { setEditing(item); setDraft({ content: item.content, assigneeUserId: item.assigneeUserId, dueDate: item.dueDate?.slice(0, 10) ?? '', status: item.status }); mark(true); }}>対応事項を編集</button>)}
      </li>)}</ul>
      {records.page.hasMore && <button disabled={busy || dirty} onClick={() => void more('records')}>対応事項をさらに表示</button>}
      {!readonly && <>
        <h4>{carrying ? '選択した事項を引き継ぐ' : editing ? '対応事項を編集' : '次回までの対応を登録'}</h4>
        <div className={styles.editField}><label htmlFor="meeting-action-content">対応内容</label><textarea id="meeting-action-content" maxLength={2000} disabled={busy || Boolean(carrying) || notesChanged} value={draft.content} onChange={e => { setDraft({ ...draft, content: e.target.value }); mark(true); }} /></div>
        <div className={styles.editField}><label htmlFor="meeting-action-owner">対応担当者（必須）</label><select id="meeting-action-owner" value={draft.assigneeUserId} disabled={busy || notesChanged} onChange={e => { setDraft({ ...draft, assigneeUserId: e.target.value }); mark(true); }}><option value="">現在の所属者を選択</option>{memberChoices}</select></div>
        {memberFeedback}
        <p className={styles.help}>退会済みの担当者の場合は、現在の所属者を選び直してください。過去の担当者名は記録に残ります。</p>
        {!carrying && <><div className={styles.editField}><label htmlFor="meeting-action-due">対応期限（任意）</label><input id="meeting-action-due" type="date" disabled={busy || notesChanged} value={draft.dueDate} onChange={e => { setDraft({ ...draft, dueDate: e.target.value }); mark(true); }} /></div>
          {editing && <div className={styles.editField}><label htmlFor="meeting-action-status">対応の状態</label><select id="meeting-action-status" value={draft.status} disabled={busy} onChange={e => { setDraft({ ...draft, status: e.target.value }); mark(true); }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>}</>}
        <button disabled={busy || uncertain || needsReview || !draft.content.trim() || !draft.assigneeUserId || Boolean(review)
          || notes.consultation !== (records.note?.consultation ?? '') || notes.decision !== (records.note?.decision ?? '')}
          onClick={() => void save(carrying ? 'carry_action' : editing ? 'update_action' : 'create_action', carrying
            ? { actionId: carrying.actionId, itemVersion: carrying.itemVersion, sourceSnapshotId: carrying.sourceSnapshotId, assigneeUserId: draft.assigneeUserId }
            : { content: draft.content, assigneeUserId: draft.assigneeUserId, dueDate: draft.dueDate || null,
              ...(editing ? { actionId: editing.actionId, itemVersion: editing.itemVersion, status: draft.status } : {}) })}>{carrying ? '選択した対応を引き継ぐ' : '対応事項を保存'}</button>
        <h4>前の会議から引き継ぐ</h4><p className={styles.help}>終了済み会議の記録があり、現在も未対応の事項だけを選択できます。自動コピーしません。</p>
        <button disabled={busy || dirty} onClick={() => { setCandidates(null); void more('carry-candidates'); }}>引き継ぎ候補を確認</button>
        {candidates && !candidates.items.length && <p>引き継ぎ候補はありません。</p>}
        {candidates && <ul className={styles.historyList}>{candidates.items.map(item => <li key={item.id}><p>{item.content} · {item.assigneeName}</p><button disabled={busy || dirty} onClick={() => { setCarrying(item); setDraft({ ...blank, content: item.content, assigneeUserId: item.assigneeUserId }); baseVersion.current = candidates.meetingVersion; mark(true); }}>この事項を選択</button></li>)}</ul>}
        {candidates?.page.hasMore && <button disabled={busy || dirty} onClick={() => void more('carry-candidates')}>引き継ぎ候補をさらに表示</button>}
      </>}
    </>}
  </section>;
}
