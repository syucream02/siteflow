export type Resource<T> = { phase: 'loading' } | { phase: 'error'; message: string; status?: number } | { phase: 'ready'; value: T };
export type Page<T> = { items: T[]; page: { hasMore: boolean; nextCursor: string | null } };

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function message(error: unknown) { return error instanceof Error ? error.message : '通信に失敗しました。'; }

export async function request<T>(path: string, signal?: AbortSignal, body?: object, method: 'POST' | 'PATCH' | 'PUT' = 'POST'): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/siteflow/' + path, { signal, cache: 'no-store', credentials: 'same-origin',
      ...(body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  } catch (error) { if (signal?.aborted) throw error; throw new Error('通信できませんでした。接続を確認して再試行してください。'); }
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error('応答を確認できませんでした。もう一度お試しください。'); }
  if (!response.ok) {
    const error = data as { message?: unknown } | null;
    throw new ApiError(typeof error?.message === 'string' ? error.message : '通信に失敗しました。もう一度お試しください。', response.status);
  }
  // TはAPIとの取り決め。型指定だけではJSONの実行時検証にならない。
  return data as T;
}

export const statusLabels: Record<string, string> = { NOT_STARTED: '未着手', IN_PROGRESS: '進行中', REVIEW: '確認待ち', ON_HOLD: '保留', DONE: '完了' };
