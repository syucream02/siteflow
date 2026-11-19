import { defineConfig } from 'prisma/config';
import path from 'node:path';

// URLはmigrate.mjsがTLS接続検証後に子プロセスへ渡す。実値を出力しない。
if (!process.env.SITEFLOW_MIGRATION_URL) throw new Error('MIGRATION_URL_REQUIRED');
export default defineConfig({
  schema: path.resolve('db/design/integrated.prisma'),
  migrations: { path: path.resolve('db/design/migrations') },
  datasource: { url: process.env.SITEFLOW_MIGRATION_URL },
});
