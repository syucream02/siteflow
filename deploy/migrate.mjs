import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../examples/mysql/generated/integrated/client.ts';
import { readPublicApiSettings } from '../examples/mysql/public-api-settings.ts';
import { publicDatabaseOptions } from '../examples/mysql/public-database.ts';
import { schemaHash } from './schema-hash.mjs';
import { readSecretSetting } from '../examples/mysql/secret-files.ts';

export function migrationSettings(env) {
  if (env.SITEFLOW_MIGRATION_APPROVED !== 'yes') throw Error('MIGRATION_APPROVAL_REQUIRED');
  if (!/^sha256:[a-f0-9]{64}$/.test(env.SITEFLOW_MIGRATION_DIGEST ?? '')) throw Error('MIGRATION_DIGEST_REQUIRED');
  const user = env.SITEFLOW_MIGRATION_USER;
  if (!/^sf_migrate_[a-z0-9_]+$/.test(user ?? '') || user === env.SITEFLOW_DB_USER) throw Error('MIGRATION_USER_REQUIRED');
  const settings = readPublicApiSettings({ ...env, SITEFLOW_DB_PASSWORD_FILE: undefined, SITEFLOW_DB_USER: user, SITEFLOW_DB_PASSWORD: readSecretSetting(env, 'SITEFLOW_MIGRATION_PASSWORD') });
  if (!settings.database.caFile) throw Error('MIGRATION_CA_REQUIRED');
  const url = new URL('mysql://localhost');
  url.hostname = settings.database.host; url.port = String(settings.database.port);
  url.username = user; url.password = settings.database.password; url.pathname = '/' + settings.database.name;
  url.searchParams.set('sslcert', settings.database.caFile);
  url.searchParams.set('sslaccept', 'strict');
  return { settings, url: url.href };
}

async function main() {
  let prisma;
  try {
    const { settings, url } = migrationSettings(process.env);
    prisma = new PrismaClient({ adapter: new PrismaMariaDb(publicDatabaseOptions(settings)) });
    // CLIより先にCAと接続先名を実接続で確認する。無効ならSQLを適用しない。
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$disconnect();
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', 'deploy/prisma-public.config.ts'], {
      env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', SITEFLOW_MIGRATION_URL: url }, stdio: 'pipe', windowsHide: true, timeout: 120000,
    });
    if (result.status !== 0) throw Error('MIGRATION_DEPLOY_FAILED');
    const difference = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'db/design/integrated.prisma', '--exit-code', '--config', 'deploy/prisma-public.config.ts'], {
      env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', SITEFLOW_MIGRATION_URL: url }, stdio: 'pipe', windowsHide: true, timeout: 120000,
    });
    if (difference.status !== 0) throw Error('DATABASE_SCHEMA_DRIFT');
    const applied = await prisma.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
    const expected = fs.readdirSync('db/design/migrations', { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort();
    if (JSON.stringify(applied.map(item => item.migration_name)) !== JSON.stringify(expected)) throw Error('MIGRATION_HISTORY_MISMATCH');
    await prisma.meeting.findFirst({ select: { id: true } });
    console.log(JSON.stringify({ schemaVersion: 1, verified: true, verifiedAt: new Date().toISOString(), migrationDigest: process.env.SITEFLOW_MIGRATION_DIGEST,
      databaseName: settings.database.name, databaseHost: settings.database.host,
      caSha256: createHash('sha256').update(fs.readFileSync(settings.database.caFile)).digest('hex'), schemaHash:schemaHash(), appliedMigrations: expected }));
  } catch {
    // Prismaエラーには接続文字列やSQLが含まれ得る。生の標準出力も転記しない。
    console.error('MIGRATION_FAILED_CHECK_PRIVATE_SETTINGS'); process.exitCode = 1;
  } finally { await prisma?.$disconnect().catch(() => {}); }
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/deploy/migrate.mjs') || process.argv[1] === 'deploy/migrate.mjs') await main();
