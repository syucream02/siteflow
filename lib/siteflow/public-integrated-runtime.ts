import { createHash } from 'node:crypto';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../../examples/mysql/generated/integrated/client.ts';
import { readPublicApiSettings } from '../../examples/mysql/public-api-settings.ts';
import { publicDatabaseOptions } from '../../examples/mysql/public-database.ts';
import { createIntegratedHandler } from './integrated-handler.ts';

type PublicRuntime = { handle: ReturnType<typeof createIntegratedHandler>; ready: () => Promise<void> };
type Runtime = { signature: string; pending: Promise<PublicRuntime> };
const shared = globalThis as typeof globalThis & { siteflowPublicIntegratedRuntime?: Runtime };

async function getPublicRuntime() {
  if (process.env.SITEFLOW_WORKSPACE_MODE !== 'public-integrated') throw new Error('PUBLIC_INTEGRATED_DISABLED');
  const settings = readPublicApiSettings(process.env);
  const signature = createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  if (shared.siteflowPublicIntegratedRuntime) {
    if (shared.siteflowPublicIntegratedRuntime.signature !== signature) throw new Error('RESTART_REQUIRED');
    return shared.siteflowPublicIntegratedRuntime.pending;
  }
  const pending = (async () => {
    const prisma = new PrismaClient({ adapter: new PrismaMariaDb(publicDatabaseOptions(settings)) });
    try {
      await prisma.$connect();
      // driver adapterはプール生成だけでは実接続しない場合がある。TLSも含めて確認する。
      await prisma.$queryRaw`SELECT 1`;
      return { handle: createIntegratedHandler(prisma, settings.publicOrigin, settings.authSecret, true),
        ready: async () => { await prisma.$queryRaw`SELECT 1`; await prisma.meeting.findFirst({ select: { id: true } }); } };
    } catch {
      await prisma.$disconnect().catch(() => {});
      throw new Error('PUBLIC_DATABASE_UNAVAILABLE');
    }
  })();
  const runtime = { signature, pending };
  shared.siteflowPublicIntegratedRuntime = runtime;
  try { return await pending; }
  catch { if (shared.siteflowPublicIntegratedRuntime === runtime) delete shared.siteflowPublicIntegratedRuntime; throw new Error('PUBLIC_DATABASE_UNAVAILABLE'); }
}

export async function getPublicIntegratedHandler() { return (await getPublicRuntime()).handle; }
export async function checkPublicIntegratedReadiness() { await (await getPublicRuntime()).ready(); }
