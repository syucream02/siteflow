import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "./generated/integrated/client.ts";
import { readPublicApiSettings } from "./public-api-settings.ts";
import { startApiServer } from "./api-server.ts";
import { publicDatabaseOptions } from "./public-database.ts";

type DatabaseOptions = Exclude<ConstructorParameters<typeof PrismaMariaDb>[0], string>;
function createDatabase(options: DatabaseOptions) {
  return new PrismaClient({ adapter: new PrismaMariaDb(options) });
}
// テスト時も設定検査は必ず通す。依存の差替えはサーバー内部からだけ行う。
type Dependencies = { createDatabase: typeof createDatabase; startServer: typeof startApiServer };

export async function startPublicApiServer(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: Dependencies = { createDatabase, startServer: startApiServer },
) {
  // クライアント作成やlistenより先に検査する。ここでの項目名エラーはそのまま返す。
  const settings = readPublicApiSettings(env);
  try {
    const prisma = dependencies.createDatabase(publicDatabaseOptions(settings));
    return await dependencies.startServer({
      prisma, authSecret: settings.authSecret, publicOrigin: settings.publicOrigin,
      secureCookies: true, port: 5175,
    });
  } catch {
    // DB作成時も含め、設定値・ライブラリの例外・causeを出さない。
    throw new Error("公開APIを起動できません。接続設定とDBの状態を確認してください。");
  }
}
