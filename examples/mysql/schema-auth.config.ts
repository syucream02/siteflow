import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

// スキーマ生成専用。本体・検証APIはこの設定を読み込まない。
// DB接続もメール送信も設定しない。実運用の認証設定として使用しない。
export const auth = betterAuth({
  baseURL: "http://127.0.0.1:5175",
  secret: randomBytes(32).toString("hex"),
  telemetry: { enabled: false },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
  advanced: {
    database: { generateId: "uuid" },
  },
  plugins: [
    organization({
      creatorRole: "admin",
      allowUserToCreateOrganization: (user) => user.emailVerified,
      requireEmailVerificationOnInvitation: true,
      teams: { enabled: false },
      schema: {
        organization: { modelName: "Team" },
        member: {
          modelName: "TeamMembership",
          fields: { organizationId: "teamId" },
        },
        invitation: { fields: { organizationId: "teamId" } },
      },
    }),
  ],
});
