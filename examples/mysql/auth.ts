import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { PrismaClient } from "./generated/integrated/client.ts";

// 認証設定を共有し、受付を移しても登録やメール認証を勝手に有効化しない。
export function createSiteflowAuth(prisma: PrismaClient, baseURL: string, secret: string, secureCookies: boolean, basePath = "/api/auth", cookiePath = "/") {
  return betterAuth({
    baseURL, basePath, secret,
    database: prismaAdapter(prisma, { provider: "mysql" }),
    telemetry: { enabled: false }, logger: { disabled: true },
    trustedOrigins: [baseURL],
    emailAndPassword: { enabled: true, disableSignUp: true, requireEmailVerification: true },
    advanced: { database: { generateId: "uuid" }, useSecureCookies: secureCookies, defaultCookieAttributes: { path: cookiePath } },
    session: { cookieCache: { enabled: false } },
  });
}
