import { proxyApiRequest, proxyReply } from './api-proxy.ts';
import { publicRequestCookies, publicResponseCookie } from './public-cookies.ts';
import { publicProxyOrigin } from './proxy-origins.ts';

type PublicProxyConfig = { enabled?: boolean; publicOrigin?: string; backendOrigin?: string; fetcher?: typeof fetch };

// Originはサーバー設定で固定し、転送ヘッダーから作らない。
export async function proxyPublicApi(request: Request, path: readonly string[], config: PublicProxyConfig): Promise<Response> {
  if (config.enabled !== true) return proxyReply(404, 'NOT_FOUND', 'この接続は有効になっていません。');
  const origin = publicProxyOrigin(config.publicOrigin);
  if (!origin) return proxyReply(503, 'PUBLIC_API_NOT_CONFIGURED', '公開接続の設定を確認してください。');
  const incoming = new URL(request.url);
  // Next.jsはTLS入口の要求をhttps表記のloopback URLに組み立てることがある。
  // 公開先の判定はこのURLのschemeや転送ヘッダーではなく、固定Originと受信Hostで行う。
  if (request.headers.get('host') !== origin.host
    || !(incoming.origin === origin.origin || ['localhost','127.0.0.1'].includes(incoming.hostname) && ['http:','https:'].includes(incoming.protocol))) {
    return proxyReply(403, 'INVALID_HOST', '接続元を確認してください。');
  }
  let cookieHeader: string | null;
  try { cookieHeader = publicRequestCookies(request.headers.get('cookie')); }
  catch { return proxyReply(400, 'INVALID_COOKIE', 'ログインし直してください。'); }
  return proxyApiRequest(request, path, {
    browserOrigin: origin.origin, backendOrigin: config.backendOrigin, fetcher: config.fetcher,
    upstreamOrigin: origin.origin,
    cookieHeader, responseCookie: publicResponseCookie, mode: 'public',
  });
}
