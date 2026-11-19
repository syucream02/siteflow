import { handleReadiness } from '@/lib/siteflow/readiness';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleReadiness(request, process.env, async () => {
    const { checkPublicIntegratedReadiness } = await import('@/lib/siteflow/public-integrated-runtime');
    await checkPublicIntegratedReadiness();
  });
}
