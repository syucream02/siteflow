import { defineConfig } from 'prisma/config';
import { backupRunSettings } from './backup-check-settings.mjs';
import { readDevelopmentSettings } from './schema-check-settings.mjs';

// 検証スクリプトの子プロセスだけから渡される、一時DB専用の設定。
const settings = backupRunSettings(process.env, Number(readDevelopmentSettings().MYSQL_PORT ?? '3307'));
const stage = process.env.SITEFLOW_BACKUP_STAGE;
if (stage !== 'source' && stage !== 'restore') throw new Error('INVALID_BACKUP_STAGE');
const database = stage === 'source' ? settings.source : settings.restore;

export default defineConfig({
  schema: '../../db/design/integrated.prisma',
  migrations: { path: '../../db/design/migrations' },
  datasource: { url: `mysql://${settings.user}:${settings.password}@127.0.0.1:${settings.port}/${database}` },
});
