import { createDatabaseClient } from "./database.ts";

async function main() {
  const prisma = createDatabaseClient();

  try {
    const rows = await prisma.$queryRaw<
      { connection_ok: number | bigint }[]
    >`SELECT 1 AS connection_ok`;
    if (rows.length !== 1 || String(rows[0].connection_ok) !== "1") {
      throw new Error("MySQLから期待した結果が返りませんでした。");
    }

    const tables = await prisma.$queryRaw<
      { table_count: number | bigint }[]
    >`SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = DATABASE()`;

    console.log("Prisma → MySQL：SELECT 1 が 1 を返しました。");
    console.log(`接続先DBのテーブル数：${String(tables[0].table_count)}`);
    console.log("今回は読み取り確認のみで、テーブルやデータは変更していません。");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  // 接続情報を含む可能性があるため、エラーオブジェクトはそのまま表示しない。
  console.error(
    "MySQLへの接続確認に失敗しました。Dockerの稼働と.env.mysql.localの設定を確認してください。",
  );
  process.exitCode = 1;
});
