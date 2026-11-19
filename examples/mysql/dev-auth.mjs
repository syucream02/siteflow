import { startAuthCheckServer } from "./auth-check.ts";

const api = await startAuthCheckServer();
console.info(`認証検証API: ${api.origin}/api/auth/get-session`);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await api.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
