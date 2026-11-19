# Next.jsの検証APIからMySQLへ接続する

## 目的と範囲

`examples/mysql/` は、本体の画面や配信設定から分離した接続検証用アプリ。
Next.js 16.3.4のNode.js実行環境から、Prismaを経由して開発用MySQLへ `SELECT 1` を実行する。

```text
GET http://127.0.0.1:5174/api/db-check
  → Next.jsのRoute Handler（URLへのリクエストを受ける関数）
  → Prisma → MySQL → JSON応答
```

本体の案件保存、認証、業務API、本番DB接続は未実装・未検証。
認証のない接続検証なので、待ち受けを127.0.0.1に限定する。本体や公開環境へ組み込まない。

## ファイルの役割

| ファイル | 役割と設定の意味 |
| --- | --- |
| `app/api/db-check/route.ts` | GETの受付・SQL実行・応答。`runtime = "nodejs"` で実行環境を明示。成功・失敗とも `finally` で接続を切断 |
| `database.ts` | 環境変数の検査とPrisma Client作成。単独確認とAPIで共通利用 |
| `dev-api.mjs` | `process.loadEnvFile` でローカル設定を読み、Next.jsを起動。子プロセスへ秘密の値を環境変数として継承し、値をログに出さない |
| `next.config.mjs` | `turbopack.root` は親のNext.js依存も解決できる探索範囲。`serverExternalPackages` はPrisma関連をNode.jsで読み込む指定。`agentRules: false` はAGENTS.mdの自動生成を止める指定 |
| `app/layout.tsx` | 検証用アプリの最小のHTML枠組み |
| `tsconfig.json` | API、共通処理、レイアウトとNext.js生成型を検査。生成Clientの `.ts` インポートを許可 |

旧 `vite.config.ts` は移行前の参考として残すが、現在の `dev:api` からは読み込まない。
接続を毎回作成・切断する実装は互換性確認用で、業務APIの接続プールや同時利用設計を完了したものではない。

## 起動と停止

前提は、本体と検証用パッケージの依存関係を復元済み、開発用MySQLが稼働中、Git除外済みの `.env.mysql.local` があること。
[PRISMA_CONNECTION.md](PRISMA_CONNECTION.md) と [LOCAL_DATABASE.md](LOCAL_DATABASE.md) を参照。

リポジトリのルートで実行する。

```powershell
npm.cmd --prefix examples/mysql run dev:api
```

- `--prefix examples/mysql`：操作するパッケージを検証用フォルダーへ切り替える。
- `run dev:api`：Prisma Clientを生成後、Next.jsを起動。DBのテーブル・データは変更しない。
- 内部の `prisma generate --config prisma7.config.ts`：指定した設定から接続コードを生成する。
- 内部の `node dev-api.mjs`：設定ファイルを読み、Next.jsの `dev --port 5174 --hostname 127.0.0.1` を実行する。`dev` は開発起動、`--port` は待ち受け番号、`--hostname` はPC内限定の待ち受け先。

URLは http://127.0.0.1:5174/api/db-check 。本体の5173番とは別。
停止は起動したターミナルのCtrl+C。同じアプリを設定違いで検証するときは先に止める。
接続失敗の検証では、テストプロセスの環境変数だけを一時変更し、設定ファイルやDBのパスワードを変更しない。

## 応答と検証結果（2026年11月13日）

| 条件 | 実際の結果 |
| --- | --- |
| 正常な設定でGET | 200、`ok: true`、成功メッセージ、追跡用 `requestId` |
| 不正パスワードでGET | 503、`ok: false`、一般的な失敗メッセージ、追跡ID |
| POST | 405（許可されていないメソッド） |
| 応答のキャッシュ | 成功・失敗とも `Cache-Control: no-store` |
| 失敗時の情報 | 応答は `ok`・`message`・`requestId` のみ。アプリ用・管理者用パスワードが含まれないことを確認。ログはイベント名と同じ追跡IDのみ |
| 設定の復元 | 通常設定で再起動後、200へ戻ることを確認 |
| 本体への分離 | 本体の開発・本番起動・Dockerで `/api/db-check` は404 |

型検査は本体と検証用の両方で成功。固定SQLによる読み取りだけで、マイグレーションやデータ更新は行っていない。
負荷試験、公開環境、認証との統合は未検証。

## 移行時に分かったこと

以前はVinext/Viteの検証APIで、Prismaを `ssr.external` に指定して接続した。
現在はNext.jsの設定へ切り替えており、その過去の成功をNext.jsの検証結果として流用していない。

最初のNext.js起動では `node --env-file=... next dev ...` が子プロセス起動時に失敗した。
Next.jsがNode.jsの起動オプションを引き継ぐ際に、NODE_OPTIONSで許可されない `--env-file` が入ったため。
`dev-api.mjs` 内で設定を読み込む方法に変え、通常・失敗・復元を検証した。

本体へPrismaを導入する際は、依存・生成コード・スキーマのコピー順序を別途設計する。
現在のDockerfileは依存インストール後にソースをコピーするため、スキーマの必要なClient生成を単純にインストール時へ足さない。

次は `route.ts` の「受付 → DB確認 → 応答」と、成功・失敗のどちらでも実行する `finally` を読む。
練習は、200・503・405の違いを自分の言葉で説明すること。

参考：[Next.jsの外部パッケージ設定](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages)、[PrismaのMySQL導入例](https://www.prisma.io/docs/v7/prisma-orm/quickstart/mysql)。
