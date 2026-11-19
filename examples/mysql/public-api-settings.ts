import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { publicProxyOrigin } from "../../lib/siteflow/proxy-origins.ts";
import { readSecretSetting } from './secret-files.ts';

type Environment = Readonly<Record<string, string | undefined>>;
export type PublicApiSettings = {
  publicOrigin: string;
  authSecret: string;
  database: { host: string; port: number; name: string; user: string; password: string; tls: "required"; caFile?: string };
};

// 設定値や元の例外をエラーへ含めない。秘密値は正常結果にも含まれるのでログ出力しない。
export class PublicApiSettingsError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`公開APIの設定を確認してください: ${field}`);
    this.name = "PublicApiSettingsError";
    this.field = field;
  }
}

function required(env: Environment, key: string): string {
  const value = env[key];
  if (!value || !value.trim()) throw new PublicApiSettingsError(key);
  return value;
}

function isHostname(value: string): boolean {
  return value.length <= 253 && value.split(".").every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

// 呼び出すまでprocess.envを読まない。DB接続・listen・ファイル読込は行わない。
export function readPublicApiSettings(env: Environment = process.env): PublicApiSettings {
  try {
    env = { ...env, SITEFLOW_AUTH_SECRET: readSecretSetting(env, 'SITEFLOW_AUTH_SECRET'), SITEFLOW_DB_PASSWORD: readSecretSetting(env, 'SITEFLOW_DB_PASSWORD') };
  } catch { throw new PublicApiSettingsError('SECRET_FILE'); }
  const rawOrigin = required(env, "SITEFLOW_PUBLIC_ORIGIN");
  let url: URL;
  try { url = new URL(rawOrigin); }
  catch { throw new PublicApiSettingsError("SITEFLOW_PUBLIC_ORIGIN"); }
  if (rawOrigin.trim() !== rawOrigin || /[\\\s]/.test(rawOrigin) || url.protocol !== "https:"
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !publicProxyOrigin(url.origin)) {
    throw new PublicApiSettingsError("SITEFLOW_PUBLIC_ORIGIN");
  }
  const authSecret = required(env, "SITEFLOW_AUTH_SECRET");
  // 32バイトを16進数にした64文字を要求。形式だけで乱数の品質は保証できない。
  if (!/^[a-f0-9]{64}$/i.test(authSecret) || /^(.)\1+$/.test(authSecret)) {
    throw new PublicApiSettingsError("SITEFLOW_AUTH_SECRET");
  }
  const host = required(env, "SITEFLOW_DB_HOST");
  if (!isIP(host) && !isHostname(host)) throw new PublicApiSettingsError("SITEFLOW_DB_HOST");
  const rawPort = required(env, "SITEFLOW_DB_PORT");
  const port = Number(rawPort);
  if (!/^[1-9][0-9]{0,4}$/.test(rawPort) || port > 65535) throw new PublicApiSettingsError("SITEFLOW_DB_PORT");
  const name = required(env, "SITEFLOW_DB_NAME");
  // ローカル/検証DBを設定の取り違えで使わないための、このプロジェクトの命名方針。
  if (!/^siteflow_public_[a-z0-9_]+$/.test(name) || name.length > 64) throw new PublicApiSettingsError("SITEFLOW_DB_NAME");
  const user = required(env, "SITEFLOW_DB_USER");
  if (!/^[a-z0-9_]{1,32}$/i.test(user) || user.toLowerCase() === "root") throw new PublicApiSettingsError("SITEFLOW_DB_USER");
  const password = required(env, "SITEFLOW_DB_PASSWORD");
  if (password.length < 16 || password.includes("\0")) throw new PublicApiSettingsError("SITEFLOW_DB_PASSWORD");
  const tls = required(env, "SITEFLOW_DB_TLS");
  if (tls !== "required") throw new PublicApiSettingsError("SITEFLOW_DB_TLS");
  const caFile = env.SITEFLOW_DB_CA_FILE;
  if (caFile !== undefined && (!caFile || !isAbsolute(caFile) || /[\0\r\n]/.test(caFile) || caFile.length > 2048)) throw new PublicApiSettingsError("SITEFLOW_DB_CA_FILE");
  return { publicOrigin: url.origin, authSecret, database: { host, port, name, user, password, tls, ...(caFile ? { caFile } : {}) } };
}
