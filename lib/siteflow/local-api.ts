import { proxyApiRequest, proxyReply } from './api-proxy.ts';

// ローカル接続確認だけに使う中継。公開環境の認証/配信設計とは分ける。
type ProxyConfig = { environment?: string; backendOrigin?: string; fetcher?: typeof fetch };
export async function proxyLocalApi(request: Request, path: readonly string[], config: ProxyConfig): Promise<Response> {
  if (config.environment !== 'development') return proxyReply(404, 'NOT_FOUND', 'この接続はローカル開発時だけ利用できます。');
  const incoming = new URL(request.url);
  if (!['127.0.0.1', 'localhost'].includes(incoming.hostname)) return proxyReply(403, 'INVALID_HOST', '接続元を確認してください。');
  // Next.js内部ではURLのホストがlocalhostになる場合がある。ブラウザーの
  // Hostを検査してからOrigin比較に使い、転送用ヘッダーは信用しない。
  let browserOrigin = incoming.origin;
  const host = request.headers.get('host');
  if (host) {
    if (!/^(?:127\.0\.0\.1|localhost)(?::[0-9]+)?$/.test(host)) return proxyReply(403, 'INVALID_HOST', '接続元を確認してください。');
    const browser = new URL(`${incoming.protocol}//${host}`);
    if (browser.port !== incoming.port) return proxyReply(403, 'INVALID_HOST', '接続元を確認してください。');
    browserOrigin = browser.origin;
  }
  return proxyApiRequest(request, path, {
    browserOrigin, backendOrigin: config.backendOrigin, fetcher: config.fetcher,
    cookieHeader: request.headers.get('cookie'), mode: 'local',
    responseCookie: cookie => cookie.replace(/;\s*Path=\/(?=;|$)/i, '; Path=/api/siteflow'),
  });
}
