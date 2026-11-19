import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 実行に必要なファイルだけをDockerの最終段へコピーする。
  output: 'standalone',
  // 統合検証だけは通常の開発サーバーとキャッシュ・型生成先を共有しない。
  ...(process.env.SITEFLOW_LOCAL_CHECK === '1' ? {
    distDir: 'work/next-integrated-check',
    typescript: { tsconfigPath: 'work/integrated-tsconfig.json' },
  } : {}),
  // 学習用に管理しているAGENTS.mdへ起動時にルールを自動追加しない。
  agentRules: false,
};

export default nextConfig;
