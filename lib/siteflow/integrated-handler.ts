import type { PrismaClient } from '../../examples/mysql/generated/integrated/client.ts';
import { createSiteflowAuth } from '../../examples/mysql/auth.ts';
import { createWebApiHandler } from '../../examples/mysql/web-api-handler.ts';
import { readJsonBody } from '../../examples/mysql/json-body.ts';
import { browserAuthResponse } from './integrated-api.ts';

// 認証・本文上限・応答をローカル/公開の統合モードで共有する。
export function createIntegratedHandler(prisma: PrismaClient, origin: string, secret: string, secureCookies: boolean) {
  const auth = createSiteflowAuth(prisma, origin, secret, secureCookies, '/api/siteflow/auth', '/api/siteflow');
  return createWebApiHandler({ prisma, origin, host: new URL(origin).host, pathPrefix: '/api/siteflow',
    getSession: headers => auth.api.getSession({ headers }),
    authHandler: async request => {
      if (request.method === 'POST') {
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return Response.json({ code: 'UNSUPPORTED_MEDIA_TYPE' }, { status: 415 });
        const body = await readJsonBody(request, 4096);
        if (body.tooLarge) return Response.json({ code: 'BODY_TOO_LARGE' }, { status: 413 });
        if (body.invalid) return Response.json({ code: 'INVALID_JSON' }, { status: 400 });
        const headers = new Headers(request.headers); headers.delete('content-length');
        request = new Request(request.url, { method: request.method, headers, body: JSON.stringify(body.value) });
      }
      return browserAuthResponse(await auth.handler(request), new URL(request.url).pathname);
    },
  });
}
