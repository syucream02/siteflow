import { publicProxyOrigin, loopbackApiOrigin } from './proxy-origins.ts';
import { proxyLocalApi } from './local-api.ts';
import { proxyPublicApi } from './public-api-proxy.ts';
import { proxyReply } from './api-proxy.ts';
import { integratedOrigin } from './integrated-api.ts';
import { readPublicApiSettings } from '../../examples/mysql/public-api-settings.ts';

type Environment = Readonly<Record<string, string | undefined>>;
export type WorkspaceConnection = { mode: 'disabled' | 'invalid' | 'local' }
  | { mode: 'integrated'; localOrigin: string }
  | { mode: 'public-integrated'; publicOrigin: string }
  | { mode: 'public'; publicOrigin: string; backendOrigin: string };

// 画面とAPIで同じ判定を使う。公開モードの誤設定をローカル接続へ戻さない。
export function readWorkspaceConnection(env: Environment): WorkspaceConnection {
  const mode = env.SITEFLOW_WORKSPACE_MODE;
  if (mode === 'disabled') return { mode: 'disabled' };
  if (mode === undefined) return { mode: env.NODE_ENV === 'development' ? 'local' : 'disabled' };
  if (mode === 'local') return { mode: env.NODE_ENV === 'development' ? 'local' : 'invalid' };
  if (mode === 'integrated') {
    const origin = integratedOrigin(env);
    return origin ? { mode: 'integrated', localOrigin: origin.origin } : { mode: 'invalid' };
  }
  if (mode === 'public-integrated') {
    try { return { mode: 'public-integrated', publicOrigin: readPublicApiSettings(env).publicOrigin }; }
    catch { return { mode: 'invalid' }; }
  }
  if (mode !== 'public') return { mode: 'invalid' };
  const origin = publicProxyOrigin(env.SITEFLOW_PUBLIC_ORIGIN);
  const backend = loopbackApiOrigin(env.SITEFLOW_PUBLIC_API_ORIGIN);
  if (!origin || !backend) return { mode: 'invalid' };
  return { mode: 'public', publicOrigin: origin.origin, backendOrigin: backend.origin };
}

export function workspacePageEnabled(connection: WorkspaceConnection, host: string | null): boolean {
  return connection.mode === 'local'
    || connection.mode === 'integrated' && host === new URL(connection.localOrigin).host
    || (connection.mode === 'public' || connection.mode === 'public-integrated') && host === new URL(connection.publicOrigin).host;
}

export async function proxyWorkspaceApi(request: Request, path: readonly string[], env: Environment, fetcher?: typeof fetch): Promise<Response> {
  const connection = readWorkspaceConnection(env);
  if (connection.mode === 'disabled') return proxyReply(404, 'NOT_FOUND', 'この接続は有効になっていません。');
  if (connection.mode === 'invalid') return proxyReply(503, 'WORKSPACE_NOT_CONFIGURED', '接続の準備ができていません。');
  if (connection.mode === 'integrated') return proxyReply(503, 'INTEGRATED_ENTRY_REQUIRED', '統合APIの入口から接続してください。');
  if (connection.mode === 'public-integrated') return proxyReply(503, 'INTEGRATED_ENTRY_REQUIRED', '統合APIの入口から接続してください。');
  if (connection.mode === 'public') return proxyPublicApi(request, path, { enabled: true, publicOrigin: connection.publicOrigin, backendOrigin: connection.backendOrigin, fetcher });
  return proxyLocalApi(request, path, { environment: env.NODE_ENV, backendOrigin: env.SITEFLOW_LOCAL_API_ORIGIN, fetcher });
}
