import { defineConfig } from "prisma/config";

// SQL生成専用。from-empty / to-schemaで比較し、実在するDBを参照しない。
// このCLI/エンジンの組合せはdatasource情報を必要とするため形式だけを与える。
// パスワードは含まない。DB適用にはこの設定を使わない。
export default defineConfig({
  schema: "../../db/design/integrated.prisma",
  datasource: {
    url: "mysql://schema_preview@127.0.0.1:1/schema_preview",
  },
});
