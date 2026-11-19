# 会議の開始・確認・再開・終了

2026-11-15。今回の区切りは、ローカル接続版 `/workspace` で「会議を一通り進め、確認記録をDBへ残せる」こと。
確定要件の全業務確認を実装する最初の段階。重要業務優先・前回との差分・決定事項・招待が完成したという意味ではない。

## できること

- 所属メンバーは会議を開始できる。開始時の保管されていない案件を、納期・同日のID順で対象として固定する。通常一覧の1ページだけを流用しない。開始後に追加・復元された案件は次の会議から対象にする。
- 対象を自分の画面で選び、前後へ移動できる。確認成功後は次の未確認案件へ進む。他の参加者の選択は変えない。
- 確認した時点で、DBの最新の進捗・状態・案件版・確認者・日時を保存する。会議開始時や未確認の案件には確認記録を作らない。その後の進捗更新で保存した値を上書きしない。
- 会議中に確認を取り消し、最新値で再確認できる。取消前の記録は削除せず、取消者・取消日時を残す。監査履歴を一覧する画面/APIは今回の対象外。
- 画面を閉じても同じ会議を再開できる。再開時は最初の未確認案件を選ぶ。案件選択の位置そのものは個人の画面内状態で、DBに共有しない。
- 全対象から確認済み・未確認件数を算出する。終了前に未確認件数と全一覧を示す。残して終了する場合は明示確認が必要。終了後は確認・取消・進行役変更をAPIでも拒否する。次の会議は確認0件から開始する。
- 進行役は0人または1人。現在の所属者から選び、会議中に交代・解除できる。指定時は進行役本人だけが操作でき、管理者を特例にしない。未指定なら所属者全員が操作できる。

開始後に案件が保管されても、対象を途中で減らさず警告付きで残す判断にした。「新しい会議から外す」という要件に従い、既に始まった会議の対象・件数を保持する。会議は複数作成可能で、チームに進行中1件だけという制約は追加していない。

## ファイルと役割

| ファイル | 変更理由 |
| --- | --- |
| `db/design/integrated.prisma` | 会議、開始時の対象、確認/取消記録の3モデルを追加。チームを含む外部キーで誤関連付けを拒否する |
| `db/design/migrations/20261115_meeting_round/migration.sql` | 既存テーブルを削除せず、3テーブルを追加する変更履歴 |
| `lib/siteflow/domain.ts` | 進行権限、入力項目・版番号の検証、対象上限を画面/HTTP処理から独立させる |
| `examples/mysql/meeting-service.ts` | 所属・進行役を再確認し、確認記録と会議の版を同一トランザクションで保存する |
| `examples/mysql/web-api-handler.ts` | 既存のHost/Origin・セッション・所属確認に会議ルートを接続する |
| `components/siteflow/meeting-workspace.tsx` | 会議一覧・進行・終了確認、10秒取得、失敗時の再試行を追加する |
| `components/siteflow/connected-workspace.tsx` / `.module.css` | 会議の入口と、既存画面に合わせたスマホ対応を追加する |
| `examples/mysql/local-workspace-data.ts` | 一時検証データを会議の参照順に回収できるようにする |
| `examples/mysql/check-backup-restore.mjs` | 会議の確認・取消・終了記録もバックアップ/復元の全行照合に含める |

Next.js内のAPIと従来の分離APIは同じ会議処理を使う。新しい依存ライブラリは追加していない。旧指摘管理デモ `/` は会議機能とは別。

## API

`/api/siteflow` がNext.js統合版の接頭辞。分離APIの検証では `/api`。

| メソッド・パス | 内容 |
| --- | --- |
| `GET /teams/:teamId/meetings` | 開始日時の新しい順。既定20件・上限50件、`nextCursor` で続き |
| `POST /teams/:teamId/meetings` | `{ facilitatorUserId: null または現在所属者のID }`。空オブジェクトなら進行役なし。対象のIDや役割をクライアントから受け取らない |
| `GET /teams/:teamId/meetings/:meetingId` | 全対象、確認時の値、現在値、全件数、操作可否を取得 |
| `PATCH /teams/:teamId/meetings/:meetingId` | `action`、`expectedVersion` と、操作に必要な項目だけを受け付ける |

操作は `confirm` / `unconfirm`（`entryId`）、`facilitator`（`facilitatorUserId`）、`finish`（`allowUnconfirmed`）。進捗や確認者の偽装入力は拒否する。
エラーは既存と同じ `{code,message}`。未認証401、所属/進行権限403、対象なし404、古い版/終了済み/未確認の終了409。入力不正400、本文上限4096バイト超過413、JSON以外415、対象外メソッド405。

会議版を比較する前に会議行をロックし、記録と版更新をまとめる。二人が同じ版で保存した場合は一方を409にする。確認する案件もロックして、その時点の値を読む。保存の最後に失敗した場合は記録も取り消す。

## 再現コマンド

以下は既存のローカルMySQLと、分離した検証専用DBが準備済みのPC用。本番へ適用する手順ではない。

| 実行場所・コマンド | 目的・オプション・影響 |
| --- | --- |
| `examples/mysql` : `npm.cmd run generate:integrated-design` | Prisma Clientをローカル生成。既存スクリプトの`--schema`が統合モデル、`--config`が設定の場所。DB変更なし |
| 同 : `npm.cmd run migrate:schema-check` | `migrate deploy`で未適用の履歴のみを検証専用DBへ適用。専用設定がDB名・ユーザー・ポートを検査。今回3テーブルを追加する |
| 同 : `npm.cmd run test:meeting` | Nodeの`--import tsx`でTypeScriptを読み、`--test`で会議のHTTP/実DBテストを実行。一時ユーザー/チーム/案件/会議を作り、終了時に回収する |
| 同 : `node --import tsx check-integrated-next.mjs --meeting-browser` | Next.jsをPC内の空きポートで起動し、`--meeting-browser`で専用Chromeの操作検証を追加。秘密情報は画面やログに出さず、一時データとプロセスを回収する |
| 同 : `npm.cmd run test:backup-restore` | 使い捨てDBへダンプ/復元し、全テーブル・全行を照合。既存DBへの上書きを拒否。終了時にDB/ユーザー/SQLを回収する |
| ルート : `node --experimental-strip-types --test tests/domain.test.mjs tests/meeting-domain.test.mjs` | 型注釈を除去して業務ルールを検査。DBの起動/変更なし |
| ルート : `npx.cmd tsc --noEmit --incremental false` | 型検査のみ。JSや検査キャッシュを生成しない。API例は`--project examples/mysql/tsconfig.json`を追加して検査する |
| ルート : `npm.cmd run lint` / `npm.cmd run build` | 書式/Reactの規則を検査し、公開用生成物を組み立てる。ビルドは`.next/`とDB操作用コードを生成するが、公開しない |

SQL生成には既存の`prisma-design.config.ts`を使う。このCLI/エンジンではdatasourceのない設定だと差分が出力されない既知の問題がある。専用設定の形式用URLは実DBへ接続するためのものではない。

## 到達点と次の区切り

業務46件、会議HTTP/DB11件、既存API102件、会議ブラウザー7項目、Next.js統合の従来5項目が成功。会議込みの16テーブルを復元し、全行一致を確認。一時DB/データは回収済み。型検査・lint・ビルドの最終結果は`VERIFICATION.md`の最新節を参照。
スクリーンショット・結果はGit対象外の`work/meeting-browser/`、DB検証ログは`work/meeting-api.log`、復元結果は`work/backup-restore/results.json`。

今回の変更履歴は追加のみ。旧アプリへ戻す場合も、新テーブルを即削除せず記録を保持する。確認/取消の履歴を捨てる自動down処理は作っていない。実公開前のDBマイグレーション・復元・切替は個別承認を受けて検証する。

**ここで一区切り。** 次は「最後の有効な確認記録からの差分表示」が小さな次段階。重要業務優先・相談事項・決定事項・作業項目・招待/実メール認証は未完成。進行役の所属解除時の復旧、取消監査の閲覧画面も残る。500件を超える会議は切り捨てず開始を拒否し、上限拡張/ページ設計は実測後に検討する。性能の数値目標はまだ達成扱いにしない。

AWS・本番DB・CI/CD・Dockerfile・配信設定・契約は変更していない。今回のローカルのマイグレーション適用を、本番への適用結果と混同しない。
