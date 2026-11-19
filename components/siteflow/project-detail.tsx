'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, message, request, statusLabels, type Page, type Resource } from './workspace-api';
import styles from './connected-workspace.module.css';
import { ProjectEditor, type EditMode } from './project-editor';

type Project = {
  id: string; name: string; code: string | null; dueDate: string; progress: number; status: string;
  summary: string | null; clientName: string | null; notes: string | null;
  createdAt: string; updatedAt: string; version: number; archivedAt?: string; canArchive: boolean;
  primaryAssignee: { name: string; isCurrentMember?: boolean }; createdBy: { nameSnapshot: string };
};
type Support = { participantId: string; name: string; isCurrentMember: boolean };
type ProgressHistory = {
  id: string; changedAt: string; previousProgress: number; nextProgress: number;
  previousStatus: string; nextStatus: string; comment: string | null;
  changedBy: { nameSnapshot: string };
};
type AssignmentHistory = {
  id: string; kind: string; changedAt: string;
  previousAssignee: { nameSnapshot: string } | null; nextAssignee: { nameSnapshot: string } | null;
  changedBy: { nameSnapshot: string };
};
type Related = 'support-members' | 'progress-history' | 'assignment-history';
const relatedLabels: Record<Related, string> = { 'support-members': '副担当', 'progress-history': '進捗・状態の履歴', 'assignment-history': '担当変更の履歴' };
const assignmentLabels: Record<string, string> = { PRIMARY_CHANGE: '主担当の変更', SUPPORT_ADD: '副担当の追加', SUPPORT_REMOVE: '副担当の解除' };
const dateTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function Timestamp({ value }: { value: string }) { return <time dateTime={value}>{dateTime.format(new Date(value))}（日本時間）</time>; }

// 同じ取得状態と中止処理を、基本情報と関連一覧で再利用する。
function useRead<T>(path: string, signedOut: () => void) {
  const [resource, setResource] = useState<Resource<T>>({ phase: 'loading' });
  const [reload, setReload] = useState(0);
  const onSignedOut = useRef(signedOut);
  useEffect(() => { onSignedOut.current = signedOut; }, [signedOut]);
  useEffect(() => {
    const controller = new AbortController();
    request<T>(path, controller.signal)
      .then(value => { if (!controller.signal.aborted) setResource({ phase: 'ready', value }); })
      .catch(error => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onSignedOut.current();
        else setResource({ phase: 'error', message: message(error), status: error instanceof ApiError ? error.status : undefined });
      });
    return () => controller.abort();
  }, [path, reload]);
  const retry = () => { setResource({ phase: 'loading' }); setReload(value => value + 1); };
  return { resource, retry };
}

function ReadError({ resource, retry }: { resource: Extract<Resource<unknown>, { phase: 'error' }>; retry: () => void }) {
  return <div className={styles.feedback}><p role="alert" className={styles.error}>{resource.message}</p>
    {(resource.status === 403 || resource.status === 404) && <p>一覧へ戻り、チームと案件を確認してください。</p>}
    <button onClick={retry}>もう一度取得する</button></div>;
}

export function ProjectDetail({ teamId, projectId, signedOut, close, savingChanged, changed, archived, moved }: { teamId: string; projectId: string; signedOut: () => void; close: () => void; savingChanged: (busy: boolean) => void; changed: () => void; archived: boolean; moved: (action: 'archive' | 'restore') => void }) {
  const path = `teams/${teamId}/${archived ? 'archived-projects' : 'projects'}/${projectId}`;
  const { resource, retry } = useRead<{ project: Project }>(path, signedOut);
  const [related, setRelated] = useState<Related | null>(null);
  const [editing, setEditing] = useState<EditMode | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (!editing) title.current?.focus(); }, [editing]);
  const project = resource.phase === 'ready' ? resource.value.project : null;
  if (editing) return <ProjectEditor key={editing} teamId={teamId} projectId={projectId} mode={editing} signedOut={signedOut} cancel={() => setEditing(null)} savingChanged={savingChanged} saved={() => { setEditing(null); setRelated(null); if (editing === 'archive' || editing === 'restore') moved(editing); else { retry(); changed(); } }} />;
  return <section className={styles.projectPanel} aria-labelledby="detail-title" data-project-detail={projectId}>
    <div className={styles.panelHeading}><div><p className={styles.eyebrow}>{archived ? 'ARCHIVED PROJECT' : 'PROJECT DETAIL'}</p><h2 id="detail-title" ref={title} tabIndex={-1}>{archived ? '保管案件の詳細' : '案件詳細'}</h2></div><button onClick={close}>{archived ? '保管一覧へ戻る' : '一覧へ戻る'}</button></div>
    {resource.phase === 'loading' && <p className={styles.feedback} role="status">案件詳細を読み込んでいます…</p>}
    {resource.phase === 'error' && <ReadError resource={resource} retry={retry} />}
    {project && <div className={styles.detailBody}>
      <p className={styles.code}>{project.code ?? '番号未設定'}</p><h3 className={styles.detailName}>{project.name}</h3>
      <p className={styles.detailStatus}>{statusLabels[project.status] ?? project.status} · 進捗 {project.progress}％</p>
      <dl className={styles.detailFields}>
        <div><dt>主担当</dt><dd>{project.primaryAssignee.name}{project.primaryAssignee.isCurrentMember === false ? '（現在はチームに所属していません）' : ''}</dd></div>
        <div><dt>納期</dt><dd><time dateTime={project.dueDate}>{project.dueDate.replaceAll('-', '/')}</time></dd></div>
        <div><dt>取引先</dt><dd>{project.clientName ?? '未設定'}</dd></div>
        <div><dt>概要</dt><dd>{project.summary ?? '未設定'}</dd></div>
        <div><dt>備考</dt><dd>{project.notes ?? '未設定'}</dd></div>
        <div><dt>登録者（登録時）</dt><dd>{project.createdBy.nameSnapshot}</dd></div>
        <div><dt>登録日時</dt><dd><Timestamp value={project.createdAt} /></dd></div>
        <div><dt>更新日時</dt><dd><Timestamp value={project.updatedAt} /></dd></div>
        {archived && project.archivedAt && <div><dt>保管日時</dt><dd><Timestamp value={project.archivedAt} /></dd></div>}
      </dl>
      {archived ? <><p className={styles.notice}>保管中は閲覧専用です。状態・進捗・履歴を保持しています。編集する場合は担当を確認して復元してください。</p>{project.canArchive && <button onClick={() => setEditing('restore')}>復元する</button>}</> : <div className={styles.relatedButtons} role="group" aria-label="案件の編集"><button onClick={() => setEditing('basic')}>基本情報を編集</button><button onClick={() => setEditing('assignees')}>担当者を変更</button><button disabled={project.status === 'DONE'} onClick={() => setEditing('progress')}>進捗を更新</button><button onClick={() => setEditing('status')}>{project.status === 'DONE' ? '案件を再開' : '状態を変更'}</button>{project.canArchive && <button onClick={() => setEditing('archive')}>アーカイブする</button>}</div>}
      <p className={styles.help}>通常の編集は現在の管理者・主担当・副担当が行えます。アーカイブ・復元は管理者または主担当のみ行えます。</p>
      <div className={styles.relatedButtons} role="group" aria-label="確認する関連情報">{(Object.keys(relatedLabels) as Related[]).map(kind => <button key={kind} aria-pressed={related === kind} onClick={() => setRelated(kind)}>{relatedLabels[kind]}</button>)}</div>
      {related && <RelatedList key={related} path={`${path}/${related}`} kind={related} signedOut={signedOut} />}
    </div>}
  </section>;
}

function RelatedList({ path, kind, signedOut }: { path: string; kind: Related; signedOut: () => void }) {
  const { resource, retry } = useRead<Page<Support | ProgressHistory | AssignmentHistory>>(path, signedOut);
  const [extra, setExtra] = useState<(Support | ProgressHistory | AssignmentHistory)[]>([]);
  const [page, setPage] = useState<Page<unknown>['page'] | null>(null);
  const [busy, setBusy] = useState(false); const [moreError, setMoreError] = useState('');
  const active = useRef(true); const controller = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  async function more() {
    if (busy || resource.phase !== 'ready') return;
    const current = page ?? resource.value.page; if (!current.nextCursor) return;
    setBusy(true); setMoreError(''); controller.current = new AbortController();
    try {
      const next = await request<Page<Support | ProgressHistory | AssignmentHistory>>(path + '?cursor=' + encodeURIComponent(current.nextCursor), controller.current.signal);
      if (active.current) { setExtra(previous => [...previous, ...next.items]); setPage(next.page); }
    } catch (error) {
      if (active.current) { if (error instanceof ApiError && error.status === 401) signedOut(); else setMoreError(message(error)); }
    } finally { if (active.current) setBusy(false); }
  }
  const items = resource.phase === 'ready' ? [...resource.value.items, ...extra] : [];
  return <section className={styles.relatedPanel} aria-label={relatedLabels[kind]}>
    <h3>{relatedLabels[kind]}</h3>
    {resource.phase === 'loading' && <p role="status">関連情報を読み込んでいます…</p>}
    {resource.phase === 'error' && <ReadError resource={resource} retry={retry} />}
    {resource.phase === 'ready' && (items.length === 0 ? <p>{kind === 'support-members' ? '副担当は登録されていません。' : '履歴はまだありません。'}</p> : <>
      {kind !== 'support-members' && <p className={styles.help}>新しい順 · 名前は変更時の記録です。</p>}
      <ul className={styles.historyList}>{items.map(item => {
        if ('isCurrentMember' in item) return <li key={item.participantId} data-related-id={item.participantId}><strong>{item.name}</strong><p>{item.isCurrentMember ? '現在もチームに所属' : '現在はチームに所属していません（担当の記録を保持）'}</p></li>;
        return <li key={item.id} data-related-id={item.id}>
          <p className={styles.help}><Timestamp value={item.changedAt} /> · 変更者：{item.changedBy.nameSnapshot}</p>
          {'previousProgress' in item ? <><strong>{item.previousProgress}％ → {item.nextProgress}％</strong><p>{statusLabels[item.previousStatus] ?? item.previousStatus} → {statusLabels[item.nextStatus] ?? item.nextStatus}</p>{item.comment && <p className={styles.historyComment}>{item.comment}</p>}</>
            : <><strong>{assignmentLabels[item.kind] ?? item.kind}</strong><p>{item.previousAssignee?.nameSnapshot ?? 'なし'} → {item.nextAssignee?.nameSnapshot ?? 'なし'}</p></>}
        </li>;
      })}</ul>
      <div className={styles.listFooter}><p>{items.length}件表示中</p>{(page ?? resource.value.page).hasMore && <button onClick={more} disabled={busy}>{busy ? '読み込み中…' : '関連情報をさらに読む'}</button>}</div>
      {moreError && <><p className={styles.error} role="alert">{moreError}</p><button onClick={() => { setExtra([]); setPage(null); setMoreError(''); retry(); }}>関連情報を最初から取得する</button></>}
    </>)}
  </section>;
}
