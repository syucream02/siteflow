import { fileURLToPath } from "node:url";

// --env-fileを子プロセス用のNODE_OPTIONSへ渡さず、環境変数だけ引き継ぐ。
process.loadEnvFile(fileURLToPath(new URL("../../.env.mysql.local", import.meta.url)));
const cli = new URL("../../node_modules/next/dist/bin/next", import.meta.url);
process.argv = [process.execPath, fileURLToPath(cli), "dev", "--port", "5174", "--hostname", "127.0.0.1"];
await import(cli.href);
