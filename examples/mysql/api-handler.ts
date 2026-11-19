import type { RequestListener } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import { createWebApiHandler } from "./web-api-handler.ts";

// 検証用NodeサーバーとNext.jsで受付・業務処理を共有する。
export function createApiRequestHandler(dependencies: Parameters<typeof createWebApiHandler>[0]): RequestListener {
  const handle = createWebApiHandler(dependencies);
  return async (req, res) => {
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : new ReadableStream<Uint8Array>({
        start(controller) {
          req.on("data", chunk => controller.enqueue(new Uint8Array(chunk)));
          req.once("end", () => controller.close());
          req.once("error", () => controller.error(new Error("REQUEST_FAILED")));
          req.once("aborted", () => controller.error(new Error("REQUEST_ABORTED")));
        },
        // 過大な本文は保存せず読み流し、413応答前にソケットを壊さない。
        cancel() { req.removeAllListeners("data"); req.removeAllListeners("end"); req.removeAllListeners("aborted"); req.resume(); },
      });
      const init: RequestInit & { duplex?: "half" } = { method: req.method, headers: fromNodeHeaders(req.headers), body, ...(body ? { duplex: "half" } : {}) };
      const response = await handle(new Request(new URL(req.url ?? "/", dependencies.origin), init));
      response.headers.forEach((value, key) => { if (key !== "set-cookie") res.setHeader(key, value); });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("Set-Cookie", cookies);
      res.writeHead(response.status);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ code: "AUTH_CHECK_FAILED" }));
    }
  };
}
