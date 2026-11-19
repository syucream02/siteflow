import { loopbackApiOrigin } from './proxy-origins.ts';

type ProxyPolicy = {
  browserOrigin: string; backendOrigin?: string; fetcher?: typeof fetch;
  upstreamOrigin?: string; cookieHeader: string | null;
  responseCookie: (cookie: string) => string; mode: 'local' | 'public';
};
const teamId = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

export function proxyReply(status: number, code: string, message: string) {
  return Response.json({ code, message }, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Cookie' } });
}

export async function proxyApiRequest(request: Request, path: readonly string[], config: ProxyPolicy): Promise<Response> {
  const incoming = new URL(request.url);
  const browserOrigin = config.browserOrigin;
  const route = path.join('/');
  const projectCollection = new RegExp(`^teams/${teamId}/projects$`, 'i').test(route);
  const detail = new RegExp(`^teams/${teamId}/projects/${teamId}$`, 'i').test(route);
  const allowed = route === 'auth/sign-in/email' || route === 'auth/sign-out' ? ['POST']
    : projectCollection ? ['GET', 'POST'] : detail ? ['GET', 'PATCH']
    : new RegExp(`^teams/${teamId}/projects/${teamId}/assignees$`, 'i').test(route) ? ['PUT']
    : new RegExp(`^teams/${teamId}/projects/${teamId}/(?:progress|status)$`, 'i').test(route) ? ['PATCH']
    : new RegExp(`^teams/${teamId}/projects/${teamId}/(?:archive|restore)$`, 'i').test(route) ? ['POST']
    : new RegExp(`^teams/${teamId}/archived-projects/${teamId}$`, 'i').test(route) ? ['GET']
    : route === 'auth/get-session' || route === 'teams'
      || new RegExp(`^teams/${teamId}/(?:projects|archived-projects|members)$`, 'i').test(route)
      || new RegExp(`^teams/${teamId}/(?:projects|archived-projects)/${teamId}/(?:support-members|progress-history|assignment-history)$`, 'i').test(route) ? ['GET'] : null;
  if (!allowed) return proxyReply(404, 'NOT_FOUND', 'この操作にはまだ接続していません。');
  if (!allowed.includes(request.method)) {
    const response = proxyReply(405, 'METHOD_NOT_ALLOWED', 'この操作は許可されていません。'); response.headers.set('Allow', allowed.join(', ')); return response;
  }
  const method = request.method;
  const writing = method !== 'GET';
  const origin = request.headers.get('origin');
  if ((writing && origin !== browserOrigin) || (origin !== null && origin !== browserOrigin)
    || request.headers.get('sec-fetch-site') === 'cross-site') return proxyReply(403, 'INVALID_ORIGIN', '同じ画面から操作し直してください。');
  const backend = loopbackApiOrigin(config.backendOrigin);
  if (!backend) return proxyReply(503, config.mode === 'public' ? 'PUBLIC_API_NOT_CONFIGURED' : 'LOCAL_API_NOT_CONFIGURED', '接続設定が未完了です。接続の起動手順を確認してください。');
  const headers = new Headers({ Accept: 'application/json' });
  if (config.cookieHeader) headers.set('Cookie', config.cookieHeader);
  let body: string | undefined;
  if (writing) {
    const maxBytes = route.startsWith('teams/') ? 32768 : 4096;
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return proxyReply(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSONで送信してください。');
    const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      if (reader) while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) { await reader.cancel(); return proxyReply(413, 'BODY_TOO_LARGE', '入力が長すぎます。'); }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      body = new TextDecoder().decode(bytes); JSON.parse(body);
    } catch { return proxyReply(400, 'INVALID_JSON', '送信内容を確認してください。'); }
    headers.set('Content-Type', 'application/json'); headers.set('Origin', config.upstreamOrigin ?? backend.origin);
  }
  try {
    const upstream = await (config.fetcher ?? fetch)(`${backend.origin}/api/${route}${incoming.search}`, {
      method, headers, body, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!upstream.headers.get('content-type')?.includes('application/json') || upstream.status >= 500) throw new Error('upstream unavailable');
    let data: unknown = await upstream.json();
    // 認証の秘密値を画面へ返さず、CookieはHttpOnlyのまま中継する。
    if (route === 'auth/get-session') {
      const user = (data as { user?: { id?: string; name?: string; email?: string } } | null)?.user;
      data = user ? { user: { id: user.id, name: user.name, email: user.email } } : null;
    } else if (route === 'auth/sign-in/email') {
      data = upstream.ok ? { ok: true } : { code: 'SIGN_IN_FAILED', message: 'ログインできませんでした。メールアドレスとパスワードを確認してください。' };
    }
    const response = Response.json(data, { status: upstream.status, headers: { 'Cache-Control': 'no-store', Vary: 'Cookie' } });
    const cookies = upstream.headers.getSetCookie().map(config.responseCookie);
    for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
    return response;
  } catch { return proxyReply(503, config.mode === 'public' ? 'PUBLIC_API_UNAVAILABLE' : 'LOCAL_API_UNAVAILABLE', 'APIに接続できません。起動を確認して、もう一度お試しください。'); }
}
