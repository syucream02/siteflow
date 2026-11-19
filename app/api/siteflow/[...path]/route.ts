import { proxyWorkspaceApi } from '@/lib/siteflow/workspace-connection';
import { handleIntegratedApi } from '@/lib/siteflow/integrated-api';
import { handlePublicIntegratedApi } from '@/lib/siteflow/public-integrated-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  if (process.env.SITEFLOW_WORKSPACE_MODE === 'public-integrated') return handlePublicIntegratedApi(request, process.env, async () => {
    const { getPublicIntegratedHandler } = await import('@/lib/siteflow/public-integrated-runtime');
    return getPublicIntegratedHandler();
  });
  if (process.env.SITEFLOW_WORKSPACE_MODE === 'integrated') return handleIntegratedApi(request, process.env, async () => {
    const { getIntegratedHandler } = await import('@/lib/siteflow/integrated-runtime');
    return getIntegratedHandler();
  });
  const { path } = await context.params;
  return proxyWorkspaceApi(request, path, process.env);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
