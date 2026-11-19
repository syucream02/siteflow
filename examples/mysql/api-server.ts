import { createServer, type RequestListener } from "node:http";
import { createSiteflowAuth } from "./auth.ts";
import type { PrismaClient } from "./generated/integrated/client.ts";
import { createApiRequestHandler } from "./api-handler.ts";

export type ApiServerOptions = {
  prisma: PrismaClient;
  authSecret: string;
  publicOrigin?: string;
  secureCookies: boolean;
  port: number;
};

// 設定の検査とDBクライアント作成は呼出元で行い、ここは起動/停止を管理する。
export async function startApiServer({ prisma, authSecret, publicOrigin, secureCookies, port }: ApiServerOptions) {
  let handler: RequestListener | undefined;
  const server = createServer((req, res) => {
    if (!handler) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ code: "API_STARTING", message: "APIを準備しています。" }));
      return;
    }
    handler(req, res);
  });
  const closeServer = async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  };
  try {
    await prisma.$connect();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("API_STARTUP_FAILED");
    const origin = `http://127.0.0.1:${address.port}`;
    const authOrigin = publicOrigin ?? origin;
    const auth = createSiteflowAuth(prisma, authOrigin, authSecret, secureCookies);
    handler = createApiRequestHandler({ prisma, origin: authOrigin, host: new URL(origin).host, authHandler: request => auth.handler(request), getSession: headers => auth.api.getSession({ headers }) });
    let closing: Promise<void> | undefined;
    return {
      origin, prisma,
      close() {
        closing ??= (async () => { try { await closeServer(); } finally { await prisma.$disconnect(); } })();
        return closing;
      },
    };
  } catch {
    try { await closeServer(); } catch { /* 起動例外の詳細を外へ出さない。 */ }
    try { await prisma.$disconnect(); } catch { /* 接続設定を含む例外を外へ出さない。 */ }
    throw new Error("APIを起動できません。接続設定とDBの状態を確認してください。");
  }
}
