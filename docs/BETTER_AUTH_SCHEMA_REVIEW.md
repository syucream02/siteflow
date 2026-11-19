# Better Authとチーム設計の照合（2026年11月14日）

この照合の後、所属と履歴の参照を分ける統合候補を作成した。現在の案と検証状況は [MEMBERSHIP_AND_HISTORY.md](MEMBERSHIP_AND_HISTORY.md) を参照。生成ファイル自体は比較用に維持している。

## 今回の到達点

Better Auth 1.7.23と公式CLI `auth` 1.7.23を、検証用の `examples/mysql/` だけに固定して追加した。
Node.js 24.20.0とPrisma 7.10.1を使用。CLIのNode条件は22.12以降で、既存の22.13以降の条件を満たす。
本体のpackage.json・ロックファイルは変更していない。

Organizationプラグインを使う候補の設定から、MySQL向けPrismaスキーマをDB接続なしで生成し、Prismaのvalidateに成功した。
ログインAPI・画面・メール送信・Cookie・DB保存の実装や検証を完了したものではない。

## なぜOrganizationを検証したか

| 方法 | 利点と追加作業 |
| --- | --- |
| Better Authは認証のみ、チーム・招待は独自実装 | 業務要件に合わせやすいが、招待の期限・利用済み・メール一致・所属管理などを自分で実装・検証する必要がある |
| OrganizationをSiteFlowのチームとして利用 | 所属・役割・招待をまとめて扱える。既定の削除・役割・所属の振る舞いと、案件の履歴保持との調整が必要 |

既存要件に招待・複数所属があるため、Organization利用を第一候補として具体的な生成結果を調べた。
この段階で本体への採用やDBへの適用を確定したわけではない。後述の差分を解消してから統合する。
Better Authの追加機能Teamsは「Organization内のグループ」。SiteFlowのチームをその追加階層として二重に作らず、今回の設定では無効にした。

## 対応するデータ

| SiteFlowの概念 | Better Authの概念 | 今回の生成model |
| --- | --- | --- |
| 利用者 | user | User |
| チーム | organization | Team |
| 所属 | member | TeamMembership |
| 招待 | invitation | Invitation |

`schema` の `modelName` でOrganizationをTeam、MemberをTeamMembershipに対応させ、所属・招待の `organizationId` の保存名を `teamId` にした。
APIやオプション名までチーム名へ変わるわけではない。セッション内の選択値も `activeOrganizationId` のまま。
その値は選択状態であり、所属や操作権限を毎回確認する代わりにはならない。

生成された認証の基本4モデル：

| model | 初心者向けの役割 |
| --- | --- |
| User | 誰が使うか。表示名、メール、認証済みか等 |
| Session | ログインを継続するための記録。有効期限など |
| Account | メール・パスワード等、利用者のログイン方法の情報 |
| Verification | メール認証・再設定等で使う一時的な確認情報 |

これにTeam・TeamMembership・Invitationが加わり、生成結果は7モデル。
案件と副担当のモデルは生成対象ではなく、前の案 `db/design/schema.prisma` に分離して残している。

## ファイルと設定の意味

| ファイル | 役割・変更理由 |
| --- | --- |
| `examples/mysql/schema-auth.config.ts` | スキーマ生成専用のBetter Auth設定。本体・検証APIのどちらからも読み込まず、DBとメール送信を設定しない |
| `examples/mysql/package.json`・ロックファイル | 生成に必要な依存をバージョン固定し、生成・検査コマンドを追加 |
| `examples/mysql/tsconfig.json` | 生成設定も型検査する |
| `db/design/auth-generated.prisma` | 公式CLIが出力した認証・所属・招待の比較用スキーマ。手書きの完成版ではない |

主な設定：

- `emailAndPassword.enabled: true`：メール・パスワード方式を使う候補。
- `requireEmailVerification: true`：サインインにメール認証を要求する設定。ただし認証メールの送信処理・実際の登録フローは未実装。
- `creatorRole: "admin"`：チーム作成者の役割を管理者にする候補。
- `allowUserToCreateOrganization: (user) => user.emailVerified`：メール認証済み利用者だけにチーム作成を許可する設定。関数がuserを受け取り、認証済みかという真偽値を返す。
- `requireEmailVerificationOnInvitation: true`：招待参加にもメール認証を要求する設定。期限・利用済み・メール一致・取消等の実動作はまだ検証していない。
- `generateId: "uuid"`：Better AuthによるUUID生成の設定。生成スキーマ上のIDはStringなので、DBの列型までChar(36)になる指定ではない。
- `secret`：生成時だけ暗号学的乱数をメモリ上に作る。出力・文書・Gitへ値を保存しない。実運用では固定したサーバー側の秘密設定を用意するため、この設定を実運用へ流用しない。
- `telemetry.enabled: false`：この生成用設定でテレメトリーを有効にしない。

設定中の127.0.0.1:5175は生成設定用の仮のURLで、認証サーバーを起動したわけではない。
Prisma用の認証アダプターはこの段階では導入していない。CLIの `--adapter prisma --dialect mysql` を使うと、DBアダプターの設定なしにスキーマを生成できるため。

## 前の案との違いと、統合前に行うこと

| 生成結果・実装確認で分かったこと | 統合時に必要なこと | 現状 |
| --- | --- | --- |
| Userに認証テーブルへの関連が追加され、名前等の列型・table mappingも前の候補と異なる | 採用バージョンの生成結果を基準に業務関連を統合。IDの列型・長さ・照合規則を外部キーとそろえる | 未統合 |
| Teamに一意なslugが必要 | チーム名の一意性とは分ける。利用者へ追加入力を強制せず、システム側で識別用slugを作る案を検討 | 未実装 |
| TeamMembershipに `(teamId, userId)` の一意制約がなく、複数列の参照用一意制約もない | 重複所属の禁止と `(teamId, id)` の参照先を統合スキーマへ追加し、DBで検証 | 未実装 |
| 標準の所属・招待等にonDelete: Cascadeがある | 認証情報の削除と業務履歴の保持を分け、必要な制約に修正。生成結果をそのまま適用しない | 未調整 |
| memberのroleはText。既定の役割にownerもあり、複数役割の表現もある | admin/memberの2種類に限定するAPI側の受付・フック・保存側の制約を設計。creatorRoleの変更だけでownerを禁止できたとしない | 未実装 |
| 前の案件案は主担当・作成者を所属へ参照する | 所属の物理削除が作成者・過去案件の参照と衝突する。担当の引き継ぎ、履歴の参照先、所属解除の扱いを先に決める | 未確定 |
| 生成ファイルにはprisma-client generatorがあるがoutputはない | 統合時にClientの出力先・生成タイミングを明示する。今回はClient生成を実行していない | 未統合 |
| プラグインが所属を管理する | チーム管理APIだけでなく、独自の案件APIも所属・案件担当・操作権限を確認する。案件の権限をプラグイン任せにしない | 未実装 |

1.7.23のローカル実装で、Organizationの役割定義が既定rolesを含むこと、役割更新の受付でもownerを含む既定rolesが認識されることを確認した。
所属・チームを削除する処理もあるため、「プラグインを入れたら履歴保持まで完成する」とは扱わない。
最後の管理者の保護、チーム作成と管理者所属の原子性、同時操作による競合は、DBアダプター導入後の検証が必要。

## 再現コマンド

リポジトリのルートで実行する。

| コマンド | 目的・指定の意味・影響 |
| --- | --- |
| `npm.cmd --prefix examples/mysql ci` | 検証用パッケージのロックファイルから依存を復元。node_modulesを更新する |
| `npm.cmd --prefix examples/mysql run generate:auth-design` | 認証設定から比較用のPrismaファイルを生成。既存の出力先を更新するがDBは変更しない |
| `npm.cmd --prefix examples/mysql run validate:auth-design` | 生成スキーマの記述・関連付けをPrismaで検査。DB接続・テーブル作成はしない |
| `npm.cmd --prefix examples/mysql run typecheck` | 検証用コードと生成設定を型検査。内部の `--noEmit` はコード出力なし、`--project tsconfig.json` は対象設定の指定 |

いずれの `--prefix examples/mysql` も、操作するパッケージを検証用に切り替える指定。
生成コマンド内部の `auth generate --config schema-auth.config.ts --adapter prisma --dialect mysql --output ../../db/design/auth-generated.prisma --yes` は、順に設定ファイル、Prisma形式、MySQL向け、限定した出力先、生成確認の省略を指定する。
`--yes` はファイル生成への指定であり、DBのマイグレーションを行うものではない。
検査内部の `prisma validate --config prisma7.config.ts --schema ../../db/design/auth-generated.prisma` は、設定と検査対象を指定している。

初回追加は `npm.cmd --prefix examples/mysql install --save-dev --save-exact better-auth@1.7.23 auth@1.7.23` を使用。
`--save-dev` は検証用依存、`--save-exact` はバージョン固定。ネットワーク確認時の `--fetch-retries=0` は再試行なし、`--fetch-timeout` はミリ秒での取得上限。
実行環境のnpm接続はEACCESとなったため、許可された制限外で情報取得・依存追加を実行した。
npmは既存Prisma・esbuild関係のインストールスクリプトの許可警告を表示したが、今回は許可設定を変更していない。今回の生成・validateは成功した。

## 実際の検証結果

- 公式CLIによるMySQL用の7モデルの生成：成功。
- 生成物のPrisma validate：成功。
- 検証用コードの型検査、本体の型検査・ESLint・業務テスト8件・本番ビルド：成功。
- 生成内容を前の案と照合し、関連付けの追加・削除・役割・ID型等の差を記録した。
- DB接続・テーブル作成・データ更新、ログイン・メール・Cookie・招待受諾、APIの権限拒否や競合テストは未実施。
- 本体には認証APIを追加していない。本体の依存・ロックファイル、AWS・CI/CD・Dockerfileは今回変更していない。

通常の検証は `npm.cmd run lint`（規約検査、内部の `--ignore-pattern dist`・`--ignore-pattern .next` で生成先を除外、自動修正なし）、`node --experimental-strip-types --test tests/domain.test.mjs`（型を取り除き指定テストを実行）、`npm.cmd run build`（本番用ファイルと型情報を生成）、`npx.cmd tsc --noEmit --incremental false`（コード出力・検査キャッシュ更新なしで型検査）。追跡済みキャッシュはビルド前へ戻した。

## 次の学習

まずschema-auth.config.tsのプラグイン設定、次に生成ファイルのUser・Session・Team・TeamMembershipを読む。
練習は「Sessionの選択中チームIDだけでは、案件を編集してよいと判断できない理由」を説明すること。
次は生成スキーマと案件案の統合を行う。その前提として、所属解除と履歴保持、2種類の役割への制限、未確定の入力仕様を具体化する。
その後にローカルDBへのマイグレーションと拒否条件の検証へ進む。

参考：[Organization](https://better-auth.com/docs/plugins/organization)、[CLIによるDB接続なしの生成](https://better-auth.com/docs/concepts/cli)、[Prismaアダプター](https://better-auth.com/docs/adapters/prisma)。
