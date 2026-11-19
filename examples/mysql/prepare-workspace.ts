import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/integrated/client.ts';
import { readSchemaCheckSettings } from './schema-check-settings.mjs';
import { createLocalWorkspaceData, removeLocalWorkspaceData } from './local-workspace-data.ts';

const accountFile = new URL('../../.env.workspace.local', import.meta.url);
const settings = readSchemaCheckSettings();
const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ host: '127.0.0.1', port: settings.port, user: settings.user, password: settings.password, database: settings.database, connectionLimit: 2 }) });
try {
  let existing: string | undefined;
  try { existing = await readFile(accountFile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing !== undefined) {
    const saved = parseEnv(existing);
    const user = saved.SITEFLOW_WORKSPACE_USER_ID ? await prisma.user.findUnique({ where: { id: saved.SITEFLOW_WORKSPACE_USER_ID }, select: { email: true } }) : null;
    if (!user || user.email !== saved.SITEFLOW_WORKSPACE_EMAIL || saved.SITEFLOW_WORKSPACE_DATABASE !== settings.database) throw new Error('Local account settings mismatch');
    console.info('準備済みです。ログイン情報は .env.workspace.local で確認できます。');
  } else {
    const data = await createLocalWorkspaceData(prisma);
    try {
      await writeFile(accountFile, `# ローカル体験用。Gitや文書へ転記しないでください。\nSITEFLOW_WORKSPACE_USER_ID=${data.userId}\nSITEFLOW_WORKSPACE_EMAIL=${data.email}\nSITEFLOW_WORKSPACE_PASSWORD=${data.password}\nSITEFLOW_WORKSPACE_DATABASE=${settings.database}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) { await removeLocalWorkspaceData(prisma, data); throw error; }
    console.info('専用DBに架空アカウント・2チーム・21案件を準備しました。ログイン情報は .env.workspace.local に保存しました。');
  }
} catch {
  console.error('準備できませんでした。MySQLと専用設定、既存の .env.workspace.local を確認してください。'); process.exitCode = 1;
} finally { await prisma.$disconnect(); }
