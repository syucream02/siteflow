import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SiteFlow | 現場・プロジェクト管理",
  description: "現場の指摘事項を、登録から対応・確認・完了まで管理。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="antialiased">{children}</body>
    </html>
  );
}
