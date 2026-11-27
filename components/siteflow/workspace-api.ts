export type Resource<T> = { phase: 'loading' } | { phase: 'error'; message: string; status?: number } | { phase: 'ready'; value: T };
export type Page<T> = { items: T[]; page: { hasMore: boolean; nextCursor: string | null } };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string,
    readonly kind: 'http' | 'network' | 'timeout' | 'parse' | 'cancelled' = 'http', readonly uncertain = false) { super(message); }
}

export function message(error: unknown) { return error instanceof ApiError ? error.message : '処理結果を確認できません。再取得して状態を確認してください。'; }
export function resultUnknown(error: unknown) { return !(error instanceof ApiError) || error.uncertain || error.status >= 500; }
export const REQUEST_TIMEOUT_MS = 15000;
let sessionGeneration = 0;
const teamGenerations = new Map<string, number>();
export function invalidateRequests(teamId?: string) {
  if (teamId) teamGenerations.set(teamId, (teamGenerations.get(teamId) ?? 0) + 1);
  else sessionGeneration++;
}
function explanation(status: number) {
  if (status === 400 || status === 422) return '入力内容が正しくありません。入力項目と条件を確認してください。';
  if (status === 401) return 'ログインの有効期限が切れました。もう一度ログインしてください。';
  if (status === 403) return 'この操作の権限がありません。所属と現在の役割を確認してください。';
  if (status === 404) return '対象を確認できません。一覧へ戻り、対象が移動・変更されていないか確認してください。';
  if (status === 409) return '他の操作で更新されています。入力は保持しています。最新版と比較してから操作してください。';
  if (status === 429) return 'リクエストが多すぎます。少し待ってから、状態を再取得してください。';
  return 'サーバーの応答を確認できません。状態を再取得してください。保存済みの可能性があるため再送しないでください。';
}

export async function request<T>(path: string, signal?: AbortSignal, body?: object, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST'): Promise<T> {
  const write = body !== undefined;
  const generation = sessionGeneration, teamId = /^teams\/([^/?]+)/.exec(path)?.[1], teamGeneration = teamId ? teamGenerations.get(teamId) ?? 0 : 0;
  const valid = () => generation === sessionGeneration && (!teamId || teamGeneration === (teamGenerations.get(teamId) ?? 0));
  const controller = new AbortController(); let timedOut = false, status = 0;
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('/api/siteflow/' + path, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin',
      ...(write ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    status = response.status;
    if (!valid() || signal?.aborted) throw new ApiError('この画面の通信を中止しました。', status, undefined, 'cancelled', write);
    // An HTML/error body must not suppress session expiration.
    if (status === 401 && !path.startsWith('auth/')) {
      invalidateRequests();
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('siteflow-session-expired'));
    }
    let data: unknown;
    try { data = await response.json(); }
    catch {
      if (signal?.aborted) throw new ApiError('この画面の通信を中止しました。', status, undefined, 'cancelled', write);
      throw new ApiError(status === 401 ? explanation(status) : '応答の形式を確認できません。状態を再取得してください。書き込みは再送しないでください。', status, undefined, timedOut ? 'timeout' : 'parse', write && (response.ok || status >= 500));
    }
    if (status === 401) throw new ApiError(path === 'auth/sign-in/email' ? 'ログインできませんでした。メールアドレスとパスワードを確認してください。' : explanation(status), status);
    if (!valid() || signal?.aborted) throw new ApiError('この画面の通信を中止しました。', status, undefined, 'cancelled', write);
    if (!response.ok) {
      const error = data as { code?: unknown } | null;
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : undefined;
      if (status === 403 && code === 'TEAM_ACCESS_DENIED' && teamId) {
        invalidateRequests(teamId);
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('siteflow-team-access-denied', { detail: teamId }));
      }
      throw new ApiError(explanation(status), status, code, 'http', write && status >= 500);
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw new ApiError('この画面の通信を中止しました。', status, undefined, 'cancelled', write);
    throw new ApiError(timedOut ? '通信が時間内に完了しませんでした。状態を確認してください。書き込みは再送しないでください。' : '通信できませんでした。接続を確認してください。書き込みは保存済みの可能性があるため、先に状態を確認してください。', status, undefined, timedOut ? 'timeout' : 'network', write);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
  }
}

export const statusLabels: Record<string, string> = { NOT_STARTED: '未着手', IN_PROGRESS: '進行中', REVIEW: '確認待ち', ON_HOLD: '保留', DONE: '完了' };
