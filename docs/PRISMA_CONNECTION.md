# TypeScriptからPrisma経由でMySQLへ接続する

## 目的と現在の範囲

前段階では、MySQLコンテナ内のクライアントでSQLを実行した。
今回はWindows側のNode.jsでTypeScriptを動かし、Prismaを通して同じ開発用MySQLに接続する。

```text
examples/mysql/check.ts
  → Prisma Client
  → MySQL接続アダプター
  → 127.0.0.1:3307のMySQL
  → SELECT 1の結果を受け取る
```

既存アプリと切り離した技術検証として、`examples/mysql/` に独立したnpmパッケージを置く。
既存の `examples/d1/` と同様に、本体のTypeScript検査対象からは除外されるため、専用の型検査も行う。
本体のpackage.json・依存・起動スクリプト・Dockerfile・CI/CD設定は変更していない。
この単独スクリプトの検証だけでは、VinextのAPI内やCloudflare Workersで動作することを確認したことにはならない。
次の段階としてローカル検証APIを用意し、現在はNext.jsで接続確認している。結果と起動手順は [PRISMA_API.md](PRISMA_API.md)、移行の記録は [NEXTJS_MIGRATION.md](NEXTJS_MIGRATION.md) を参照。
本体の業務API・画面との接続、業務テーブルの作成、認証は未実装。

## 導入した道具と役割

| 道具 | 版 | 役割と既存技術との関係 |
| --- | --- | --- |
| `prisma` | 7.10.1 | 設定を読み、Prisma Clientを生成するCLI |
| `@prisma/client` | 7.10.1 | TypeScriptからDBへ問い合わせるための実行ライブラリ |
| `@prisma/adapter-mariadb` | 7.10.1 | Prisma ClientとMySQLの接続を橋渡しする。名前にMariaDBとあるがMySQLにも対応 |
| `tsx` | 4.23.15 | 確認用TypeScriptをNode.jsで実行するための道具 |
| TypeScript・Node型定義 | 5.9.3・22.19.19 | 本体と同じ版を使って、検証コードも型検査する |

Prisma関連は同じ7.10.1にそろえ、検証用ロックファイルで依存を固定する。
Prisma 7.10.1のNode.js要件は `^20.19 || ^22.12 || >=24.0`。今回のNode.js 24.20.0は範囲内。
MySQLの実行環境は引き続きDocker。PrismaがMySQLやDockerを置き換えるわけではない。
既存のD1用Drizzle接続も今回変更していない。

## ファイルと設定の意味

| ファイル | 役割・主要な項目 |
| --- | --- |
| `examples/mysql/package.json` | この例だけの依存と実行コマンド。`private`で公開用パッケージではないこと、`type: module`でES modulesを使うことを指定 |
| `examples/mysql/package-lock.json` | インストールする依存の版を固定する |
| `examples/mysql/prisma7.config.ts` | Prisma CLIが読む設定。`schema`はスキーマファイルの場所。接続先の秘密情報は書かない |
| `examples/mysql/prisma/schema.prisma` | `provider = mysql`はDB種別、`prisma-client`は生成方式、`output`は生成先、`moduleFormat = esm`はモジュール形式、`importFileExtension = ts`は生成コード内のimportの拡張子 |
| `examples/mysql/tsconfig.json` | 本体のstrict設定を引き継いで検証コードを検査。`allowImportingTsExtensions`は.ts付きimportを許可し、`incremental: false`で検査キャッシュを作らない |
| `examples/mysql/check.ts` | ローカル設定を使って接続し、固定SQLを実行する。`finally`で接続を閉じ、失敗時は秘密情報を含まないメッセージと終了コード1を返す |

2026年11月13日、接続設定の検査とClientの作成を `examples/mysql/database.ts` に分離し、
単独スクリプトとローカル検証APIから共通利用するようにした。生成・接続・型検査の基本手順は変わらない。

スキーマにはまだモデルを定義していない。クライアント生成はDBのテーブル作成とは別の操作。
`generated/` とこの例の `node_modules/` はGit管理から除外する。
接続には既存の `.env.mysql.local` のMYSQL_USER・MYSQL_PASSWORD・MYSQL_DATABASE・MYSQL_PORTを使う。
ホストは127.0.0.1に固定し、管理者用パスワードは接続に使わない。新しい秘密ファイルは作っていない。

## 実行方法

前提：本体の依存を復元済みで、開発用MySQLが起動していること。
MySQLの起動・停止は [LOCAL_DATABASE.md](LOCAL_DATABASE.md) を参照。
リポジトリのルートから、以下を実行する。

```powershell
npm.cmd --prefix examples/mysql ci
npm.cmd --prefix examples/mysql run check
npm.cmd --prefix examples/mysql run typecheck
```

- `--prefix examples/mysql`：本体ではなく確認用パッケージを操作する指定。
- `ci`：検証用ロックファイル通りに依存を復元する。検証用node_modulesが更新されるがDBは変更しない。初回のロックファイル作成には `install` を使った。
- `run check`：接続用コードを生成してからTypeScriptを実行する。生成物は更新されるが、SQLはSELECTだけなのでDBの構造・データを書き換えない。
- `run typecheck`：検証コードの型検査をする。実行内容は `tsc --noEmit --project tsconfig.json`。`--noEmit`はJavaScriptを出力しない指定、`--project`は検査設定の指定。

`check` の内部では、以下を実行する。

```text
prisma generate --config prisma7.config.ts
node --env-file=../../.env.mysql.local --import tsx check.ts
```

- `generate`：Prisma Clientのコードを生成する。`--config`は利用する設定ファイルを指定する。DBには接続せず、テーブルも作らない。
- `--env-file`：検証用パッケージから見たローカル接続設定の場所。内容を表示せず、Node.jsプロセスの環境変数として読み込む。
- `--import tsx`：TypeScriptを実行するための準備を読み込む。`check.ts`が実行対象。

成功すると「Prisma → MySQL：SELECT 1 が 1 を返しました。」と、接続先のテーブル数が表示される。
接続先に業務テーブルを作る前の今回の確認では、テーブル数は0だった。

## 学習のポイント

```typescript
const rows = await prisma.$queryRaw<
  { connection_ok: number | bigint }[]
>`SELECT 1 AS connection_ok`;
```

`await`は問い合わせの完了を待つ。`$queryRaw`はSQLを実行して結果を受け取る。
`AS connection_ok`は結果の項目名を付けるSQLで、`rows`は結果の行を入れた配列。
型指定は結果の形をTypeScriptへ伝えるものなので、実際に1が返ったかもコードで確認している。
これは固定SQLによる接続確認であり、ユーザーの入力をSQL文字列へ連結する実装ではない。

まず `check.ts` の接続設定、次に `try` 内の問い合わせ、最後に `finally` の切断処理を読む。
次の練習は「Clientの生成」「DBへの接続」「テーブルの作成」が別々の操作であることを説明してみること。

## 検証結果（2026年11月12日）

- Prisma Client生成：モデルなしのスキーマで成功。
- Node.js 24.20.0上の確認用TypeScriptから、Prisma 7.10.1経由でMySQLへ接続し、SELECT 1の結果が1であることを確認。
- テーブル数：0。業務テーブル・データは作成していない。
- 不正ポートと不正パスワード：終了コード1となり、実際のパスワード値を表示しないことを確認。ローカル設定は書き換えていない。
- 検証用コードの型検査、本体の型検査、既存の業務ルールテスト8件、本体ビルド：成功。
- 本体ビルドは既存の `/` の分類にUnknown表示がある。`/api/health` はAPIルートとして認識。
- 制限環境ではtsxがWindowsユーザー情報を取得できず停止したが、制限の外で実行して成功。DBのエラーではない。
- この段階ではVinext内でのPrisma実行は未検証。2026年11月13日のローカル検証APIでの結果は [PRISMA_API.md](PRISMA_API.md) を参照。業務APIへの組み込み、認証・マイグレーション・本番接続は引き続き未検証。

参考：[Prisma 7のMySQL導入例](https://www.prisma.io/docs/v7/prisma-orm/quickstart/mysql)、[Client生成設定](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators)。
