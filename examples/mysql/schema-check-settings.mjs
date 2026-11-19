import { readFileSync } from "node:fs";
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from "node:util";

// new URL(..., import.meta.url)で.envをアセットにせず、実行時にルートを解決する。
export function findWorkspaceRoot(start = process.cwd()) {
  let directory = path.resolve(start);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === 'site-creator-vinext-starter') return directory;
    } catch { /* 配下から上へ探す。秘密値はエラーへ含めない。 */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('SiteFlowの作業フォルダーから実行してください。');
    directory = parent;
  }
}
const root = findWorkspaceRoot();
export const schemaCheckEnvPath = pathToFileURL(path.join(root, '.env.schema-check.local'));
function requireLocalSettings() {
  if (process.env.NODE_ENV === 'production') throw new Error('本番ではローカル設定を読み込めません。');
}

export function readDevelopmentSettings() {
  requireLocalSettings();
  return parseEnv(readFileSync(path.join(root, '.env.mysql.local'), 'utf8'));
}

// 接続先はこのPCの検証専用DBだけ。既存DB・既存ユーザーとの一致も拒否する。
export function readSchemaCheckSettings() {
  requireLocalSettings();
  const values = parseEnv(readFileSync(schemaCheckEnvPath, "utf8"));
  const development = readDevelopmentSettings();
  const database = values.SCHEMA_CHECK_DATABASE;
  const user = values.SCHEMA_CHECK_USER;
  const password = values.SCHEMA_CHECK_PASSWORD;
  const port = Number(values.SCHEMA_CHECK_PORT);
  if (!database || !/^siteflow_check_[a-z0-9]+_[a-f0-9]{8}$/.test(database) || database.length > 64) {
    throw new Error("検証専用DB名ではありません。");
  }
  if (!user || !/^sfcheck_[a-f0-9]{8}$/.test(user)) {
    throw new Error("検証専用ユーザー名ではありません。");
  }
  if (!password || !/^[a-f0-9]{48}$/.test(password)) {
    throw new Error("検証用の接続設定が不正です。");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port !== Number(development.MYSQL_PORT ?? "3307")) {
    throw new Error("開発用MySQLのポートと一致しません。");
  }
  if (database === development.MYSQL_DATABASE || user === development.MYSQL_USER) {
    throw new Error("既存の開発用DB・ユーザーは検証先にできません。");
  }
  return { database, user, password, port };
}
