import { defineConfig } from "prisma/config";
import { readSchemaCheckSettings } from "./schema-check-settings.mjs";

// 名前・ユーザー・ポートを検査した専用DBだけへ適用する。
const settings = readSchemaCheckSettings();

export default defineConfig({
  schema: "../../db/design/integrated.prisma",
  migrations: { path: "../../db/design/migrations" },
  datasource: {
    url: `mysql://${encodeURIComponent(settings.user)}:${encodeURIComponent(settings.password)}@127.0.0.1:${settings.port}/${settings.database}`,
  },
});
