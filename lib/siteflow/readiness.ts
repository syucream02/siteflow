import { readPublicApiSettings } from '../../examples/mysql/public-api-settings.ts';

// データや接続設定を返さず、準備が整っているかだけを応答する。
export async function handleReadiness(request: Request, env: Readonly<Record<string, string | undefined>>, check: () => Promise<void>) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    if (env.SITEFLOW_WORKSPACE_MODE !== 'public-integrated') throw Error('DISABLED');
    const origin = new URL(readPublicApiSettings(env).publicOrigin);
    if (request.headers.get('host') !== origin.host) throw Error('INVALID_HOST');
    await check();
    return Response.json({ ok: true }, { headers });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
