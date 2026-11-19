import { createDatabaseClient } from "../../../database.ts";

export const runtime = "nodejs";

export async function GET() {
  const requestId = crypto.randomUUID();
  const headers = { "Cache-Control": "no-store" };

  try {
    const prisma = createDatabaseClient();
    try {
      const rows = await prisma.$queryRaw<
        { connection_ok: number | bigint }[]
      >`SELECT 1 AS connection_ok`;
      if (rows.length !== 1 || String(rows[0].connection_ok) !== "1") {
        throw new Error("Unexpected database result");
      }
    } finally {
      await prisma.$disconnect();
    }

    return Response.json(
      { ok: true, message: "MySQLへ接続できました。", requestId },
      { headers },
    );
  } catch {
    // 接続情報を含む可能性があるため、元のエラーは応答やログへ出さない。
    console.error(JSON.stringify({ event: "database_check_failed", requestId }));
    return Response.json(
      { ok: false, message: "DBに接続できませんでした。", requestId },
      { status: 503, headers },
    );
  }
}
