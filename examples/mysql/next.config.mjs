import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  // Next.js本体は親のnode_modules、Prismaはこの検証用アプリから解決する。
  turbopack: { root: fileURLToPath(new URL("../../", import.meta.url)) },
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-mariadb"],
};

export default nextConfig;
