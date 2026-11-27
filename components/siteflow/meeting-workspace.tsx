'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, message, request, resultUnknown, statusLabels, type Page, type Resource } from './workspace-api';
import type { MeetingProgressComparison, ProjectStatus } from '@/lib/siteflow/domain';
import styles from './connected-workspace.module.css';
import { MeetingRecords } from './meeting-records';
import { confirmNavigation, useDraftGuard } from './draft-guard';

type Summary = { id: string; startedAt: string; endedAt: string | null };
type Member = { userId: string; name: string };
type Confirmation = { progress: number; status: string; confirmedAt: string; confirmedByNameSnapshot: string };
type Entry = { id: string; projectId: string; nameAtStart: string; auditCount: number; confirmation: Confirmation | null;
  previousConfirmation: { meetingId: string; confirmedAt: string; progress: number; status: ProjectStatus } | null;
  comparison: MeetingProgressComparison;
  project: { name: string; dueDate: string; progress: number; status: string; archived: boolean; primaryName: string } };
type Meeting = Summary & { version: number; canOperate: boolean; facilitator: Member | null;
  counts: { total: number; confirmed: number; unconfirmed: number };
  comparisonCounts: { changed: number; noPrevious: number; unconfirmed: number }; entries: Entry[] };
const dateLabel = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));

function comparisonLabel(entry: Entry) {
  if (entry.comparison.source === 'unconfirmed') return 'この会議では未確認';
  if (!entry.previousConfirmation) return '前回記録なし';
  return [entry.comparison.progressChanged ? '進捗変更' : '', entry.comparison.statusChanged ? '状態変更' : ''].filter(Boolean).join('・') || '差分なし';
}

function ProgressComparison({ entry }: { entry: Entry }) {
  const { previousConfirmation: previous, comparison } = entry;
  const points = comparison.deltaPoints;
  return <section className={styles.meetingComparison} aria-label="前回確認からの差分">
    <dl className={styles.comparisonValues}>
      <div><dt>前回確認</dt><dd>{previous ? `${previous.progress}％` : '—'}</dd></div>
      <div><dt>{comparison.source === 'current' ? '現在' : 'この会議の確認時'}</dt><dd>{comparison.value ? `${comparison.value.progress}％` : '未確認'}</dd></div>
      <div><dt>増減</dt><dd>{points === null ? '—' : `${points > 0 ? '＋' : points < 0 ? '−' : '±'}${Math.abs(points)}ポイント`}</dd></div>
    </dl>
    {previous ? <p className={styles.help}>比較元：{dateLabel(previous.confirmedAt)}の確認記録（今回の会議開始前に終了した会議）</p> : <p className={styles.help}>前回の確認記録なし。初回や過去に未確認の案件は、0％とみなさず増減を表示しません。</p>}
    {comparison.value && <p>{comparison.source === 'current' ? '現在の状態' : 'この会議の確認時の状態'}：{statusLabels[comparison.value.status]}</p>}
    {comparison.value && previous && <p>状態の比較：{statusLabels[previous.status]} → {statusLabels[comparison.value.status]}</p>}
    <p className={styles.comparisonBadge}>{comparisonLabel(entry)}</p>
    {comparison.changedAfterConfirmation && <p className={styles.notice}>確認後に変更あり。確認時の記録は保持しています。最新値で記録し直す場合は、確認を取り消してから再確認してください。</p>}
  </section>;
}

export function MeetingWorkspace({ teamId, initialMeetingId, initialEntryId, signedOut, savingChanged }: { teamId: string; initialMeetingId?: string; initialEntryId?: string; signedOut: () => void; savingChanged: (busy: boolean) => void }) {
  const [meetings, setMeetings] = useState<Resource<Page<Summary>>>({ phase: 'loading' });
  const [members, setMembers] = useState<Page<Member>>({ items: [], page: { hasMore: false, nextCursor: null } });
  const [membersError, setMembersError] = useState('');
  const [selected, setSelected] = useState<string | null>(initialMeetingId ?? null);
  const [sourceEntry, setSourceEntry] = useState<string | undefined>(initialEntryId);
  const [facilitator, setFacilitator] = useState('');
  const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const [error, setError] = useState(''); const alive = useRef(true);
  const callbacks = useRef({ signedOut, savingChanged });
  useEffect(() => { callbacks.current = { signedOut, savingChanged }; }, [signedOut, savingChanged]);
  const [uncertain, setUncertain] = useState(false);
  const releaseGuard = useDraftGuard(!selected && Boolean(facilitator), busy, () => setFacilitator(''));
  const prefix = `teams/${teamId}/meetings`;
  const fail = useCallback((error: unknown) => { if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut(); }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    try { const page = await request<Page<Summary>>(prefix, signal); if (!signal?.aborted && alive.current) setMeetings({ phase: 'ready', value: page }); }
    catch (error) { if (!signal?.aborted && alive.current) { fail(error); setMeetings({ phase: 'error', message: message(error) }); } }
  }, [prefix, fail]);
  async function loadMembers(more = false, signal?: AbortSignal) {
    setMembersError('');
    try {
      const page = await request<Page<Member>>(`teams/${teamId}/members?limit=50${more && members.page.nextCursor ? '&cursor=' + encodeURIComponent(members.page.nextCursor) : ''}`, signal);
      if (!signal?.aborted && alive.current) setMembers(previous => ({ items: more ? [...previous.items, ...page.items] : page.items, page: page.page }));
    } catch (error) { if (!signal?.aborted && alive.current) { fail(error); setMembersError(message(error)); } }
  }
  useEffect(() => {
    alive.current = true; const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); });
    return () => { alive.current = false; controller.abort(); };
  }, [load]);
  // 候補の読み取りは一度。会議の自動更新で選択中の進行役を上書きしない。
  useEffect(() => {
    const controller = new AbortController();
    request<Page<Member>>(`teams/${teamId}/members?limit=50`, controller.signal).then(page => { if (!controller.signal.aborted) setMembers(page); })
      .catch(error => { if (!controller.signal.aborted) { fail(error); setMembersError(message(error)); } });
    return () => controller.abort();
  }, [teamId, fail]);
  function markBusy(value: boolean) { busyRef.current = value; setBusy(value); callbacks.current.savingChanged(value); }
  async function start() {
    if (busyRef.current || uncertain) return; markBusy(true); setError('');
    try { const result = await request<{ meeting: { id: string } }>(prefix, undefined, { facilitatorUserId: facilitator || null }); if (alive.current) { releaseGuard(); setFacilitator(''); setSelected(result.meeting.id); } }
    catch (error) { if (alive.current) { fail(error); if (resultUnknown(error)) setUncertain(true); setError(message(error)); } }
    finally { if (alive.current) markBusy(false); }
  }
  async function more() {
    if (busyRef.current || meetings.phase !== 'ready' || !meetings.value.page.nextCursor) return;
    markBusy(true); setError(''); const previous = meetings.value;
    try { const page = await request<Page<Summary>>(prefix + '?cursor=' + encodeURIComponent(previous.page.nextCursor!)); if (alive.current) setMeetings({ phase: 'ready', value: { items: [...previous.items, ...page.items], page: page.page } }); }
    catch (error) { if (alive.current) { fail(error); setError(message(error)); } }
    finally { if (alive.current) markBusy(false); }
  }
  const memberChoices = <>{members.items.map(member => <option key={member.userId} value={member.userId}>{member.name}</option>)}</>;
  const memberFeedback = <>{membersError && <p className={styles.error} role="alert">進行役の候補を取得できませんでした。<button disabled={busy} onClick={() => void loadMembers()}>候補を再取得</button></p>}{members.page.hasMore && <button disabled={busy} onClick={() => void loadMembers(true)}>進行役の候補をさらに表示</button>}</>;
  if (selected) return <MeetingRoom key={selected} teamId={teamId} meetingId={selected} signedOut={signedOut} savingChanged={savingChanged}
    initialEntryId={sourceEntry} memberChoices={memberChoices} memberFeedback={memberFeedback} openSource={(id, entry) => { if (!confirmNavigation()) return; setSourceEntry(entry); setSelected(id); }} back={() => { if (!confirmNavigation()) return; setSelected(null); setSourceEntry(undefined); setError(''); void load(); }} />;
  return <section className={styles.projectPanel} aria-labelledby="meetings-title">
    <div className={styles.panelHeading}><div><p className={styles.eyebrow}>TEAM MEETING</p><h2 id="meetings-title">会議</h2></div><button disabled={busy} onClick={() => void load()}>会議一覧を更新</button></div>
    <div className={styles.detailBody}>
      <p>開始時の通常案件を、納期が近い順に確認します。途中で画面を閉じても、同じ会議から続けられます。</p>
      <div className={styles.editField}><label htmlFor="meeting-facilitator">新しい会議の進行役</label><select id="meeting-facilitator" value={facilitator} disabled={busy} onChange={e => setFacilitator(e.target.value)}><option value="">指定しない（全メンバーが進行可能）</option>{memberChoices}</select></div>
      {uncertain && <p role="alert">開始結果は不明です。会議一覧を更新して確認してください。自動再送しません。保存された会議から再開してください。</p>}{memberFeedback}<button className={styles.primary} disabled={busy || uncertain} onClick={start}>{busy ? '処理中…' : '新しい会議を開始'}</button>
      <p className={styles.help}>全案件の確認と、前回の有効な確認記録からの進捗・状態の差分に対応しています。重要業務優先・決定事項は準備中です。</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {meetings.phase === 'loading' && <p role="status">会議を読み込んでいます…</p>}
      {meetings.phase === 'error' && <p role="alert" className={styles.error}>{meetings.message}</p>}
      {meetings.phase === 'ready' && (meetings.value.items.length ? <><ul className={styles.historyList}>{meetings.value.items.map(meeting => <li key={meeting.id}><button onClick={() => { if (confirmNavigation()) setSelected(meeting.id); }} disabled={busy}>{dateLabel(meeting.startedAt)} · {meeting.endedAt ? '終了した会議を見る' : '会議を再開'}</button></li>)}</ul>{meetings.value.page.hasMore && <button onClick={more} disabled={busy}>以前の会議を読み込む</button>}</> : <p>会議はまだありません。</p>)}
    </div>
  </section>;
}

function MeetingRoom({ teamId, meetingId, initialEntryId, signedOut, savingChanged, memberChoices, memberFeedback, back, openSource }: {
  teamId: string; meetingId: string; signedOut: () => void; savingChanged: (busy: boolean) => void;
  initialEntryId?: string; memberChoices: React.ReactNode; memberFeedback: React.ReactNode; back: () => void; openSource: (id: string, entryId?: string) => void;
}) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false); const busyRef = useRef(false); const reading = useRef(false);
  const [recordsBlocked, setRecordsBlocked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [entryId, setEntryId] = useState(''); const [facilitator, setFacilitator] = useState('__keep');
  const [finishing, setFinishing] = useState(false); const cancelFinish = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null); const alive = useRef(true); const initialized = useRef(false);
  const callbacks = useRef({ signedOut, savingChanged });
  useEffect(() => { callbacks.current = { signedOut, savingChanged }; }, [signedOut, savingChanged]);
  const recordBlockChanged = useCallback((value: boolean) => { setRecordsBlocked(value); callbacks.current.savingChanged(value || busyRef.current); }, []);
  const [uncertainAction, setUncertainAction] = useState(false);
  useDraftGuard(facilitator !== '__keep', busy, () => setFacilitator('__keep'));
  const path = `teams/${teamId}/meetings/${meetingId}`;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (reading.current) return null; reading.current = true; setRefreshing(true);
    try {
      const result = await request<{ meeting: Meeting }>(path, signal);
      if (signal?.aborted || !alive.current) return null;
      setMeeting(result.meeting); setError('');
      if (!initialized.current) { setEntryId(result.meeting.entries.find(entry => entry.id === initialEntryId)?.id ?? result.meeting.entries.find(entry => !entry.confirmation)?.id ?? result.meeting.entries[0]?.id ?? ''); initialized.current = true; }
      return result.meeting;
    } catch (error) {
      if (!signal?.aborted && alive.current) { if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut(); else setError(message(error)); }
      return null;
    } finally { reading.current = false; if (alive.current) setRefreshing(false); }
  }, [path, initialEntryId]);
  useEffect(() => {
    alive.current = true; const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(controller.signal); });
    const timer = setInterval(() => { if (!busyRef.current) void refresh(controller.signal); }, 10000);
    return () => { alive.current = false; controller.abort(); clearInterval(timer); };
  }, [refresh]);
  useEffect(() => { heading.current?.focus(); }, [entryId]);
  useEffect(() => { if (finishing) cancelFinish.current?.focus(); }, [finishing]);
  async function act(action: string, extra: object = {}) {
    if (!meeting || busyRef.current || reading.current || recordsBlocked || uncertainAction || !confirmNavigation()) return;
    busyRef.current = true; setBusy(true); callbacks.current.savingChanged(true); setError(''); setNotice('');
    try {
      await request(path, undefined, { action, expectedVersion: meeting.version, ...extra }, 'PATCH');
      const latest = await refresh();
      if (alive.current) {
        setNotice(latest ? '保存しました。' : '保存は完了しました。最新の表示を取得し直してください。');
        if (action === 'confirm' && latest) {
          const index = latest.entries.findIndex(entry => entry.id === entryId);
          const next = [...latest.entries.slice(index + 1), ...latest.entries.slice(0, index)].find(entry => !entry.confirmation);
          if (next) setEntryId(next.id);
        }
        if (action === 'finish') setFinishing(false);
      }
    } catch (error) {
      if (alive.current) { if (error instanceof ApiError && error.status === 401) callbacks.current.signedOut(); else { const text = message(error); if (resultUnknown(error)) setUncertainAction(true); if (error instanceof ApiError && error.status === 409) await refresh(); setError(text); } }
    } finally { if (alive.current) { busyRef.current = false; setBusy(false); callbacks.current.savingChanged(false); } }
  }
  const entry = meeting?.entries.find(item => item.id === entryId);
  const index = meeting?.entries.findIndex(item => item.id === entryId) ?? -1;
  return <section className={styles.projectPanel} aria-labelledby="meeting-title">
    <div className={styles.panelHeading}><div><p className={styles.eyebrow}>TEAM MEETING</p><h2 id="meeting-title">{meeting?.endedAt ? '終了した会議' : '案件を順番に確認'}</h2></div><button disabled={busy || recordsBlocked || refreshing || finishing} onClick={back}>会議一覧に戻る</button></div>
    <div className={styles.detailBody}>
      {uncertainAction && <p role="alert">操作結果は不明です。最新の状態を取得して確認し、一度会議一覧へ戻ってから再開してください。再取得だけでは再送可能にしません。</p>}
      {!meeting && !error && <p role="status">会議を読み込んでいます…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p role="status" className={styles.success}>{notice}</p>}
      <button disabled={busy || recordsBlocked || refreshing || finishing} onClick={() => void refresh()}>最新の状態を取得</button>
      {meeting && <>
        <p className={styles.meetingCounts}>全{meeting.counts.total}件 · 確認済み{meeting.counts.confirmed}件 · 未確認{meeting.counts.unconfirmed}件</p>
        <p className={styles.help}>進捗・状態の差分あり{meeting.comparisonCounts.changed}件 · 前回記録なし{meeting.comparisonCounts.noPrevious}件{meeting.endedAt ? ` · 今回未確認${meeting.comparisonCounts.unconfirmed}件` : ''}。差分は{meeting.endedAt ? 'この会議の確認時の値' : '現在値'}と比較します。</p>
        <p>進行役：{meeting.facilitator?.name ?? '指定なし'}{!meeting.endedAt && !meeting.canOperate ? '（確認操作は進行役が行います）' : ''}</p>
        {!meeting.endedAt && <><div className={styles.editField}><label htmlFor="change-facilitator">進行役の変更</label><select id="change-facilitator" disabled={busy || recordsBlocked || refreshing || finishing || !meeting.canOperate || uncertainAction} value={facilitator} onChange={e => setFacilitator(e.target.value)}><option value="__keep">変更先を選んでください</option><option value="">指定しない</option>{memberChoices}</select></div>{memberFeedback}<button disabled={busy || recordsBlocked || refreshing || finishing || !meeting.canOperate || uncertainAction || facilitator === '__keep'} onClick={() => void act('facilitator', { facilitatorUserId: facilitator || null })}>進行役を変更</button></>}
        <div className={styles.editField}><label htmlFor="meeting-entry">確認する案件（自分の画面だけ切り替わります）</label><select id="meeting-entry" value={entryId} disabled={busy || recordsBlocked || refreshing || finishing} onChange={e => { if (confirmNavigation()) setEntryId(e.target.value); }}>{meeting.entries.map((item, i) => <option key={item.id} value={item.id}>{i + 1}. {item.project.name} · {item.confirmation ? '確認済み' : '未確認'} · {comparisonLabel(item)}</option>)}</select></div>
        {entry && <article className={styles.meetingCard} aria-labelledby="meeting-project-title">
          <p className={styles.eyebrow}>{index + 1} / {meeting.counts.total}</p><h3 id="meeting-project-title" ref={heading} tabIndex={-1}>{entry.project.name}</h3>
          <p>主担当：{entry.project.primaryName} · 納期：{entry.project.dueDate}</p>
          {entry.project.archived && <p className={styles.notice}>会議開始後に保管された案件です。この会議の対象記録には残ります。</p>}
          <ProgressComparison entry={entry} />
          <MeetingRecords key={entry.id} teamId={teamId} meetingId={meetingId} entryId={entry.id} ended={Boolean(meeting.endedAt)} memberChoices={memberChoices} memberFeedback={memberFeedback} changed={refresh} blockedChanged={recordBlockChanged} signedOut={signedOut} openSource={openSource} />
          {meeting.endedAt && <p>現在の案件（会議後の更新を含む）：<strong>{entry.project.progress}％</strong> · {statusLabels[entry.project.status]}</p>}
          {entry.confirmation ? <p className={styles.success}>確認時：{entry.confirmation.progress}％ · {statusLabels[entry.confirmation.status]}<br />{dateLabel(entry.confirmation.confirmedAt)} · {entry.confirmation.confirmedByNameSnapshot}</p> : <p>この会議では未確認です。</p>}
          {!meeting.endedAt && <button className={styles.primary} disabled={busy || recordsBlocked || refreshing || finishing || !meeting.canOperate || uncertainAction} onClick={() => void act(entry.confirmation ? 'unconfirm' : 'confirm', { entryId: entry.id })}>{entry.confirmation ? '確認を取り消す' : '確認済みにして次へ'}</button>}
          {entry.auditCount > 1 && <p className={styles.help}>取消前の確認記録も保持されています。</p>}
        </article>}
        <div className={styles.createActions}><button disabled={busy || recordsBlocked || refreshing || finishing || index <= 0} onClick={() => { if (confirmNavigation()) setEntryId(meeting.entries[index - 1].id); }}>前の案件</button><button disabled={busy || recordsBlocked || refreshing || finishing || index >= meeting.entries.length - 1} onClick={() => { if (confirmNavigation()) setEntryId(meeting.entries[index + 1].id); }}>次の案件</button></div>
        {!meeting.endedAt && !finishing && <div className={styles.createActions}><button disabled={busy || recordsBlocked || refreshing || !meeting.canOperate || uncertainAction} onClick={() => { if (confirmNavigation()) setFinishing(true); }}>会議を終了する</button></div>}
        {finishing && <div className={styles.reviewPanel} role="alertdialog" aria-modal="false" aria-labelledby="finish-meeting-title" onKeyDown={e => { if (e.key === 'Escape' && !busy) setFinishing(false); }}><h3 id="finish-meeting-title">未確認{meeting.counts.unconfirmed}件で終了しますか？</h3><p>確認記録を残して終了します。終了後は確認・取消・進行役を変更できません。</p>
          {!!meeting.counts.unconfirmed && <ul className={styles.remainingProjects}>{meeting.entries.filter(item => !item.confirmation).map(item => <li key={item.id}>{item.project.name}</li>)}</ul>}
          <div className={styles.createActions}><button ref={cancelFinish} disabled={busy} onClick={() => setFinishing(false)}>会議に戻る</button><button disabled={busy || recordsBlocked || refreshing || !meeting.canOperate || uncertainAction} onClick={() => void act('finish', { allowUnconfirmed: meeting.counts.unconfirmed > 0 })}>記録を残して終了</button></div></div>}
        {meeting.endedAt && <p className={styles.notice}>{dateLabel(meeting.endedAt)}に終了。確認時の値は保存済みです。上の「現在」の値はその後の更新も反映します。</p>}
        <p className={styles.help}>10秒ごとに自動更新。案件の選択と進行役の入力は自分の画面に保持します。</p>
      </>}
    </div>
  </section>;
}
