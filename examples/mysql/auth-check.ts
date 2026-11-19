import { randomBytes } from "node:crypto";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "./generated/integrated/client.ts";
import { readSchemaCheckSettings } from "./schema-check-settings.mjs";
import { startApiServer } from "./api-server.ts";

// ローカル検証用。省略時は従来どおり起動ごとに秘密値を生成する。
export async function startAuthCheckServer(port = 5175, options: { authSecret?: string } = {}) {
  const settings = readSchemaCheckSettings();
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb({
    host: "127.0.0.1", port: settings.port, user: settings.user,
    password: settings.password, database: settings.database,
    connectionLimit: 2, connectTimeout: 5000, acquireTimeout: 5000,
  }) });
  return startApiServer({ prisma, authSecret: options.authSecret ?? randomBytes(32).toString("hex"), secureCookies: false, port });
}