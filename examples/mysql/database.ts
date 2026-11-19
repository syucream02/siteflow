import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "./generated/client.ts";

export function createDatabaseClient() {
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;
  const database = process.env.MYSQL_DATABASE;
  const port = Number(process.env.MYSQL_PORT ?? "3307");

  if (!user || !password || !database) {
    throw new Error("MySQLの接続設定が不足しています。");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MySQLのポート設定が不正です。");
  }

  const adapter = new PrismaMariaDb({
    host: "127.0.0.1",
    port,
    user,
    password,
    database,
    connectionLimit: 1,
    connectTimeout: 5000,
    acquireTimeout: 5000,
  });

  return new PrismaClient({ adapter });
}
