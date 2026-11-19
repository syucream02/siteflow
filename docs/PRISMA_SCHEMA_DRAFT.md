# Prismaのスキーマ案を読む（2026年11月14日）

その後の学習で、Better Auth 1.7.23を検証用に追加し、認証・チーム・招待の生成スキーマを別ファイルで確認した。現状の比較と次の調整点は [BETTER_AUTH_SCHEMA_REVIEW.md](BETTER_AUTH_SCHEMA_REVIEW.md) を参照。この文書の案件案はまだ統合前。

現在の統合候補は `db/design/integrated.prisma`。所属IDから履歴用の人物IDへの参照変更は [MEMBERSHIP_AND_HISTORY.md](MEMBERSHIP_AND_HISTORY.md) で説明している。

## 今回できたこと

[DATA_MODEL.md](DATA_MODEL.md) の関連図を、`db/design/schema.prisma` のPrisma形式へ書き起こした。
Prisma 7.10.1の `validate` で、記述と関連付けが有効なことを確認した。
MySQLに接続してテーブルを作成したり、不正データの保存を実際に拒否させたりした段階ではない。

このファイルは学習・構造検証用の案。本体や既存の接続検証APIからは読み込まない。
接続先URLとClient生成用generatorを持たず、マイグレーションも作っていない。
`examples/mysql/prisma/schema.prisma` と既存の `generate`・`check`・`dev:api` の参照先は変更していない。

## ファイルと役割

| ファイル | 今回の変更と理由 |
| --- | --- |
| `db/design/schema.prisma` | ユーザー・チーム・所属・案件・副担当の候補。進捗や文字数の仮置き、認証未完成の注意をコメントに記載 |
| `examples/mysql/package.json` | 既存Prismaで案だけを検査する `validate:design` を追加。依存は追加・更新していない |
| この文書・DATA_MODEL・非機能要件台帳・検証記録 | 読む順序、構文、仮定、実際の検査結果と未検証項目を記録 |

## まず、5つのmodelだけを見る

`model` は、保存するデータの種類と、その項目・つながりを定義する部分。
実際のテーブルは、この設計をマイグレーションでDBへ適用してから作られる。

| model | 担当する情報 |
| --- | --- |
| User | 利用者。Better Authとの接続点の候補 |
| Team | 情報を共有するチーム |
| TeamMembership | 誰がどのチームで管理者・メンバーか |
| Project | チームの案件、主担当、作成者、納期、進捗、状態など |
| ProjectSupportMember | 案件と副担当の所属をつなぐ情報 |

主担当と作成者は別々に所属を参照する。同じ人でも別の人でもよいが、案件と同じチームである必要がある。
所属のroleの初期値はMEMBERという案で、チーム作成者にはAPI側でADMINを明示して一括保存する設計が必要。

## よく使う構文

```prisma
name     String
notes    String?
progress Int     @default(0)
```

| 構文 | 意味と注意点 |
| --- | --- |
| `String` | 文字列。`?` がないので必須。ただし空文字や空白を自動で拒否する指定ではない |
| `String?` | 値を省略できる文字列。DBではNULLを扱える |
| `Int @default(0)` | 整数。指定しなければ0。これだけでは0〜100の範囲を保証しない |
| `@id` | そのデータを一意に識別する主キー |
| `@default(uuid())` | Prismaで作成するときにUUIDを生成する候補。生のSQLでもDBが自動生成するという保証ではない |
| `@@id([projectId, membershipId])` | 2つの列の組合せを主キーにする。同じ案件に同じ副担当を二重登録しない |
| `@@unique([teamId, userId])` | 同じチームと利用者の組合せが重複しない制約 |
| `@relation(fields: [...], references: [...])` | どの列で、相手のどの列を参照するか指定する |
| `Project[]` | 関連する案件が0件以上あるというPrisma上の関連。DBの列に案件の配列を直接保存する指定ではない |
| `@db.Date` | 時刻を含めない日付としてMySQLへ保存する候補。Prismaの型はDateTimeなので、APIの入出力との変換設計が必要 |
| `@db.DateTime(3)` | ミリ秒精度の日時の候補。日時のUTCでの扱いは保存・取得時にそろえる |
| `@db.VarChar(100)` | MySQLで最大100文字の可変長文字列にする案。今回の文字数上限は仮置き |
| `@@index(...)` | 検索する列の組合せに索引を設ける案。性能が改善したという測定結果ではない |
| `onDelete: Restrict` | 参照しているデータがある場合、参照先の削除を拒否する指定。所属解除や退会の業務ルールを完成させるものではない |

`enum` は選べる値の一覧。今回は案件を未着手・進行中・確認待ち・保留・完了の5状態で表す。
既存の指摘管理デモの4状態とは別で、本体の状態や完了率計算を置き換えていない。

## 同じチームに限定する仕組み

主担当には、所属IDだけでなくチームIDも一緒に関連付けている。

```prisma
fields:     [teamId, primaryMembershipId]
references: [teamId, id]
```

これは「案件のチームと主担当の所属先チームも一致する組合せ」を参照する案。
相手の `(teamId, id)` にも一意制約が必要なので、TeamMembershipに対応する `@@unique` を書く。
作成者と副担当も同じ考え方。今回Prismaはこの複数列の関連を有効と判定したが、MySQLでの拒否テストはまだ行っていない。
主担当と副担当の重複は、この関連付けや副担当の主キーだけでは防げないため、別途APIの検査・トランザクション・競合検出を設計する。

## 仮置き・未実装を区別する

- 進捗は整数0〜100、完了には100%が必要で自動完了しない、というおすすめ案への回答はまだ受け取っていない。構造を比較するためIntを仮置きし、完了条件や範囲の追加制約は未収録。確定仕様としてDBへ適用しない。
- Userの項目は認証との接続点を考える候補。Better Auth本体は未導入で、Session・Account・Verificationや招待は収録していない。この案だけでログインは動かない。採用バージョンの生成スキーマと照合する。
- 今回は独自のTeam・TeamMembershipを表す候補。Better AuthのOrganizationプラグインを採用するかの選定は未完了。採用する場合に二重の所属管理を作らないよう、実際のモデルと統合する。
- 名前・メール・業務番号などの長さ、ID型、作成日時・更新日時、versionの初期値1は候補。メールの表記や照合規則、業務番号の重複可否などを勝手に確定していない。業務番号に一意制約は付けていない。
- `version` は列を置いたのみ。更新時のversion比較・加算・競合応答を実装しない限り、同時更新の上書きは防げない。
- `archivedAt` はアーカイブ日時の候補。一覧から除外するAPI・復元操作は未実装。
- 所属解除・再参加・退会・最後の管理者・履歴保持・状態遷移・再開などは、マイグレーション前に具体化する。

## 検査コマンドと結果

リポジトリのルートで実行する。

```powershell
npm.cmd --prefix examples/mysql run validate:design
```

`--prefix examples/mysql` は、既存Prismaのあるパッケージを指定する。
`run validate:design` は今回追加した検査用コマンド。
内部の `prisma validate --config prisma7.config.ts --schema ../../db/design/schema.prisma` は、`--config` で設定を読み、`--schema` で検査対象を今回の案へ切り替える。
DB接続情報は読み込まず、テーブル作成・データ更新・Client生成は行わない。

Prismaの `format --schema db/design/schema.prisma` でも案のファイルだけを整形した。formatは指定ファイルを書き換えるが、DBは変更しない。

| 検査 | 実際の結果 |
| --- | --- |
| Prisma validate | 成功。有効なスキーマと判定 |
| ESLint | 成功 |
| 型検査 | 成功 |
| 既存の業務ルールテスト | 8件成功。新しいDB制約のテストではない |
| Next.js本番ビルド | 成功。本体でスキーマ案を使い始めたことを意味しない |
| MySQLでのテーブル作成・不正データの拒否 | 未実施 |
| 認証・画面との統合 | 未実施 |

通常の確認コマンドは、`npm.cmd run lint`（生成先を除外し規約検査、自動修正なし）、`node --experimental-strip-types --test tests/domain.test.mjs`（型を取り除いて読み込み、指定テストを実行）、`npm.cmd run build`（本番用ファイルと型情報を生成）、`npx.cmd tsc --noEmit --incremental false`（コード出力・検査キャッシュ更新なしで型検査）。
lint内部の `--ignore-pattern dist` と `--ignore-pattern .next` は生成先を検査しない指定。ビルドが更新した追跡済みキャッシュは実行前へ戻した。

## 次の読む順序と練習

最初にTeamMembership、その次にProjectの主担当の `@relation`、最後にProjectSupportMemberを読む。
練習は `@@unique([teamId, userId])` と `(teamId, primaryMembershipId)` が、それぞれ何の間違いを防ぐのか説明すること。
次の段階は認証とチーム管理方式の照合、仮仕様の確定。DBでの拒否テストとマイグレーションはその後に行う。

参考：[Prismaスキーマの構文](https://www.prisma.io/docs/orm/v7/reference/prisma-schema-reference)、[Better AuthのDB](https://better-auth.com/docs/concepts/database)、[Better AuthのPrisma連携](https://better-auth.com/docs/adapters/prisma)。
