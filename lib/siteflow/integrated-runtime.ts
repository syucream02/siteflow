import { randomBytes } from 'node:crypto';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../../examples/mysql/generated/integrated/client.ts';
import { readSchemaCheckConnectionOptions } from '../../examples/mysql/schema-check-settings.mjs';
import { integratedOrigin } from './integrated-api.ts';
import { createIntegratedHandler } from './integrated-handler.ts';

type Runtime = { origin: string; handle: ReturnType<typeof createIntegratedHandler> };
const shared = globalThis as typeof globalThis & { siteflowIntegratedRuntime?: Runtime };

export function getIntegratedHandler() {
  const origin = integratedOrigin(process.env);
  if (!origin) throw new Error('INTEGRATED_NOT_CONFIGURED');
  if (shared.siteflowIntegratedRuntime) {
    if (shared.siteflowIntegratedRuntime.origin !== origin.origin) throw new Error('RESTART_REQUIRED');
    return shared.siteflowIntegratedRuntime.handle;
  }
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb({
    ...readSchemaCheckConnectionOptions(),
    connectionLimit: 2, connectTimeout: 5000, acquireTimeout: 5000,
  }) });
  // HMRで接続プールやsecretを作り直さない。開発プロセス終了後の再ログインは必要。
  const handle = createIntegratedHandler(prisma, origin.origin, randomBytes(32).toString('hex'), false);
  shared.siteflowIntegratedRuntime = { origin: origin.origin, handle };
  return handle;
}
