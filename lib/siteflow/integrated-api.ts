import { proxyReply } from './api-proxy.ts';

type Environment = Readonly<Record<string, string | undefined>>;

export async function browserAuthResponse(upstream: Response, pathname: string): Promise<Response> {
  let data: unknown = await upstream.json();
  if (pathname.endsWith('/get-session')) {
    const user = typeof data === 'object' && data !== null && 'user' in data ? data.user : null;
    data = typeof user === 'object' && user !== null && 'id' in user && typeof user.id === 'string'
      && 'name' in user && typeof user.name === 'string' && 'email' in user && typeof user.email === 'string'
      ? { user: { id: user.id, name: user.name, email: user.email } } : null;
  } else if (pathname.endsWith('/sign-in/email')) {
    data = upstream.ok ? { ok: true } : { code: 'SIGN_IN_FAILED', message: 'ログインできませんでした。入力を確認してください。' };
  }
  const headers = new Headers(upstream.headers); headers.delete('content-length');
  return Response.json(data, { status: upstream.status, headers });
}

// 今回の統合はPC内だけで明示的に試す。本番公開には別の設定・検証が必要。
export function integratedOrigin(env: Environment): URL | null {
  try {
    const origin = new URL(env.SITEFLOW_INTEGRATED_ORIGIN ?? '');
    if (env.NODE_ENV !== 'development' || env.SITEFLOW_WORKSPACE_MODE !== 'integrated'
      || origin.origin !== env.SITEFLOW_INTEGRATED_ORIGIN || origin.protocol !== 'http:'
      || !['127.0.0.1', 'localhost'].includes(origin.hostname) || !origin.port) return null;
    return origin;
  } catch { return null; }
}

export async function handleIntegratedApi(request: Request, env: Environment,
  load: () => Promise<(request: Request) => Promise<Response>>): Promise<Response> {
  const origin = integratedOrigin(env);
  if (!origin) return proxyReply(503, 'INTEGRATED_NOT_CONFIGURED', 'ローカル統合モードの設定を確認してください。');
  const incoming = new URL(request.url);
  // Next.jsは127.0.0.1宛の要求をlocalhostの内部URLに組み立てる場合がある。
  // 受信Hostは固定設定と完全一致させ、内部URLもPC内・同一ポートだけ許可する。
  if (request.headers.get('host') !== origin.host || incoming.protocol !== origin.protocol
    || !['127.0.0.1', 'localhost'].includes(incoming.hostname) || incoming.port !== origin.port) {
    return proxyReply(403, 'INVALID_HOST', '接続元を確認してください。');
  }
  if ((request.method !== 'GET' && request.headers.get('origin') !== origin.origin)
    || (request.headers.has('origin') && request.headers.get('origin') !== origin.origin)
    || request.headers.get('sec-fetch-site') === 'cross-site') return proxyReply(403, 'INVALID_ORIGIN', '同じ画面から操作し直してください。');
  try { return await (await load())(request); }
  catch { return proxyReply(503, 'INTEGRATED_UNAVAILABLE', '接続できません。ローカルMySQLと設定を確認してください。'); }
}
