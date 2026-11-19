import { readPublicApiSettings } from '../../examples/mysql/public-api-settings.ts';
import { proxyReply } from './api-proxy.ts';

type Environment = Readonly<Record<string, string | undefined>>;

export async function handlePublicIntegratedApi(request: Request, env: Environment,
  load: () => Promise<(request: Request) => Promise<Response>>): Promise<Response> {
  let origin: URL;
  try {
    if (env.SITEFLOW_WORKSPACE_MODE !== 'public-integrated') throw new Error('DISABLED');
    origin = new URL(readPublicApiSettings(env).publicOrigin);
  } catch { return proxyReply(503, 'PUBLIC_INTEGRATED_NOT_CONFIGURED', '公開接続の設定を確認してください。'); }
  const incoming = new URL(request.url);
  // standaloneサーバーが0.0.0.0で待ち受けると、Next.jsの内部URLもその名前になる。
  // 受信Hostの完全一致に加え、Dockerで固定した内部アドレスとポートだけ許可する。
  const standaloneInternal = env.HOSTNAME === '0.0.0.0' && env.PORT === '3000'
    && incoming.hostname === '0.0.0.0' && incoming.port === '3000'
    && ['http:', 'https:'].includes(incoming.protocol);
  if (request.headers.get('host') !== origin.host || !(incoming.origin === origin.origin
    || standaloneInternal || ['localhost','127.0.0.1'].includes(incoming.hostname) && ['http:','https:'].includes(incoming.protocol))) return proxyReply(403, 'INVALID_HOST', '接続元を確認してください。');
  if ((request.method !== 'GET' && request.headers.get('origin') !== origin.origin)
    || (request.headers.has('origin') && request.headers.get('origin') !== origin.origin)
    || request.headers.get('sec-fetch-site') === 'cross-site') return proxyReply(403, 'INVALID_ORIGIN', '同じ画面から操作し直してください。');
  try { return await (await load())(request); }
  catch { return proxyReply(503, 'PUBLIC_INTEGRATED_UNAVAILABLE', 'DBの接続と証明書を確認してください。'); }
}
