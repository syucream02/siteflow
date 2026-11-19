# Next.jsへの移行と動作確認（2026年11月13日）

## 何を変えたか

SiteFlowを完成させる学習へ集中するため、通常の開発・ビルド・本番起動をVinextからNext.js本体へ切り替えた。
導入済みのNext.js 16.3.4、React 19.2.6を使用。依存の追加・更新、ロックファイルの変更はない。
Reactの画面、業務ルール、データ、状態遷移テストは今回書き換えていない。

```text
これまで：React画面 → Vinext / Vite → ビルド・配信
今回から：React画面 → Next.js      → ビルド・配信
別の検証：Next.js API → Prisma → ローカルMySQL
```

APIは `app/api/.../route.ts` のGET関数、画面は `app/page.tsx`、共通の枠組みは `app/layout.tsx` というApp Routerの規約を引き継ぐ。
画面の操作は引き続きメモリ上のデモで、再読み込みするとリセットされる。認証や案件のDB保存が実装されたわけではない。

## 設定と変更理由

| 対象 | 変更内容・理由 |
| --- | --- |
| `package.json` | `dev`・`build`・`start` をNext.jsのCLIへ変更。通常起動でSites/Vinext用ラッパーやWranglerを通さない |
| `next.config.ts` | `agentRules: false` で、開発起動時に学習用AGENTS.mdが自動変更されないようにする |
| `next-env.d.ts` | Next.jsが生成し直すローカル型宣言。Vinextの型拡張を外す。既存のGit除外を維持 |
| `examples/mysql/` | DB検証サーバーもNext.jsへ変更。専用の設定・起動処理・最小レイアウトを用意し、本体には検証APIを追加しない |
| `Dockerfile` | ビルドは既存の `npm run build`、起動はNext.jsのNode.jsサーバーへ変更。ポート3000を維持 |
| `.dockerignore` | 検証用のnode_modules、Prisma生成物、Next.jsキャッシュ・ローカル型宣言を除外。既存の秘密設定ファイル除外も維持 |
| `.gitignore`・ESLint | 検証用Next.js生成物をGitとコード規約検査から除外。Prisma生成物もESLint対象外にする |
| README・AGENTS・関連docs | 現在の起動方法、判断、実際の結果と残る課題を反映 |

Next.jsはサーバー・ブラウザー用のコードをビルドする枠組み、Reactは画面、TypeScriptは型による検査、PrismaはDB操作の担当。
Dockerは同じ実行環境を用意する役割で、Next.jsへの切り替え後も使う。

旧 `vite.config.ts`、`build/`、Sites/Vinext用のスクリプト・依存、未使用のD1/Drizzle雛形は今回一括削除しない。
これらは通常の3つの起動コマンドからは使われない。旧 `install:ci`・`db:generate` は移行対象外の補助手順で、現在の標準手順はREADMEの `npm ci`。
Cloudflare/Sites用の独自実行プロファイルやプレビューをNext.jsへ移植したものではない。
不要な依存や旧補助コマンドの整理は、既存環境への影響を確認する別の段階にする。

## 起動・検証のコマンド

リポジトリのルートで実行する。Windows PowerShell向けに `.cmd` を明記した。

| コマンド | 目的・指定の意味・影響 |
| --- | --- |
| `npm.cmd ci` | ロックファイルどおりに依存を復元。node_modulesを更新する |
| `npm.cmd run dev` | Next.jsの開発サーバーを起動。内部の `--port 5173` はポート、`--hostname 127.0.0.1` はPC内限定の待ち受け先 |
| `npm.cmd run build` | 本番用コードと型情報を `.next/` に生成。型検査も実施する |
| `npx.cmd tsc --noEmit --incremental false` | TypeScript型検査。`--noEmit` はコード出力なし、`--incremental false` は検査キャッシュ更新なし |
| `node --experimental-strip-types --test tests/domain.test.mjs` | `--experimental-strip-types` でTypeScriptの型を取り除いて読み込み、`--test` で指定した業務ルールテストを実行。DBは変更しない |
| `npm.cmd run lint` | ESLintの検査。内部の `--ignore-pattern dist`・`--ignore-pattern .next` は生成先を検査対象外にする指定。コードの自動修正はしない |
| `npm.cmd start` | ビルド済みアプリを起動。`--port 3000` はポート、`--hostname 0.0.0.0` はコンテナの外からも接続できる待ち受け先 |
| `npm.cmd --prefix examples/mysql run dev:api` | `--prefix` で検証用アプリを指定し、Client生成後に5174番で起動。詳細はPRISMA_API.md |
| `npm.cmd --prefix examples/mysql run typecheck` | 検証用アプリの型検査。内部の `tsc --noEmit --project tsconfig.json` はコードを出力せず指定設定を検査 |

開発URLは http://127.0.0.1:5173 、本番起動の確認URLは http://127.0.0.1:3000 。停止は起動したターミナルのCtrl+C。
MySQL検証は http://127.0.0.1:5174/api/db-check 。事前にMySQLを起動し、検証用の依存関係とローカル設定を用意する。

Dockerの確認に使用したコマンド：

```powershell
docker build -t siteflow:next-migration .
docker run --rm -d --name siteflow-next-migration -p 127.0.0.1:3001:3000 siteflow:next-migration
docker logs siteflow-next-migration
docker stop siteflow-next-migration
```

`build` はイメージ生成、`-t` はタグ、`.` は現在のフォルダーをビルド対象にする指定。
`run` は起動、`--rm` は停止時に確認用コンテナを自動削除、`-d` はバックグラウンド、`--name` は識別名、`-p` はPC内の3001番とコンテナの3000番をつなぐ指定。
`logs` はログ表示、`stop` は指定コンテナだけの停止。MySQLコンテナや保存ボリュームは削除しない。イメージの公開・pushは行わない。
Dockerが見つからない古いターミナルは開き直す。今回の実行環境ではDockerのbinディレクトリをプロセス内のPATHへ追加して実行し、システムのPATHは変更していない。

## 実際の検証結果

| 確認 | 結果 |
| --- | --- |
| 本体・DB検証用の型検査 | 成功 |
| 業務ルールテスト | 8件すべて成功 |
| PC上のNext.js本番ビルド | 成功。`/` は静的ページ、`/api/health` は動的ルートとして認識 |
| 開発起動・本番起動 | 画面HTML・CSS・ヘルスチェックAPIが200、ヘルスチェックへのPOSTが405 |
| 検証APIの分離 | 本体の開発・本番起動・Dockerで `/api/db-check` は404 |
| Next.js + Prisma + MySQL | 正常200、不正パスワード503、POST 405、no-store、追跡IDと秘密情報非表示、通常設定へ復元後200を確認 |
| Docker | LinuxイメージのビルドとNext.js起動に成功。PCの3001番とコンテナ内の両方からHTTP応答を確認。画面HTML・CSS・API 200、POST 405 |
| Dockerのローカルファイル除外 | `.env.mysql.local`、検証用node_modules・Prisma生成物・Next.jsキャッシュがコンテナ内にないことを確認 |
| ESLint | 移行時は1件残ったが、2026-11-14に日付処理を修正して指摘0件。詳細はTOKYO_DATE_SYNC.md |
| ブラウザーの画面操作 | 移行後、ユーザーからシークレットで登録・対応開始・空入力の拒否・確認依頼・完了の確認報告あり。2026-11-14の日付処理修正後の再検証、スマホ幅・キーボード・日付またぎは未確認。自動接続は引き続き利用不可 |
| GitHub Actions・AWS・公開サイト | 今回変更・実行・デプロイしていない |

HTTPでHTMLやCSSを取得できたことと、ブラウザー内でJavaScriptが動き操作できたことは別。過去のVinextでの画面操作結果を、今回のNext.jsで確認済みとは扱わない。
今回のAPIは読み取りだけで、MySQLのテーブル・データや認証情報を変更していない。

## 次に読むところと練習

最初に `package.json` の `dev`・`build`・`start` を読む。開発中・配布用生成・本番用起動の3つを区別する。
次に `app/page.tsx` → `components/siteflow/workspace.tsx` を読み、枠組みを移行してもReactの画面を活用できることを確認する。
練習は、ブラウザーで登録 → 対応開始 → 空の対応内容で確認依頼を拒否 → 対応入力 → 確認依頼 → 承認完了を試すこと。
その後、既存のESLint指摘を直す学習と、チーム・案件のDB設計へ進む。

参考：[Next.js CLI](https://nextjs.org/docs/app/api-reference/cli/next)、[Node.js・Dockerでの運用](https://nextjs.org/docs/app/getting-started/deploying)。
