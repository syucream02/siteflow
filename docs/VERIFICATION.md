## 2026-11-25：チーム作成・所属管理・本人専用招待（ローカル実装・本番未反映）

既存APIを再利用したチーム作成、所属0件導線、チーム設定/改名、メンバー一覧、admin/member変更、本人宛て招待の承認/辞退/取消、条件付き所属解除/退出を接続した。一般公開登録・招待限定登録・実メール本人確認/送信は公開前の検討課題として残す。Organizationプラグインは有効化していない。不在進行役は検出と報告だけで、復旧しない。

### DBと保護

既存のDocker Desktop local MySQL、REQUIRES_APPROVED_PUBLIC_IPV4:3307、専用DB/ユーザー、手動確認用DBの一致を実接続で照合。既存migrationは完了、Invitationは0件だった。旧招待を推測で有効化していない。固定RSA公開鍵設定・認証方式・ユーザー権限は維持した。

20261125_team_managementはTeam.versionをNOT NULL DEFAULT 1で追加するだけ。Prisma migrate deploy成功後にClient生成。別開発DB・本番への適用、reset、既存データ削除は行っていない。

適用前SQL56,984バイト、適用後SQL57,229バイトを所有者限定のGit除外work/team-management-backupへ保存。既存業務14表の全行/既存列と、認証3表のID/件数が指紋一致。Teamの新列だけを比較対象から分け、既存行がすべてversion=1であることも確認した。会議の追加3表を含むデータを保持している。

復元は空の隔離先へのみ行い、既存DBへSQLを上書きしない手順。今回は復元用DBの新規作成・実復元を実行していない。バックアップは認証情報を含み得るので、Git・チャットへ出さない。

### 自動検証結果

| 検証 | 結果 |
| --- | --- |
| 新規チーム入力・期限判定 | 4件成功 |
| 新規専用MySQL/実HTTP | 18件成功。権限、チーム分離、同時退出、担当追加と解除、承認と取消、再利用、7日/期限切れ、ロック待ち中の期限切れ、降格/解除/退出時の保留取消、過去記録不変、人物再利用、途中例外の全取消、ページ分割、不在進行役の検出 |
| 業務・検索・中継の関連テスト | 116件成功。新規入力4件と中継追加1件を含む |
| 既存の専用DB/実HTTP回帰 | 認証/案件102件、会議15件、対応事項12件、検索DB6件、計135件成功 |
| Node試験の重複を除く合計 | 269件成功、失敗・スキップ0。新規23件＋既存246件 |
| TypeScript | 本体とexamples/mysqlの両方で成功 |
| ESLint | 変更コード・テスト17ファイル、エラー・警告0 |
| Next.js build | 16.3.4、検証専用キャッシュで成功。既存tsbuildinfoとnext-envの内容を保持 |
| 新規Chrome通し | 11項目成功。所属0件、Enter作成、25メンバー/21招待、戻る/409保持、役割/解除確認、招待作成/取消/辞退/参加、一般メンバー表示、退出後403、別チーム/セッション維持、外部解除時の表示クリア |
| 作成応答喪失のChrome試験 | 1項目成功。実DB保存後のHTTP応答をChromeで遮断し、自動再送・重複作成なし、所属一覧で作成済み1件を確認 |
| 共有UIの既存Chrome回帰 | 検索15項目、会議記録11項目、計26項目成功。利用者による手動操作確認ではない |

通常の実ブラウザー試験はAPI本文のモック/差替えを使わない。応答喪失試験だけは--creation-failure-onlyで通信を遮断する。全試験は架空ユーザー/チームだけを作り、終了時に回収し既存データの前後指紋を照合した。

初回Chromeは試験のEnter送信先にフォーカスがなく作成できず失敗。フォーカスを明示し、画面にも入力開始時のフォーカスを追加した。次の試験はチーム名の「辞退」で待機条件を満たしてしまい、辞退更新完了前に承認へ進んで失敗。状態とボタン再有効化を待つ条件へ修正して最終通し成功。いずれも試験データ回収済み。Lintの描画中Date.nowはサーバーの期限判定値へ変更。旧中継テストのTeams POST拒否だけを採用仕様に合わせて更新し、DELETE等の拒否と未知パス拒否は維持・追加した。

画像はwork/team-management-real/team-1440.png、team-390.png。結果は同results.json、応答喪失はwork/team-management-fault/results.json。Git除外。画像も目視して折返し・操作ボタン・入力欄を確認した。

### 変更ファイル

- DB：db/design/integrated.prisma、db/design/migrations/20261125_team_management/migration.sql。
- 業務/API：lib/siteflow/domain.ts、lib/siteflow/api-proxy.ts、examples/mysql/team-membership-service.ts、team-invitation-service.ts、team-management-handler.ts、web-api-handler.ts（後ろ3件も同examples/mysql）。
- 画面：components/siteflow/team-create.tsx、team-settings.tsx、team-invitations.tsx、connected-workspace.tsx、meeting-workspace.tsx、workspace-api.ts（同components/siteflow）。
- 検証：examples/mysql/local-workspace-data.ts、examples/mysql/check-team-management-e2e.mjs、tests/team-management.test.mjs、tests/team-management-db.test.mjs、tests/local-api.test.mjs。
- 資料：docs/LEARNING_GUIDE.html、MEMBERSHIP_AND_HISTORY.md、DATA_MODEL.md、LOCAL_WORKSPACE.md、NON_FUNCTIONAL_REQUIREMENTS.md、VERIFICATION.md（同docs）。

計25ファイル。既存の案件・会議サービスの権限は緩和せず、業務の所属行ロックを管理側のロック順序で再利用した。進行役代行、会議外対応事項更新、業務の自動引き継ぎは追加していない。

保護確認：開始時の未コミット36項目はすべて保持。直接関係する12項目へ変更を追加し、残る24項目は状態・SHA-256とも不変。CD/workflow/依存設定/除外生成物など既存保護99ファイルもSHA-256一致。終了時は49項目、ステージ空。ブランチfeat/nextjs-mysql-approved-cd、HEAD d60a85a3abd2f95dd5a3c50085f9e6c917997ac6を維持。commit/pushなし。HTMLタグ整合・JavaScript/JSON構文・新テーマ参照ファイル・ローカルMarkdownリンク・git diff --checkを確認した。完全なHTML規格適合性や全リンクの外部到達性を検証した意味ではない。

### 再現コマンドの意味

- SITEFLOW_TEAM_CHECK=1をこのプロセスに設定し、node --experimental-strip-types --test tests/team-management.test.mjs tests/team-management-db.test.mjs：型注釈を除去し、指定の入力4件とDB/API18件を実行する。専用DBの試験データだけを書き込み、回収する。フラグなしのskipは成功に含めない。
- npx.cmd --no-install tsc --noEmit --incremental false：導入済みTypeScriptで型検査し、JSと検査キャッシュを出力しない。--project examples/mysql/tsconfig.json付きではAPI例の設定を使う。DB変更なし。
- npx.cmd --no-install eslint に変更ファイルを列挙：導入済みESLintで対象だけを検査する。--fixなしでファイルを書き換えない。
- SITEFLOW_LOCAL_CHECK=1とNEXT_TELEMETRY_DISABLED=1をこのプロセスに設定しnpm.cmd run build：既存のprebuildでClient生成後、検証専用キャッシュに本番形式の生成物を作る。公開・DB適用は行わない。
- SITEFLOW_TEAMS_BROWSER_ORIGIN=http://REQUIRES_APPROVED_PUBLIC_IPV4:5192をこのプロセスに設定しnode --experimental-strip-types examples/mysql/check-team-management-e2e.mjs：実ChromeでPC内の新規起動Next.jsへ接続する。--creation-failure-only付きは応答喪失1項目だけ。指定なしは通常11項目。架空データ・専用Chromeを回収し、成功時にPASSとcleanup verifiedを表示する。

未実施：利用者による手動確認、実復元、本番・別開発DB適用、実メール本人確認と登録、全ブラウザー/読み上げ/全キー操作、全競合・分散時計・大量データ性能、不在進行役の限定復旧。CDは変更せず、本番CDのGO判定に使わない。

---

## 2026-11-25：会議の相談・決定・選択的引き継ぎ（ローカル実装・本番未反映）

- 対象：追加3モデル・migration、会議記録API、進行役による保存、会議別snapshot、選択的引き継ぎ、未保存入力保護。既存案件検索の差分は保持した。
- 接続：既存ローカルDocker MySQL8.4.13、REQUIRES_APPROVED_PUBLIC_IPV4:3307、専用DB・専用ユーザーを実接続で照合。手動アカウントのDBも同一と確認。RSA公開鍵固定を再利用し、認証・ユーザー・権限は変更していない。
- migration：20261124_meeting_recordsをPrisma migrate deployで適用。追加テーブル3件・複合FK・一意制約・索引のみ。過去会議への推測補完・既存列削除・resetなし。Prisma validateとClient生成も成功。差分SQL生成はdatasourceの形式用URLを設定して解決し、空のmigrationを適用していない。
- 保護：適用前SQL44,086バイトと適用後SQL52,960バイトを所有者制限付きGit除外フォルダーに保存。適用後SQLには新3テーブルのDDLがある。既存業務10テーブルの全行指紋、認証3テーブルのID/件数が前後一致。新テーブルは試験回収後0件。新テーブルを含む実復元は未実施。

| 実施した検証 | 結果 |
| --- | --- |
| 新規入力・状態検証 | 4件成功 |
| 新規実HTTP/専用MySQL | 12件成功。メモ保存・編集、終了後不変、権限/チーム/FK拒否、引き継ぎ重複・元記録偽造・完了/取消からの復活拒否、複数会議の本体版照合、終了と保存の競合、改名/退会時再割当、ページ分割、途中例外の全取消 |
| 既存の関連業務・検索・中継 | 107件成功（新規入力4件と一緒に111件実行） |
| 既存の実DB/API回帰 | 認証/案件102件・会議15件・検索DB6件、計123件成功 |
| Nodeテスト合計（重複実行を除く） | 246件成功、失敗・スキップ0件。CDの無関係な回帰試験は再実行していない |
| TypeScript | 本体とexamples/mysqlの両方で成功。--noEmit --incremental false |
| ESLint | 変更対象13コード/テストファイルでエラー・警告0 |
| Next.js build | 16.3.4、検証専用キャッシュで成功。生成された既存tsbuildinfo/next-envを元の内容に戻した |
| 実MySQL→実API→Next.js→Chrome | 11項目成功、API50応答。ログイン、10秒更新/戻るの入力保持、登録、実409比較後再保存、引き継ぎ、スマホ編集・完了・過去記録保持、Tab操作、PC1440/390画像、元会議の閲覧、他チーム拒否、既存検索への復帰 |

初回のChrome検証は既存5187サーバーで新記録APIに到達できず失敗。ハンドラーをメモリに保持していたため、新しい5191サーバーと検証専用キャッシュへ切り分けた。次の試験では保存後の再取得中に終了操作が反映されないケースを検出し、再取得中はボタンを無効化し、保存後の会議再取得完了を待つよう修正。修正後と最終スタイル調整後の通し試験は成功した。失敗時も試験データは回収済み。既存5187サーバーとMySQLは停止していない。

実画像・結果はGit除外のwork/meeting-records-real/meeting-1440.png、meeting-390.png、results.json。画像も目視し、入力欄の境界・ラベル・状態・折り返しを確認した。再現用はexamples/mysql/check-meeting-records-e2e.mjs。応答モックやDBの代替データを使わず、一時チームだけを作成・回収して前後指紋を照合する。

### 変更ファイルと保護結果

- DB：`db/design/integrated.prisma`、`db/design/migrations/20261124_meeting_records/migration.sql`。
- 入力・API：`lib/siteflow/domain.ts`、`lib/siteflow/api-proxy.ts`、`examples/mysql/meeting-record-service.ts`、`examples/mysql/meeting-service.ts`、`examples/mysql/web-api-handler.ts`。
- 画面：`components/siteflow/meeting-records.tsx`、`meeting-workspace.tsx`、`connected-workspace.tsx`、`workspace-location.ts`、`connected-workspace.module.css`（後ろ4件も同ディレクトリ）。
- 試験と回収：`examples/mysql/local-workspace-data.ts`、`examples/mysql/check-meeting-records-e2e.mjs`、`tests/meeting-records.test.mjs`、`tests/meeting-records-db.test.mjs`。
- 資料：`docs/LEARNING_GUIDE.html`、`LOCAL_WORKSPACE.md`、`MEETING_FLOW.md`、`DATA_MODEL.md`、`NON_FUNCTIONAL_REQUIREMENTS.md`、`VERIFICATION.md`（同docsディレクトリ）。

今回22ファイルに変更/追加。開始時の未コミット23項目は全件保持し、直接関係する9項目へ変更を追加、残る14項目はSHA-256も一致。CD/workflow/依存設定/除外生成物など既存保護99ファイルもすべて一致。終了時の未コミットは36項目、ステージは空。ブランチfeat/nextjs-mysql-approved-cd、HEAD d60a85a3abd2f95dd5a3c50085f9e6c917997ac6を維持。commit/pushなし。

### 検証コマンドの意味

- node --experimental-strip-types --test tests/meeting-records.test.mjs tests/meeting-records-db.test.mjs：NodeがTypeScriptの型を除去して指定のテストだけを実行する。実DB試験は、このプロセスの環境変数SITEFLOW_MEETING_RECORDS_CHECK=1を明示して実行する。既存専用DBの試験用チームへ書き込み、回収する。フラグなしのskipを成功件数へ加えない。
- npx.cmd --no-install tsc --noEmit --incremental false：導入済みTypeScriptだけで型を検査。--no-installは新規導入しない、--noEmitはJSを作らない、--incremental falseは検査キャッシュを書かない指定。--project examples/mysql/tsconfig.jsonを加えた試験ではAPI例の設定を使う。DB変更なし。
- npx.cmd --no-install eslint に変更ファイルのパスを列挙：導入済みESLintでそのファイルを検査する。--fixは付けず、書き換えない。エラー・警告0を期待する。
- SITEFLOW_LOCAL_CHECK=1とNEXT_TELEMETRY_DISABLED=1をこのプロセスへ設定してnpm.cmd run build：既存のprebuildでClientを生成し、検証専用キャッシュにNext.jsをビルドする。公開・DB適用をしない。
- SITEFLOW_RECORDS_BROWSER_ORIGIN=http://REQUIRES_APPROVED_PUBLIC_IPV4:5191をこのプロセスへ設定し、node --experimental-strip-types examples/mysql/check-meeting-records-e2e.mjs：このPCの新規起動Next.jsへ実Chromeで接続。実ログインと一時データ書き込み、画像保存、回収・前後照合を行う。パスワード・Cookie値は出力しない。成功時はPASS 11とcleanup verifiedを表示する。

未検証：本番適用、別の開発DB、追加3テーブルの実復元、全ブラウザー・読み上げ・全操作のキーボード、高負荷・長大履歴・全デッドロック・端末強制終了からの下書き復元。ローカル検証結果を本番CDのGOとは扱わない。CDファイル・AWS・本番・Git履歴を変更していない。

---

# 案件検索の実ブラウザー通し試験（2026-11-24）

- `examples/mysql/check-project-search-e2e.mjs`を追加。実Chrome→PC内Next.js統合API→Prisma→固定RSA公開鍵→専用MySQLを接続。Fetchによる応答差し替えは使わず、68件の実API応答を観測。15項目成功。
- 確認範囲：実ログイン/HttpOnly Cookie、案件名/番号/特殊文字、主副担当/状態/進捗0のAND条件、候補2ページ目、25件の総件数と20→25件の追加取得、0件と未登録、リセット、再読込/戻る/進む、チーム切替、実セッションの他チーム403、詳細編集とDB保存/再取得、会議25案件の確認/取消監査/終了、通常/保管切替、スマホEnter検索、ログアウト後401。
- PC1440px・スマホ390pxの画像を保存し、実画像も確認。横はみ出しなし。保存先はGit除外の`work/project-search-real/search-1440.png`、`search-390.png`。結果は同フォルダーのresults.json。以前のwork/project-searchは模擬APIであり、今回とは別。
- 開始前に専用DB名とCURRENT_USERを照合。架空の一時アカウント・チーム・案件・候補だけを操作し回収。業務10テーブル全行と認証3テーブルID/件数の指紋は前後一致。既存の手動確認アカウントも秘密値を出さず読み取り照合し、有効だった。
- 初回の会議試験は、確認後の自動次案件表示が完了する前にスクリプトが選択を変えてタイムアウト。UIが操作可能かつ確認件数が反映済みになるまで待つよう検証だけを修正し、再実行で15項目成功。初回失敗時も一時データの回収と既存指紋一致を確認。アプリコードの修正なし。
- 新規検証スクリプトのESLint・構文、資料の整合性を確認。成功済みの型検査・build・業務/API/DB回帰・模擬Chrome試験は再実行していない。大量データ性能・全ブラウザー・本番反映は対象外。

起動はLOCAL_WORKSPACE.md冒頭の統合モードを使用する。`node --experimental-strip-types examples/mysql/check-project-search-e2e.mjs`は、Nodeが型注釈を読み飛ばして通し検証を起動する。接続は既定でPC内5187番、RSA固定済みの専用DBだけ。専用Chromeを起動し、一時データの作成/操作/削除とGit除外領域への画像保存を行う。資格情報をログ・コマンド引数へ出さない。今回の一時Next.jsは終了し、既存MySQLは起動状態を維持した。下記の単体・DB試験は前段の結果として保持する。

# RSA固定後の実DB検証完了（2026-11-24・ローカルのみ）

- 既存MySQLの認証方式caching_sha2_passwordとMariaDB 3.5.4を確認。信頼済みローカルDockerからRSA公開鍵のみを取得し、標準PEMとSPKI DERのSHA-256へ正規化。Git除外ファイル/専用設定に固定した。秘密鍵の取得・パスワード/権限変更・公開鍵の無条件取得なし。
- ローカル専用接続へcachingRsaPublicKeyとallowPublicKeyRetrieval:falseを適用。production拒否・専用DB/ユーザー/ポートの検証は維持。本番接続設定/TLS・CD・スキーマ・依存は変更しない。実SQLで専用DBとCURRENT_USERの一致を確認した。
- **実MySQL/HTTP：検索6件・認証/案件管理102件・会議15件＝123件成功、失敗/スキップ0件。** 名前と番号のOR、主副担当・状態・進捗のAND、総件数/カーソル、通常/保管、未ログイン・他チーム・所属失効、空一覧を検証。%・_・バックスラッシュ・引用符は文字として一致。案件name/code列はutf8mb4_unicode_ciで、英字大小・É/é/eの同一視を実検索で確認。
- **RSA固定の単体9件成功。** 一致鍵、未設定、不正/過大PEM、全0/不一致指紋、末尾データ、1024bit RSA・EC鍵を検査。認証キャッシュの有無に依存せず、ファイル/指紋の検証を接続前に行う。
- 初回の案件管理回帰で新しい総件数項目を含まない旧期待値1か所が失敗し、total/collectionTotalの期待値を追加して102件を再実行・成功。安全条件を緩和しない。型検査で公開鍵返り値の文字列型を明示する修正も行い、本体/API型検査・関連ESLint・Next.js buildが成功。
- 試験前後で専用DBの業務10テーブルの全行指紋、認証3テーブルのID指紋・件数が一致。既存22案件・4ユーザーなどを保持し、架空の試験データは回収済み。既存の開発DB・本番DBへは接続しない。MySQLコンテナ/ボリュームの再作成、DB初期化、migrationなし。

実行コマンド：`node --test tests/local-mysql-rsa.test.mjs`はNode標準テストで一時試験鍵の公開部分だけを検証し、実DBを操作しない。`SITEFLOW_SEARCH_CHECK=1`を子プロセス環境に指定した`node --experimental-strip-types --test tests/project-search-db.test.mjs`は型注釈を読み飛ばして専用DBの検索6件を実行。`node run-auth-check.mjs`と`node run-meeting-check.mjs`はexamples/mysql内の既存ランナーで、それぞれ明示フラグとtsxを使い認証/案件・会議のHTTP/DB試験を起動する。既存DB名/ユーザーを照合し、テスト専用データだけを作成/回収する。コマンドの引数へ資格情報は渡さない。

コード変更があるため本体/APIの`tsc --noEmit --incremental false`（生成物/型キャッシュを出さず型検査）、対象ESLint（自動修正なし）、`npm.cmd run build`（既存prebuildのPrismaクライアント生成とNext.js build、migration/公開なし）を実行。成功済みの模擬Chrome14項目・無関係なCD回帰は再実行していない。RSA認証は通信全体のTLS化とは別。公開DBの照合順序一致・大量データ性能・本番反映は未検証。以下の停止記録は過去の経過として保持する。

# 実DB試験の再開結果（2026-11-24・認証段階で停止）

- ユーザー承認後、PC内Docker Desktop/Engineの起動を確認。既存siteflow-dev-mysql-1（mysql:8.4.13）とsiteflow-dev_mysql-dataが存在し、image・Compose project/service・REQUIRES_APPROVED_PUBLIC_IPV4:3307→3306・ボリューム・所有ラベル・既存環境設定の一致7項目を確認した。秘密値は非表示。
- 確認済みComposeで既存コンテナだけをstart。再作成・pull・ボリューム削除なし。起動前後で同じコンテナID、起動後running/healthy、restart count 0。TCP接続は成功し、従来のECONNREFUSEDは解消。
- 専用設定からのPrisma接続はSELECT 1の認証段階でP2010 / ドライバー45028 / SQLSTATE HY000により失敗。エラー全文は出さずRSA公開鍵関連であることを分類。既存mariadbドライバーのcaching-sha2-password-auth.jsでは、完全認証時に検証済みの安全な接続またはcachingRsaPublicKeyがなく、allowPublicKeyRetrievalも無効ならこのエラーになる。
- DB名/ユーザーの実照合と既存データ指紋の読み取りは完了せず、検索の実MySQL試験、認証/チーム分離、案件管理・会議のDB回帰は開始していない。テスト用データの作成・変更・削除なし。MySQL起動に伴う内部書き込みと、試験データの書き込みは区別する。
- 認証条件・TLS・権限・パスワード・スキーマは変更せず停止。公開鍵の無条件取得を有効にせず、信頼済みローカルDocker経由で確認した固定RSA公開鍵を使う方法、または検証済みTLSを使う方法を別承認で検討する。再起動で完全認証が必要になった可能性はあるが、過去の認証キャッシュは未確認。
- 成功済みの型検査・lint・build・模擬Chromeを再実行していない。以下の124件/14項目などは前回の成功記録で、今回実DB試験が成功した意味ではない。

今回の`docker --context desktop-linux compose --env-file .env.mysql.local -f compose.dev.yaml start mysql`は、contextで確認済みPC内Engine、env-fileで既存設定、fで既存Composeを選び、start mysqlで既存サービスだけを起動する。データ保存先を作り直すupや削除操作は使わない。inspectは実設定の読み取り、config --quietは設定を表示しない構文検査に使用した。DB確認のSELECT 1は接続後の最小読み取り、SELECT DATABASE()/CURRENT_USER()は実接続先の照合用だが、今回どちらも認証が完了しないためSQLの成功には至っていない。

# 案件検索・絞り込み（2026-11-24・ローカル実装）

- 案件名/番号の部分一致、主副担当・状態・進捗範囲、通常/保管、総件数、検索条件のURL復元を実装。DB定義・依存・CDは変更なし。
- 本体とexamples/mysqlの型検査成功。業務・会議・接続/中継・今回の条件/APIハンドラーを合わせて124件成功（検索追加28件）。認可の試験は模擬Prisma/セッションであり、実認証のHTTP/DB試験ではない。
- 今回の変更対象のESLintはエラー・警告0件。実DB試験ファイルの構文検査とgit diff --checkも成功。既存の案件0件テストは新しいtotal/collectionTotalの応答契約へ期待値を更新したが、実DBでの再実行は未実施。
- 実Chromeは架空API応答で14項目成功。20→25件追加、複合検索、候補2ページ目、URL再読込/戻る/進む、0件と未登録、通信失敗/再試行、旧応答排除、チーム切替、1440/390px、Enter検索。画像：work/project-search/search-1440.png、search-390.png。
- ローカル検証DBは設定上loopback・専用DB/ユーザーに制限されるがTCP接続がECONNREFUSED。実接続先の照合完了・架空データ作成・実MySQL検索・HTTP/DB試験は未実施。本番へ接続しない。専用のtests/project-search-db.test.mjsを用意したが、成功扱いしない。
- Next.js buildは制限環境で既存作業フォルダー参照の拒否により失敗。権限設定を変えず通常権限で再実行し成功。前段の2回のChrome試験は開発時二重取得とEnter模擬入力の不備で失敗し、検証側を修正して最終14件成功。

### 再確認コマンドと意味

- `npx.cmd --no-install tsc --noEmit --incremental false`：既存TypeScriptで本体の型を検査する。no-installは依存取得なし、noEmitは出力なし、incremental falseは既存の型キャッシュを更新しない指定。API側は同じコマンドに`--project examples/mysql/tsconfig.json`を加えて対象設定を指定する。
- `node --experimental-strip-types --test tests/project-search.test.mjs tests/project-search-api.test.mjs`：Nodeが型注釈を読み飛ばし、指定した入力ルール/API模擬試験だけを実行する。DB・ネットワーク・既存データを変更しない。関連124件の検証ではdomain・meeting-domain・local-api・integrated-api・workspace-connection・public-api-proxyの既存テストも指定した。
- 実DBが利用できる時だけ、PowerShellで`$env:SITEFLOW_SEARCH_CHECK='1'`を設定して`node --experimental-strip-types --test tests/project-search-db.test.mjs`を実行する。フラグは専用DB試験の明示許可、testの引数は対象ファイル。loopback設定とSELECT DATABASE()/CURRENT_USER()を照合後、架空ユーザー/案件だけを作成して後片付けする。DB新設・migration・本番接続はしない。終了後は`Remove-Item Env:SITEFLOW_SEARCH_CHECK`でこのシェルのフラグだけを解除する。
- `node examples/mysql/check-project-search-browser.mjs`：PC内5187番の実React画面を専用Chromeで試験する。API応答はすべて架空で、実DB検証の代わりにはならない。専用プロファイルとGit除外work/project-searchへ画像を作成する。通常ブラウザーや本番には触れない。対象サーバーは`node node_modules/next/dist/bin/next dev --hostname REQUIRES_APPROVED_PUBLIC_IPV4 --port 5187`で起動できる。nodeの引数は既存Next.js本体、devは開発起動、hostnameはPC内限定、portは待受番号。SITEFLOW_WORKSPACE_MODE=localの開発モードで使い、既存環境ファイルは書き換えない。
- `npx.cmd --no-install eslint <対象ファイル>`：導入済みESLintで今回のコードを検査する。対象パス以外へ自動修正せず、依存を追加しない。`npm.cmd run build`は既存のprebuild（Prismaクライアント生成）とNext.jsの本番ビルドを実行し、DBへのmigrationや公開はしない。

実MySQLの特殊文字・照合順序、HTTP/DBでのチーム分離、既存案件登録/編集/会議の実DB回帰、大量データ性能、本番公開は未検証。以下は過去の記録として保持する。

# 最新：GitHub反映前のCI・README整理（2026-11-23・ローカルのみ）

- CIに会議ルール13件の1ステップを追加し、READMEにローカル実装済み/本番未反映/未完成を明記。自動デプロイ未導入は維持。既存のCD保留差分は削除・有効化していない。
- 今回分だけのCI候補（HEAD＋3行）のYAML・既存構造維持・失敗無視なし・後続依存・mainだけのGHCR保存・保留差分除外をローカル確認。追加パッチは適用可否だけ検査し、ステージなし。**作業ツリーのci.yml全体は送信対象ではない。**
- 本体/API型検査・全体lint・build・関連100件成功（会議13件を含む）。Node24.20.0で実行。GitHub/Node22での実Actionsは未確認。直前に成功したHTTP/DB15件・Chrome12項目を今回の再実行と混同しない。
- 公開候補は会議11＋README＋CI追加部分の13ファイル。追加行の秘密値・個人PC絶対パスは該当なし。既存資料のリソースID・既存Chromeパスは残存事項。詳細は[会議資料](MEETING_FLOW.md)冒頭。
- 本番DB/AWS接続、DBマイグレーション、Git commit/push/PR/マージ、Actions実行・CD有効化はしていない。

# 会議の状態表示漏れ修正（2026-11-23・ローカルのみ）

- 前回記録なし/今回未確認でも現在の状態名を表示するよう、画面の条件だけを修正。終了済みの確認時状態と現在情報は別欄。増減・状態変更判定・確認取消・SQL・DB構造は変更なし。
- 本体/API型検査、全体lint、build、業務55件、HTTP/DB15件、実Chrome会議12項目（3項目追加）、従来Next.js統合5項目がすべて成功。1440/390pxで横はみ出しなし。確認取消後の状態表示・終了時未確認の当時状態を推測しないことも確認。
- Chromeの画像/結果はGit除外の `work/meeting-browser/`。追加画像は `meeting-no-previous-390.png`。一時Next.js/Chromeと架空データは検証後に回収。
- CI最小案・README修正文・大量履歴の件数/実行計画/索引の確認方法は[会議資料](MEETING_FLOW.md)へ記録。CI/READMEは未変更。EXPLAINや大量履歴の負荷試験は未実施。
- 本番DB/AWSへの接続、マイグレーション、Git commit/push/PR/マージ、本番デプロイは行っていない。既存保留ファイルは作業前の内容を保持する。
- 最終ハッシュ照合で今回変更した5ファイル以外は一致。保留42ファイル・README・Dockerfile・DB定義を保持した。検証後はローカルMySQLを正常停止し、稼働コンテナ0件を確認して今回起動したDocker Desktopも通常終了。テスト開始前の停止状態へ戻した。

# 会議の進捗差分表示（2026-11-22・ローカルのみ）

- 業務55件（差分9件追加）、会議HTTP/DB15件（4件追加）、実Chrome会議9項目、従来Next.js統合5項目成功。本体/検証API型検査・全体lint・build成功。
- 前回の有効確認・ポイント増減・状態だけの変更・記録なし・取消除外・同時刻の順序・会議開始後終了の除外・確認後の変更・終了済み記録保持・別チーム/案件拒否を検証。
- PC1440px/スマホ390pxで画像目視・横はみ出しなし。10秒取得・入力/選択保持・保存/取得失敗・409・Escape/Tab/Enter・取消/再確認・終了後に現在95％になっても当時80％との差分保持を確認。
- ローカルMySQL初回認証の公開鍵不足で準備15件未実行→コンテナから取得した公開鍵を明示した初回接続で解消→15件成功。公開鍵自動取得/秘密鍵取得/権限拡大はなし。ビルドは実行制限下の保護フォルダー列挙で失敗→通常環境で成功。原因を無関係なコード変更で回避していない。
- DB定義/マイグレーション、正式DB/公開環境、CI/CD/OIDC、Git commit/pushは変更・実施なし。架空データは検証専用DB内だけで作成・回収。
- 詳細・変更ファイル・API項目は[会議仕様](MEETING_FLOW.md)冒頭。画像/結果はGit除外の `work/meeting-browser/`、統合試験結果は `work/integrated-next/`。大容量履歴での性能・本番反映・全ブラウザー/読み上げは未検証。
- 学習ガイド新テーマの図3状態・PC/スマホ幅・外部HTTP遮断・JavaScript例外0を実Chromeで確認。既存85テーマID/127履歴を保持し86/128へ追加。保留中42ファイルのSHA-256一致、検証後のローカルMySQL正常停止を確認した。

以降は過去時点の記録であり、未実装/未公開などの記述は記録当時の状態を表す。

# 公開前HTTPS・PCブラウザー・候補復旧・CD検証（2026-11-17）

最新（2026-11-17 21:21 JST）：**PC実Chromeの非公開HTTPSでログイン・案件保存35％・再読み込み・ログアウトに成功**。証明書dry-run/再読込hook/通常renew正常（実証明書の期限延長なし、11月21日15:26 JST）。候補だけの停止再開と保存保持も成功、旧Vinext/Nginxルーティング維持・HTTPS200。S3/IAMは承認待ち、GitHub production未作成、CD/公開経路変更はローカル準備のみ。詳細は[21節](PREDEPLOY_VALIDATION.md#21-公開前準備証明書非公開ブラウザー復旧cd)。後段は過去の履歴を含む。

- 証明書dry-run/active certのreload hook/通常renew正常、期限は11月21日のまま。強制更新なし。初回のランダム待機timeoutは手動試験の待機制御を修正し再試験成功。
- PCの実ChromeでHTTPS信頼/実Cookie/登録保存/再読込/logout401、1440/390幅、横overflowなし。画面ツール接続不能のため既存Chrome/CDP方式。画像を目視確認。
- EBS/secret guard付きで候補だけ停止再開し35％の保存保持、MySQL/旧版は再起動なし。最終旧HTTPS200、public Nginx hash不変。
- Linux模擬配信62件、型検査、業務42件、Compose5分類、Docker内Next build、実Nginx案の構文成功。本番CD/公開切替/GitHub review実行/S3正式DB復元は未実施。
- S3/IAM/production環境は未作成・未適用。試験用SSH/PC proxy/専用Chromeは終了、EC2私設TLS proxyは停止、Next/MySQL/旧版は稼働中。

# 最新：AWS Next.js候補版の正式DB接続・実HTTP操作（2026-11-17）

最新（2026-11-17 20:08〜20:10 JST）：**AWS Next.js候補版がREQUIRES_APPROVED_PUBLIC_IPV4:3001で稼働**。新正式DBへ確認済み2履歴を適用、runtimeは業務tableのCRUDのみ、migrationユーザーはロック。実HTTPでログイン/案件作成保存再取得/ログアウトと401を確認。Next約181〜188MiB/384MiB、MySQL約231MiB/512MiB、EC2 available最少約826MiB。旧公開HTTPS200・不変。S3/一般公開切替/Git push/再起動は未実施。詳細は[20節](PREDEPLOY_VALIDATION.md#20-aws-nextjs候補版の起動正式db移行ログイン保存検証)。後段の未起動/提案は過去の履歴。

- 正式DBは新規siteflow_public_app、事前table0。15table＋管理table、2成功履歴、schema diff一致。元の検証/復元DBや旧サイトは変更なし。
- 秘密_FILE読込、UID1000/0400、read-only/swap0/core0/logなし、app DDLなし/履歴table権限なし、移行ユーザーロック。Linux設定/秘密テスト10件、型・関連53件・Docker build成功（Windows shell53件はskip）。
- 候補API4分類成功、DBにも案件progress25/version2、logout後session0。EC2内bindのみ、PCから3001到達不可。ブラウザーUI/HTTPS Cookieは未検証。
- root空き約8.22GiB、DB約9.63GiB。新正式DBのSQL控え28,351BをEBS内取得、当該控えの復元は未実施。EC2外バックアップ未導入。
- 証明書期限2026-11-21 15:26 JST。公開前条件/復旧手順は20節。文書と学習履歴も更新。

# 最新：AWS SQLバックアップ・復元・最小権限TLS（2026-11-17）

最新（2026-11-17 19:40 JST（10:40 UTC））：AWS上の架空DB backup→別空DB restoreの定義/全行/整合性一致、アプリ用最小CRUD・TLS必須・他DB/DDL拒否、Next.jsと同じ接続設定/Prisma adapterで正常TLSと不正CA/誤名/平文拒否を確認。MySQL約205MiB/512MiB、host最少約891MiB、旧公開HTTPS200。**実Next HTTP候補/Prisma migration/EC2外backupは未実施。** 詳細・残作業・S3承認案は[検証19節](PREDEPLOY_VALIDATION.md#19-awsでの検証dbバックアップ復元アプリ用tls接続)。後段は過去時点の記録を含む。

- 実行結果19:40 JST、後片付け/最終health19:42 JST。MySQL同一コンテナ、swap/OOM0、3306非公開、旧3container/サービス/Nginx不変。
- 失敗経過も19節へ記録：SHOW GRANTSとTLS属性の混同、adapter生成と実接続の混同を検証ツール側で修正。2,008Bの架空dumpを新しい空DBへ復元。元DB/最初の復元先は不変。
- app本体/依存/既存CI/CD/Nginx/Compose/systemdは今回未変更。検証用clientは既存Next build内の同じ接続ソースと固定済み依存だけで作成、秘密なし。型/業務42件/Docker内buildは前段階の成功を再利用し、今回の成功として反復実行していない。
- 文書のUTF-8/参照/学習履歴保持/JS構文を検査。HTTP候補版の動作やEC2外からの復旧は次段階。

# 最新：AWS MySQL初回起動・保持検証（2026-11-17 18:41 JST）

- 条件照合後DBのみ起動、healthy。暗号化EBSの実UUID/serial/保存先一致。3306非公開、秘密/EBSログ配置、read-only/swap0/core0/root@localhostを確認。
- 検証専用の架空1行を保存し正常停止、今回のDBコンテナのみ再作成。server UUIDと行が保持。再作成後188MiB/512MiB、host available約937MiB、OOM0。旧コンテナ/サービス/Nginx/fstab不変、HTTPS200。
- ローカル保護付きMySQL6分類、Compose5分類成功。型検査成功、業務テスト42/42。Next.js直接buildは所有者限定CAフォルダーをsandboxから走査できず失敗。秘密除外したDocker builderでの結果は以下の追記を参照。
- 未検証：AWS SQL別保存先backup/restore、アプリ用非root/TLS接続、Prisma/Next統合、実再起動/稼働mount喪失。自動起動disabled。Next配信/切替/Git pushなし。[詳細](PREDEPLOY_VALIDATION.md#18-aws-mysql初回起動と永続化検証)。

# 最新：自動mountとDB専用起動保護（2026-11-17）

- ユーザー承認の範囲でfstab backup/UUIDの1行（nofail/device-timeout10秒）を反映。findmnt --verify/解析、生成mount unit/DB専用unitのsystemd verify成功。fstab元権限0644、backup0700/0600、専用script0755/unit・Compose0644/host.env0600を照合。
- 専用guardはmountpoint/XFS/UUID/NVMe serial、起動scriptはさらにvolume所有/bind/dataを検査。DB unitはRequiresMountsFor/BindsTo/Afterを持ち、disabled/inactive/許可markerなし。Compose MySQL restart=no、app unless-stoppedを実EC2でconfig解析。up/start/pullは未実行。
- 実EBS正例成功、誤UUID/誤EBS拒否、private mount namespace内だけでmountを外した場合の拒否を確認。host mountは不変。unitを実起動して拒否を試したのではなくguardを直接試験し、DB未起動を維持した。
- Docker/NginxのPID/開始時刻/サービスファイル/DB非依存、3containerのID/HostConfig/状態/StartedAt、image/volume集合/Nginx設定hashは前後一致。EC2/PC HTTPS200。daemon-reloadのみでサービスrestartはなし。
- ローカルLinux14件/Compose5分類、型検査/業務42件/Next build成功。検証ツールのruntime mount unit参照/escape解析/inactive profileを修正し、失敗試行はfstab/今回作成ファイルを戻した。権限も元と明示modeへ照合。詳細・backup・未検証：[17節](PREDEPLOY_VALIDATION.md#17-自動マウントとmysql起動保護の設定結果)。
- 未実施：実EC2再起動/実EBS不在boot/実Docker daemon再起動/実DB起動とmount喪失時停止/volume保存/backup復元/Next/push/公開切替。

# 前段階：承認B4・追加EBSの手動mount（2026-11-17 06:40 JST）

- 同EC2/新vol-01a737715ed956301/serial/10GiB/XFS/UUID/label/未mount/UUID重複なしを照合。mount先未存在/親dir安全/既存dataなしを確認しroot専用の空dirを作成、UUID指定mountを1回実行して終了0。
- findmnt/lsblk/dfで/dev/nvme1n1→/srv/siteflow-mysql、UUID REQUIRES_APPROVED_RECORDED_ID、XFS/rwを照合。filesystem10,670,309,376B、空き10,561,363,968B/2％。root20GiBのmetadata/mount、fstab/Nginxhash/3containerのID/image/状態/StartedAt/port/restartは前後一致、HTTPS200。
- [範囲/コマンド/復旧/残課題](PREDEPLOY_VALIDATION.md#16-b4承認後の手動マウント結果)。fstab/Docker設定/DB subdir/Volume/DB起動/Next/pushなし。手動mountだけで自動mount/実再起動/保存先切替の合格とはしない。文書/学習guideの静的検査のみ、本体build/DB試験は反復しない。

# 前段階：承認B3・追加10GiBだけのXFS format（2026-11-17 06:34 JST）

- 対象vol-01a737715ed956301/device nvme1n1/10GiB/serial/AWS名を実行直前にも照合し、署名/partition/mount/swap/holdersなしを確認。強制なしのmkfs.xfs -L SITEFLOW_DBを1回実行して終了0。
- blkidでXFS/UUID `REQUIRES_APPROVED_RECORDED_ID`/LABEL SITEFLOW_DB。同device/容量/未mountを確認。root20GiBのFS/UUID/mount情報、fstab/Nginxのhash、現公開/直前/保留containerのID/設定されたport/状態/StartedAtは前後一致、HTTPS200。
- [実行結果と範囲](PREDEPLOY_VALIDATION.md#15-b3承認後の新10gib-xfsフォーマット結果)。mount/dir作成/fstab/DB/Next/push/既存公開変更なし。DB保存/再起動/backup復元を達成済みにしない。文書/学習guideだけ更新し、本体build/DB試験は反復しない。

# 前段階：追加EBSの読み取り専用NVMe照合（2026-11-17 06:26 JST）

- ユーザーが新vol-01a737715ed956301の作成/同EC2への/dev/sdf接続を手動実施と報告。IMDSで対象instance/AZを確認後、lsblkとsysfs serialがvol01a737715ed956301、容量10,737,418,240B、/sbin/ebsnvme-idが同VolumeIdと/dev/sdfを返し、/dev/nvme1n1へ一意に対応。
- root vol-042befaf03ffe5cb7は別20GiB /dev/nvme0n1、p1 XFSを/へ使用。新diskは子partition/UUID/FSTYPE/mountなし、blkid低レベル署名なし（exit2）、wipefs --no-act署名なし、file:data、findmnt対象mountなし、holders空。全域のdata不存在を保証する試験ではない。
- 公開中ae3/3002、root mount、Nginxhash、HTTPS200を確認。format/mount/fstab/DB/Next/既存サイト/pushは未変更。暗号化等のAWS属性はユーザー報告と今回のOS実測を区別した。[14節](PREDEPLOY_VALIDATION.md#14-ユーザー作成接続後のnvme読み取り照合2026-11-17)。
- 次のformat/mount/自動mountは別承認。DB再起動保護の不足は未解消/未実装。文書のみ更新し、無関係なbuild/DB試験は反復しない。

# 前段階：B準備・AZと既存diskの読み取り確認（2026-11-17 06:01 JST）

- IMDSv2で同EC2/region ap-southeast-2/AZ ap-southeast-2c/root mapping xvdaを取得。tokenは非表示/非保存。lsblkで既存EBS serial一致/20GiB/root XFSのみ、追加data path/mount/fstabなし、mkfs.xfs存在（未実行）を確認。旧Vinext/HTTPS200/CD休止維持。
- gp3 10GiB/同AZ/暗号化/aws/ebs/Nameとconsole画面別手順、attach候補sdfと実NVMe照合、UUID自動mountを具体化。[13節](PREDEPLOY_VALIDATION.md#13-b準備ebs作成値と画面別手順2026-11-17)。root暗号化属性は過去ユーザー確認、今回OSから独立確認した事実と分けた。
- ソース確認でMySQLのDocker自動restartがhost guardを通らない点を指摘。DB専用systemd/mount依存/再起動管理の補強を起動前条件にした（未実装/未検証）。既存mock成功を実再起動安全性へ流用しない。
- 作成/attach/format/mount/本番設定/再起動/DB/Next/push/切替なし。文書/学習guideだけ更新し、通常build/DB試験は繰り返していない。

# 前段階：承認A・旧2imageの対象限定削除（2026-11-17 05:52 JST）

- ユーザーはAだけ承認。対象04d3/bf9の完全ID/単一タグ/digest/保存metadata一致、停止済み含め参照0、旧root専用復旧記録のhash/権限、GHCR manifest参照を確認して完全IDのimage rmを2件だけ実行。force/prune/container/volume削除なし。
- image集合は6→4で対象以外不変。現公開/直前/保留の3containerのID/設定/状態/StartedAt/portとNginxhash、旧CD休止を前後比較して不変。EC2/PCから通常TLS検証付きHTTPS200。
- root空き7,614,701,568→10,408,456,192B（7.09→9.69GiB）、使用65→52％。filesystem差分約2.60GiB。最新の別data EBS計画の取得前8.5GiB目安は満たすが、配置後/実起動の合格ではない。
- [完全対象・記録場所・復旧制限](PREDEPLOY_VALIDATION.md#12-承認a旧2イメージの整理結果2026-11-17)。image再取得/旧版起動の復元試験、B以降、DB/S3/Next/push/切替なし。本体コード/設定は変更せず通常build/DB試験は反復していない。

# 前段階：候補起動用のローカル実装・検証（2026-11-16〜17 JST）

- Compose/new containerのlog10m×3/停止app30秒・DB60秒/認証SQL healthcheck、MySQL binlog無効、release.sh側のlog指定をローカル実装。本番反映なし。Compose解析5分類＋実MySQL6項目成功（512MiB/SQL正常・誤秘密拒否/非公開port/ログ/設定値/正常停止）。
- 追加EBS用のmount/serialとVolumeId/bind先照合をstart-database.shへ追加。Linux配信既存48件成功、追加後は構文/DB起動12件（新規4＋関連8）成功。未mount/誤ID/誤bindは起動拒否。実Linuxホストのmount/再起動は未検証。
- 新scripts/check-candidate.mjs：unit4件成功、実cached Next.js＋使い捨てTLS MySQLでready/未認証401・login/read・新規架空案件/進捗25％/再取得・logout/旧session401の4分類成功。試験資源回収。AWS/ブラウザー/公開Nginxの試験ではない。
- 失敗と修正：Windows world-writable bindによる.cnf無視は試験専用Linux600 copyで除外して再検証。loginが{ok:true}の実仕様へcheckerを合わせ、get-sessionでuser IDを取得して再検証。アプリの認証仕様は変更なし。
- 型検査/業務42件/Next build成功。既存15＋3の全試験やEC2調査は繰り返していない。本番/CI/Dockerfile/Nginx/systemd/push変更なし。root交換を最短経路から外し、旧公開維持のため追加encrypted DB EBS10GiBを提案。承認A/B/Cは未承認。[計画](AWS_DEPLOY_PLAN.md)、[実測とコマンド](PREDEPLOY_VALIDATION.md#11-候補起動を優先したローカル実装と検証)。

# 前段階：承認された停止4containerの整理（2026-11-16 23:07〜23:08 JST）

- 指定4件の完全ID/name/image/停止/mountなし/SizeRw0/docker diffなしを再照合。全7件が対象4＋保持3と一致、Nginx/CD/HTTPSも事前確認した。
- EC2 root専用dirへ12ファイルの復旧情報を新規保存（dir0700/file0600）、読み戻し/hash/権限検査後に完全IDのdocker rmを4件だけ実行。force/volume/image削除なし。秘密値は出力/Gitへ含めていない。
- 対象4件不在、残りは現公開running/直前exited/保留exitedの3件。ID/Config/HostConfig/mount/StartedAt/port、全6image ID集合、Nginxhash、CD休止を前後照合して不変。EC2とPCの両方から通常TLS検証付きHTTPS200。
- 空きは7,616,651,264→7,616,921,600B、約7.09GiB/65％。通常変動を含む微増で、image整理の2.345GBを解放した結果ではない。復旧情報の場所/制限は[10節](PREDEPLOY_VALIDATION.md#10-承認された停止4コンテナの整理結果2026-11-16)。実再作成/外部暗号化backup/本体build/DB試験は今回未実施。
- image2件削除/EBS変更/S3/DB・Next起動/Git push/切替は未実施。文書と学習ガイドは既存履歴/テーマ/UIを維持して更新した。

# 前段階：削除候補と暗号化・S3計画の読み取り再調査（2026-11-16 22:47 JST以降）

- 古い2imageの完全ID/作成日時/Size/RepoDigestを再確認。参照する停止4containerはmountなし/SizeRw0。現公開d749/直前31bは別imageとして保持。Nginx3002/hash不変、HTTPS200、CD inactive/disabledを確認。
- 既知の設定ディレクトリ検索、旧CD script hash/参照の確認。古い試験state/inspect JSONにはB版参照が残るが、既知の現行scriptから直接参照なし。全ての動的依存の網羅ではない。記録ファイルは残す。GHCR固定manifest4版とも参照成功、pull/実復旧は未実施。
- root空き7,616,745,472B（7.09GiB）、候補整理後は推定9.28GiB。初期取得前10GiB/最後まで25％空きのゲートを提案し、root暗号化/30GiB案とS3 IAM/保持/復元/公式料金を具体化。これらは目標・設計で未達成/未適用。
- [完全な対象表と承認順](PREDEPLOY_VALIDATION.md#9-削除対象の再確認暗号化の推奨と個別承認手順2026-11-16)。本番削除/起動/設定変更/EBS/S3/push/切替なし。文書のみ更新し、本体buildや前段の15＋3試験は再実行していない。

# 前段階：本番読み取りとローカル事前検証（2026-11-16）

- EC2読み取り：空き約7.1GB/65％、RAM1909MiB/available1461MiB、旧公開・CD休止を維持。停止4containerが参照する古い2imageを条件付き整理候補として記録、固有容量約2.345GB。削除は未実施。cache/ログの総量を解放可能量と混同しない。
- `work/check-predeploy-database.mjs`（Git対象外）：15項目成功。架空5ユーザー/105案件/45秒1100読取、正しいTLS/誤CA等拒否、正常停止後2回の同Volume再作成で16table全行/UUID/履歴/session保持、専用権限backup→別の空DB復元/旧session失効/実Next再ログイン/案件取得/元DB不変。試験専用資源の回収完了。
- 負荷中の離散サンプル：Next151.6〜176.7MiB、MySQL264.3〜265.4MiB、Volume223,870,976B、dump104,951B。Docker Desktopでの小規模測定。EC2の2GB/15分/更新・会議負荷合格ではない。
- 既存`check-public-migration.mjs --proxy`：実Nginx/Next/TLS DBの切替・不備時旧維持・HTTPS失敗時復帰3項目成功。旧転送先はfixture、Docker CLIはprocess adapterで、実Vinext復旧/本番切替ではない。
- 試験中の失敗も記録：短時間ログイン429はテスト待機で解決（製品制限不変）。専用restore権限1044はdumpの`--skip-add-locks`で解決し権限を広げていない。SQLはメモリ内のみ、age/S3の暗号化復号/権限は未検証。
- 詳細/目的/失敗時対応：[事前検証](PREDEPLOY_VALIDATION.md)。本体コード/配信設定/CI/DB定義は未変更のため通常の型検査/本体buildは反復しない。AWS変更、本番削除/DB起動/設定変更、push/切替なし。

# 前段階：公開用MySQLの設計（2026-11-16、実行なし）

- compose.production.yaml/mysql.cnf/settings/migration/public設定/TLS adapterとローカルbackup復元コードを参照。DB512MiB/各Next384MiB/external/portsなし/接続pool2/CAと接続先検証、backup訓練のローカル限定を確認。
- [運用設計](PRODUCTION_MYSQL_DESIGN.md)に役割分担・Volume・秘密/TLS/権限・EC2外暗号化backup/別DB復元・2GB/ディスク見積・段階移行/rollbackを記録。backup/restore/通知/age/S3/log制限等の未実装を区別した。
- 既存release.shはdocker run管理のため、Composeと同じ枠を二重管理しない案。root非暗号化/ディスク余裕/EC2外保存方式を未決の公開前条件とした。mysql起動/実測/DB変更/コード設定変更/AWS/push/切替なし。過去のローカル8/6/17項目を今回再試験したとは扱わない。

# 前段階：承認後のCompose導入・既存公開維持（2026-11-16 21:27〜21:28 JST）

- 固定公式Linux版Compose5.7.0をEC2へ取得しSHA256一致後、root候補でversion/既存Docker25の一覧APIを検証。正式配置先は/usr/local/lib/docker/cli-plugins/docker-compose、root:root/0755、固定ハッシュ一致。root/ec2-userとも認識、JSON一覧0件が成功。
- 稼働/停止済み全containerのID/image/name/port、Docker client/server版、Nginx設定SHA256、旧CD inactive/disabledが前後一致。EC2側と21:28:17 JSTのPC側でHTTPS200/証明書検証/SiteFlow本文一致。
- 候補とdownload一時領域は回収、正式プラグインのみ保持。成功経路であり失敗時撤去の実試験ではない。Docker Engine/Nginxのrestart/reload、DB/volume/network作成、Compose up、AWS制御API、push/デプロイなし。[手順書22節](AWS_DEPLOY_RUNBOOK.md#22-compose導入結果と既存公開の維持)。

# 前段階：Compose導入前の版・配布物・設定検査（2026-11-16 21時台 JST）

- EC221:13:37 JSTの参照で、Amazon Linux2023/x86_64、Docker client25.0.14/server25.0.16/API1.44/min1.24、root/通常ユーザーともCompose未導入、候補配置先に同名ファイルなしを確認。旧サイト正常/旧CD休止を維持。
- ローカル現行Compose5.7.0で設定検査5項目成功。最初はサンドボックスからDocker CLIを参照できず失敗し、承認されたアクセスで再検証して成功。サービス/DB起動なし。過去試験の版を5.7.0だったと推測しない。
- 公式release5.7.0（非draft/非prerelease）とLinux x86_64 assetを照合。34,125,466バイト、SHA256 7758048ad38e580f22559603312874fec8bb638d021a9e64182385fc17cc12a2。公式API digest/配布checksum/取得ファイルが一致。PowerShell byte配列の解析失敗をUTF-8変換で修正して最終一致。
- 取得はローカルworkのみ。EC2へコピー/実行/導入せず、Engine25との実API互換性は未実証。導入案は[AWS手順書21節](AWS_DEPLOY_RUNBOOK.md#21-docker-compose導入の版配置影響と承認範囲)。アプリ/CI/CD/AWS設定は今回変更していない。

# 前段階：t3.small/2GB化と旧版起動後の検証（2026-11-16 21:05〜21:06 JST）

- 停止/サイズ変更/起動はそれぞれの承認を経てユーザーがAWSコンソールで実行。SSH/IMDSv2で同じinstance/t3.small/public IP、同じroot EBS20GiB、RAM1909MiB/available1484MiB/swap使用0を確認。
- 旧siteflow-3002は同じimage/SHA、Docker/Nginx active/enabled、Nginx設定SHA256不変/転送先3002。実再起動後も旧CD timer inactive/disabled、service inactive/未起動/ロックなし。
- EC2内部からアプリHTTP200/HTTPS200/TLS検証成功/SiteFlow本文を確認。21:06:34 JSTにはPC側からも証明書検証付きHTTPS200/SiteFlow本文一致。証明書期限は11月21日15:26 JSTのまま。
- 旧版の復旧とRAM増量の確認であり、MySQL/Next.js本番負荷/復元/切替や長期休止再公開の検証ではない。今回読み取りのみでAWS/ホスト設定、コンテナ、GitHubを変更していない。[AWS手順書20節](AWS_DEPLOY_RUNBOOK.md#20-t3smallへの変更起動後の実測と旧版復旧)。

# 前段階：ユーザーの停止完了確認を受領（2026-11-16 20:52 JST頃）

- ユーザーが対象EC2のstoppedをコンソール確認したと報告。受領時刻と実停止時刻を区別し、APIで独立確認したとは扱わない。停止中のSSH確認は行わない。
- サイズ変更/起動/EBS操作/IAM変更は未実施・未承認。次はt3.smallへのタイプ変更だけの個別承認、起動は別。詳細は[AWS手順書19節](AWS_DEPLOY_RUNBOOK.md#19-停止完了の受領とサイズ変更の承認範囲)。

# 前段階：一時停止承認後の対象・権限確認（2026-11-16 20:37 JST）

- 停止だけを承認後、20:37:18 JSTにSSHでinstance/public IP/root volume一致、旧CD inactive/disabled/service停止中、同じ旧コンテナSHA/Nginx設定、HTTPS200/TLS検証成功を確認。
- StopInstancesのdry-runは権限拒否。実際の停止操作なし/EC2は稼働中。IAM変更やOSシャットダウンによる迂回なし。既存コンソールでの停止へ引き継ぎ、stopped報告を待つ。サイズ変更/起動は未承認。[手順書18節](AWS_DEPLOY_RUNBOOK.md#18-一時停止承認後の確認とコンソールへの引き継ぎ)。

# 前段階：新snapshot完了の受領とサイト再確認（2026-11-16 20:32 JST）

- ユーザーの手動作成/コンソール確認によりsnap-0e59ef6e9a1635889、元volume一致、作成日11月16日、完了/100％、旧snapshot保持を記録。時刻は未提供、復元試験は未実施。暗号化/共有等の独立照合はなし。
- 20:32:37 JSTにSSH参照。既存instance/type/public IP/root EBS20GiB一致、同じ旧版image稼働/Nginx設定SHA256不変、docker/nginx active/enabled、旧CD inactive/disabled/service停止中/ロックなし、HTTPS200/TLS検証成功。
- EC2停止/サイズ変更/起動、EBS交換、snapshot作成/削除をこちらで実行していない。次は最終対象照合と一時停止だけの個別承認。詳細は[AWS手順書17節](AWS_DEPLOY_RUNBOOK.md#17-最新スナップショットの完了確認と停止前の状態)。

# 前段階：snapshot作成承認後の事前確認（2026-11-16 20:13〜20:15 JST）

- 旧Vinext1件/同じvolume20GiB/mountなし/同じimageを確認。業務DBのプロセス・サービス・代表ポートなし、全プロセスのFD参照ではDocker内部管理DBのみ（権限拒否0）。瞬間の参照結果であり、OSに書き込みがないことを保証しない。
- docker topのPIDなし書式エラーを修正してnodeを確認。20:15:29〜30 JSTに業務DBプロセスなし/旧CD休止を再確認しsyncを実行、HTTPS200/TLS検証結果0。
- CreateSnapshotのdry-runは権限不足で拒否。ブラウザー接続も利用できず、新snapshot未作成/IDなし/作成日時なし/復元試験なし。IAM変更、旧snapshot削除、EC2停止/サイズ変更、EBS交換はなし。[手順書16節](AWS_DEPLOY_RUNBOOK.md#16-承認後の事前確認と作成経路の制約)。承認を得たことと実作成を区別する。

# 前段階：既存snapshot確認の受領と停止前バックアップ案（2026-11-16 20時台 JST）

- ユーザーのコンソール確認で旧snap-0666dfa96de083c80（10月11日13:48 JST、8GiB、完了、非暗号化、元EBS一致）を記録。古いsnapshotは削除しない。実復元試験済みとは扱わない。
- 前段の19:39:38 JSTのSSHではDescribeSnapshotsとAWS Backupのvolume/instance復旧点照会が権限不足。CD inactive/disabledとHTTPS200/TLS検証成功は確認できた。AWS画面の操作はURLを安全に確認できずツールが中断。今回権限変更や再試行による回避をしていない。
- 同日取得の公式標準snapshot単価0.055ドル/GiB月から、新規20GiB全量相当で月1.10ドルと予算化。実増分/残高は未確認。AWSルート停止推奨と稼働中取得の制約、syncの限界、非暗号化継承、作成完了と復元実証の区別を[AWS手順書15節](AWS_DEPLOY_RUNBOOK.md#15-既存スナップショットの保管と最新バックアップ作成案)へ記録。
- スナップショット作成/コピー/削除、EC2停止/サイズ変更/起動、EBS操作、本番切替はしていない。今回は文書のみ変更し、アプリ試験を再実行していない。

# 前段階：EBS確認後の容量対策・費用整理（2026-11-16 19時台 JST）

- ユーザー確認のgp3/20GiB/非暗号化/終了時削除「はい」を記録。AWS公式仕様でstopとterminateを区別し、既存EBSを維持する2GB化案と復旧条件を具体化。AWSリソース/アプリ/CI/CDは変更していない。
- 公式公開EC2/EBS JSONからシドニーmicro毎時0.0132/small0.0264ドル、gp3保存単価0.096ドルを取得。IPv4毎時0.005ドルも公式仕様で参照。基準内性能ならsmall730時間で約24.84/月、停止中約5.57/月、1〜4月98.112、推定80.63との差17.482ドルと計算。実請求/残高/実性能設定は未確認。
- 初回の公開料金取得はネットワーク制約で失敗し、承認されたネットワーク参照で再取得した。AWSアカウントの請求APIではない。停止・サイズ変更・EBS変更/削除・本番切替は未実施。詳細は[AWS手順書14節](AWS_DEPLOY_RUNBOOK.md#14-ebs確認後の容量対策とサイズ変更案)。

# 前段階：承認後の旧自動配信タイマー休止（2026-11-16 19:00 JST）

- 個別承認後、siteflow-cd.timerのstop/disableだけを実施。実機10:00:04〜10:00:05 UTC。timer inactive/dead/disabled、service inactive/dead/MainPID=0、対象deploy.lock表示なしを確認。
- 既存コンテナID/image IDが同じで稼働中、Nginx設定のSHA256不変、HTTPS200/TLS検証結果0を確認。配信serviceを強制終了せず、EC2本体/アプリ/DBを停止していない。
- unit/スクリプトの削除、Nginx変更、AWSリソース設定、GitHub設定/push、本番切替はなし。再起動後の実動作試験と新CDの永続pause/incidentは未実施。復旧/次段階は[AWS手順書13節](AWS_DEPLOY_RUNBOOK.md#13-旧自動配信タイマーの休止結果)。

# 前段階：Elastic IP確認の受領と旧CD休止の準備（2026-11-16）

- ユーザーのAWSコンソール確認により、既存IPがElastic IPで対象EC2へ関連付け済みと記録。APIからの独立照会成功とは区別する。新規IP取得や関連付け変更はなし。
- 12:41:35 JSTにSSHで再参照。旧timer enabled/active、service inactive/dead/MainPID=0、対象ロック表示なし。旧版の同一SHA/3002稼働、HTTPS200/TLS検証成功。変更前のスクリプト/unit/NginxのSHA256を記録。
- 旧CDタイマーだけstop/disableする具体案・合格条件・承認後の再開方法を[AWS手順書12節](AWS_DEPLOY_RUNBOOK.md#12-elastic-ipの確認と旧cd休止の実行案)へ記載。まだ実行していない。EC2停止/サイズ変更・AWS/GitHub設定変更・push・切替も未実行。

# 前段階：既存EC2/GitHubの読み取り調査（2026-11-16 12:27〜12:32 JST）

- 登録済みホスト鍵を確認して稼働EC2へSSH参照。RAM913MiB/利用可能314MiB、EBS20GB/空き7.2GB、旧版132.9MiB/192MiB、Docker volumeなし、3002転送を確認。初回SSHの改行エラーはLFで送り直して再取得した。
- systemd/CD実物を秘密行除外で参照。旧CDはenabled/active、起動1分後/終了5分後にmain/CI成功を確認。既存認証のGitHub GETでproduction環境0件、最新push run成功を確認。Compose未導入と新配置先未存在も確認。
- 公開証明書のIP/SAN、期限11月21日15:26:22 JST、webroot/renewal timer/hookを参照。HTTPS200/TLS検証0成功。証明書更新そのものは実行していない。
- Elastic IP/インスタンス詳細/EBS属性のAWS参照APIは権限不足で拒否。AWS画面にも接続できず未確認。別の過去SSHホストはホスト鍵不一致で接続中止し、登録の上書きなし。これらを成功結果に含めない。
- 設定・アプリ・CI/CD・AWS/GitHubを変更せず、push/配信/起動停止はなし。文書と学習ノートのみ更新。アプリの型検査/ビルド/DB試験は今回の変更と関係がないため再実行しない。
- 実測/未確認/反映差分/復旧先/個別承認は[AWS_DEPLOY_RUNBOOK.md 11節](AWS_DEPLOY_RUNBOOK.md#11-既存ec2の読み取り調査と反映差分2026-11-16)。前段のLinux配信件数は最終ログの48件へ訂正し、過去の他範囲の47件と混同しない。
- 文書検査成功：学習ノート69テーマ/73履歴、既存テーマID/履歴保持（直前の件数1箇所訂正を除く）、JSON外のデザイン/図/自己チェック処理の完全一致、JavaScript構文、参照先/UTF-8/コードブロック/差分の空白を確認。今回は表示/ブラウザー操作は再検証していない。

# 前段階：承認制御・公開migration・実Nginx復旧（2026-11-16）

- 承認後、ローカルのci.yml/Dockerfile/.dockerignoreとdeploy/を実装。main限定のproduction承認記録、GitHub保護/最新run/成果物照合、DB適用記録とschemaHash、pause/incident/排他、候補起動と切替/復旧を追加。実GitHub/AWSへの反映・pushはしていない。
- Linux実シェル48件成功。Docker/curl/GitHub API/一部Nginxは代役。未承認・不正reviewer・古い成功・期限切れ・schema不一致・休止・競合・誤転送先・旧枠所有/接続ありを拒否。失敗時は現在の公開版とDBを保持。
- 別途、実Nginx1.22.1・実Next.js・TLS MySQLで3項目成功。HTTPS切替、準備不足で切替しない、公開確認失敗時の旧転送先復旧を確認。docker CLIはNodeプロセスの代役、旧版もHTTP代役で、実Vinextの切替ではない。
- migration専用Docker/実TLS MySQLの6項目成功。2履歴/16テーブル、再実行、誤CA/接続先/未承認の拒否、構造差分を検出しても自動修復しないこと、実際の適用履歴とschemaHash確認記録を検証。新しいSQLや既存履歴の書換えはない。
- 実Composeの設定検査5項目、通常アプリDockerのHTTPS17シナリオ、本体型検査/lint、業務等56件が成功。実入力217ファイル・最終アプリ11層の混入検査も成功。migrationは専用lockへ分離し、2.91GB→0.99GBへ約66％削減（共通依存バージョン差0）。
- 48/56/42等は異なる範囲や重複を含むので合計を完成率にしない。前段の16テーブル復元8項目は今回は再実行していない。実際のGitHub本人承認、EC22GB/ディスク/負荷、既存Nginx/CD適合、本番バックアップ/停止再開は未検証。詳しい役割・再現・復旧条件は[LOCAL_DOCKER_CHECK.md](LOCAL_DOCKER_CHECK.md)。
- 学習ノートへ「公開前に止める・確かめる・戻す」を追加。既存ID/過去履歴を保持して69テーマ/72履歴。実コード16抜粋の一致、全テーマの1440/390幅、追加図3状態、自己チェック保持、印刷イベントの復元を確認。画像も確認した。PDF出力そのものの試験ではない。

# 以前の記録：公開用Dockerのローカル検証（2026-11-16）

- Dockerfileをstandalone/非rootの複数段階へ変更。.dockerignoreを許可制にし、.envなしの通常ビルドが成功。既存workflow・Nginx・CD・AWS・GitHub設定・pushは変更/実行していない。
- 本体/API型検査、lint、業務/会議/設定/公開入口/readiness56件、既存CIと同じイメージ内42件が成功。実Docker入力198ファイルと最終11層8,942エントリを検査し、検査用.env/鍵と照合対象の秘密値は未検出。
- 実際のstandaloneイメージ＋TLS MySQLの17シナリオ成功。HTTPSログイン・案件保存/チーム切替・会議22件全体の確認/取消/終了・固定secret・誤CA拒否・readiness・両コンテナ再作成後の保存を確認。1440/390幅も確認。入口はNodeによる模擬HTTPSで、本物のNginxやAWSの試験ではない。
- 別途、従来Next.js統合5項目と、会議を含む16テーブルの別DB復元8項目が成功。一時DB/ユーザー/dumpとDocker専用コンテナ/ネットワーク/volume/証明書は回収済み。
- 一時点のメモリはNext.js130.1MiB（上限384MiB）、MySQL220.5MiB（上限512MiB）。新旧同時稼働・ピーク・15分負荷・2GB実機の合格結果ではない。完成イメージはamd64、391,412,829バイト（Docker inspectのSize。配信サイズやディスク必要量とは違う）。
- 残課題：本番公開設定、Elastic IP、証明書更新、容量/負荷、production承認環境（現状未作成）、休止中の配信防止、本番のmigration/バックアップと停止再開。次のAWS準備前にも承認を得る。詳細と再現は[LOCAL_DOCKER_CHECK.md](LOCAL_DOCKER_CHECK.md)、費用とユーザー提供クレジットは[AWS_DEPLOY_PLAN.md](AWS_DEPLOY_PLAN.md)。
- 学習ガイドは既存ID/履歴と実コード16抜粋を維持し、Dockerテーマを追加（68テーマ/70履歴）。全テーマ切替、Docker図3状態、自己チェック保持、印刷イベントの復元、1440/390幅を確認。実際のPDF出力の検証ではない。

# 以前の記録：会議の開始・確認・再開・終了（2026-11-15）

- ローカル検証専用DBへ追加マイグレーションを適用。既存テーブルを変更せず、Meeting / MeetingProject / MeetingConfirmationを追加。新規UUID列はVARCHAR(36)。AWS・本番・CI/CD・Dockerfile・配信設定は未変更。
- 業務46件、会議HTTP/DB11件、既存API102件が成功。21件全体の対象固定、保管除外、確認時の最新値、取消監査、再確認、古い版409、進行役、終了後の変更拒否、最終更新失敗時の巻き戻し、501件の開始拒否を検証。
- Next.js統合の従来5項目と、会議ブラウザー7項目が成功。再読み込み後の再開、10秒取得と選択/入力保持、保存/取得失敗と再試行、409後の再操作、1440/390幅、終了前の未確認18件一覧、Escape/Tab/Enter、別チームへ切替を確認。スクリーンショットはwork/meeting-browser/。
- MySQL8.4.13の使い捨てDBで、会議の確認/取消/終了を含む16テーブルの全行一致と既存の復元後チェック8項目が成功。一時DB・ユーザー・SQLは回収済み。詳細はDATABASE_BACKUP_CHECK.md。
- 本体/APIの型検査、lint（警告0）、公開用ビルドが成功。Prisma差分生成は、既存のSQL生成専用設定が必要だった。ブラウザーテストの中断通信処理とEnter送信を修正して再実行し、成功を確認した。
- 会議テストの一時データは終了時に回収。最初に停止したテストのデータもID・作成時刻・架空チームを照合して回収し、以前からある体験用データを保持した。
- 今回の区切りは「全業務確認を一通り進め、DBへ記録を残せる」。前回差分・重要業務優先・相談事項・決定事項・招待等は未完成。AWSでの反映・容量・本番バックアップ運用も未実施。仕様と再現は[MEETING_FLOW.md](MEETING_FLOW.md)。以下は当時の記録。

# 最新：公開用統合APIとMySQL TLSのローカル検証（2026-11-15）

- 明示モードpublic-integratedを追加。固定HTTPS Origin・secret・公開専用DB設定を要求。未指定のproductionはdisabledのまま。開発用と従来中継を維持。
- 単体97件、API/DB回帰102件、公開用統合14シナリオ、従来ローカル統合5項目、本体/API型検査・lint・ビルド成功。使い捨てMySQLへの実Prisma通信とブラウザーHTTPSでTLSv1.3を確認。異なるCA/接続先名/平文/CREATE権限を拒否。
- Secure Cookie、画面の作成/編集/保存/再読込、再起動後の固定secretによるセッション維持、誤CA時503と復帰、1440/390幅、ログアウトを確認。DBエラーに秘密値を出さない。API回帰では主担当から副担当への変更が先行したときの保管403を正式仕様として検査。
- HTTPS証明書は専用Chromeの鍵単位SPKI例外を用いたPC内検証。DB証明書は試験用CAを明示し、接続先を照合。公的CA・AWS・2GB・実配信の検証結果ではない。一時コンテナ/匿名データ/証明書/プロファイルの削除を確認。
- 詳細・再現・制限：[PUBLIC_INTEGRATED_TLS.md](PUBLIC_INTEGRATED_TLS.md)。結果はwork/public-integrated-check/。AWS・既存MySQL・CI/CD・配信・契約は変更なし。機能開発はローカルで再開でき、公開作業と分けて進められる。

# 以前の記録：ローカルMySQLの別DBへの復元（2026-11-15）

- 使い捨ての一時DB2つで架空21案件をmysqldumpし、13テーブルの全行・適用履歴を別DBへ復元して照合。壊れたSQL・元DBへの復元・非空DBへの上書きを拒否し、拒否時のデータ不変を確認。
- 復元後の再ログイン、古いセッション無効化、案件取得/更新、チーム境界、副担当の保管/復元拒否、外部キー/一意制約、トランザクション失敗時の取消を確認。元DBは全行不変。Prismaの再適用も変更なし。
- 安全確認4＋業務42＝46件、実DB8項目、本体/API型検査・lint・ビルド成功。一時DB・ユーザー・SQLファイルの削除も確認。
- このPC/MySQL 8.4.13/21案件/SQL36,885バイト：バックアップと検査151ms、復元と全行照合538ms。本番復旧や同時利用の性能目標の達成ではない。S3・自動保存・暗号化・保持/通知・公開運用は未実装。
- 再現・オプション・失敗の修正・限界は [DATABASE_BACKUP_CHECK.md](DATABASE_BACKUP_CHECK.md)、結果はGit対象外のwork/backup-restore/results.json。AWS・本番・配信設定は未変更。

# 以前の記録：Next.jsへのローカルAPI統合と保管権限（2026-11-15）

- 明示したintegratedモードで別APIを起動せず、Next.jsの受付から共通認証・保存サービスを使用。本番のintegrated指定は拒否。通常のlocal/public中継は維持。
- 正式権限は現在のチーム管理者または案件の主担当。副担当の保管/復元は403、復元と同時の自己昇格も拒否し、DB不変を検証。canArchiveで画面のボタンも制御するがAPIでも再確認。
- 単体92件、本体/API型検査、ESLint、ビルド成功。Next.js実起動でログイン・DB保存/再取得・競合200/409・権限/Host/Origin/本文上限/登録停止/ログアウトを確認。統合モードで既存ブラウザー47項目成功。1440/390幅、キーボード、入力保持、競合、履歴、保管/復元を含む。
- 既存API/DB101件の応答項目テストにcanArchiveを追加。途中の型エラー、tsx起動制限、内部localhost表記、Cookie Pathの差、応答項目の期待値不一致を修正し、最終結果で判定。
- 再現手順、コマンドの意味、実装と未実装の境界は [NEXTJS_API_INTEGRATION.md](NEXTJS_API_INTEGRATION.md)。結果はwork/integrated-next/、work/workspace-preview/、work/integrated-*.log。AWS・配信設定・契約は変更なし。DBバックアップ復元・公開向け統合・DB/TLS・2GB測定は未実施。

# 以前の記録：明示設定でNext.js画面と公開用ルートを接続（2026-11-15）

- workspace-connection.tsに共通モード判定/画面Host判定/API選択を追加。未指定はdevelopmentだけlocal、productionはdisabled。publicは専用Origin/API URL必須。invalidは案内/503で、ローカルへ戻さない。proxy-origins.tsへURL検査を共通化。APIルート/案件ページで同じ判定を使用し、画面はforce-dynamicとheaders()で実行時に判断する。
- ConnectedWorkspaceへlocal/publicの表示用propsだけを渡し、publicはプレビュー用の文言。秘密値・内部URLをクライアントへ渡さない。既存の業務ルール/保存サービス/DBスキーマ・依存/ロック・CI/CD・配信設定は変更なし。通常.env.localも変更していない。
- 設定7件を追加し、業務41＋local中継19＋設定9＋public中継10＋接続7＝86件成功。本体/API型検査、lint、本体ビルド成功。型キャッシュはビルド前へ復元。/workspaceは実行時設定を読む動的ルートになった。
- test:next-previewで同じ本番ビルドをdisabled/invalid/publicの一時Next.jsプロセスで起動し、専用ChromeからPC内HTTPSで9シナリオ成功。案内/404、案内/503、違うHostの案内/403、ログイン/Secure HttpOnly Cookie、案件作成と基本編集のDB保存、チーム切替/再読込後の保存と認証、1440/390実画面、ログアウト後の削除/401、旧ルートの表示を確認。
- 初回はセッション取得403でログインフォームが出ず、段階/ステータスだけを記録して調査。導入済みNext.jsがhttps表記loopback URLを組み立てる実装を確認し、その内部表記にも対応して再ビルド後に成功。固定公開Hostと更新Originの検査は外していない。
- 従来の開発接続の実Chrome47シナリオと簡易HTTPS Cookie8シナリオも再実行して成功。API関連101件は前段階の結果で今回一括再実行なし。公開プレビュー9件で全業務操作を網羅したという意味ではない。
- Next.js/TLS入口/APIは通常サーバーと別のloopback空きポート。検証終了時に一時プロセス、ユーザー/2チーム/案件/履歴/セッション、鍵/証明書/プロファイルを停止/削除。常用アカウント・案件は変更せず、通常5173/5175は停止していない。画像は実際の案件画面の架空データで確認し、docs/imagesにも記録した。
- 理解ノート61にworkspace-public-previewを追加し62テーマ/64履歴。構文/参照先/全テーマ切替、workspace図18個と説明/公開設計/分離/設定/起動/中継/HTTPSの各図3状態、自己チェック保持と印刷前後を専用Chrome1440/390で確認。新規図のスマホ画像も確認。実PDFは未出力。
- 未準備/未検証：インターネット公開、実公開証明書、公的CA、公開専用DB/TLS/最小権限、配信/API自動起動/バックアップ/戻し方/費用、体験者別デモ発行。自己署名鍵のSPKI例外の検証を実公開の完成とは扱わない。手順はWORKSPACE_PREVIEW.md。以下は過去の記録。

# PC内HTTPSでのブラウザーCookie検証（2026-11-15）

- check-https-cookies.mjsとtest:https-cookiesを追加。既存の中継・共通起動をそのまま使い、REQUIRES_APPROVED_PUBLIC_IPV4の空きポートにHTTPS検証ページ/実API/HTTP確認サーバーを起動。通常の5173/5175は停止・変更していない。アプリ本体・認証/中継・DBスキーマ・CI/CD・配信設定・依存の変更なし。
- 専用ChromeでHTTPS8シナリオ成功、通信はTLSv1.3。1日有効の自己署名証明書を一時生成し、今回の鍵のSPKIだけ例外扱い。公的CAの信頼/期限/ホスト名検証が成功したという結果ではない。OS証明書ストア・hosts・通常Chromeは変更していない。
- 確認した8つ：TLS/未認証セッション、__Host-のルートPath受入と不正Path拒否、Secure/HttpOnly/Lax/host-only保存と同じPathでのJavaScript可視性、再読み込み/自動送信、HTTPへ送らないこと、Cookieが送られても別Originは403、1440/390の検証ページ表示、ログアウト後のCookie/DB削除と再読込後401。
- ブラウザーへCDPでCookieを手動登録せず、API要求へのCookieヘッダーも手動追加していない。CDPで属性を検査し、通常fetch/フォーム/ブラウザー再読込で動作を確認。画像はログイン値を消した後の検証ページだけを撮り、両幅で確認した。案件アプリのスクリーンショットではない。
- 初回は検証サーバーのパス切出しで文字数を渡し忘れ、ログインに失敗。切出しを修正し初期GETの200も検証して成功。さらにHttpOnlyを同じPathの読める確認用Cookieと比較する形へ強化し再実行して成功した。アプリ側の認証を緩める修正はしていない。
- 本体/API型検査、業務41＋ローカル中継19＋設定9＋公開中継10＝79件、lint、ビルド成功。型キャッシュはビルド前へ復元。API関連101件・従来画面47シナリオは前段階の結果で今回は再実行なし。
- 一時ユーザー/2チーム/21案件/関連履歴/セッション、秘密鍵/証明書/専用プロファイルを終了時に削除。常用アカウント・案件は使っていない。結果JSONと資格情報を含まない画像だけをwork/https-cookie-previewへ残す。成功JSONは後始末成功後のみ出力し、実行開始時に古い結果だけを削除する。
- 理解ノート60にhttps-browser-cookiesを追加し61テーマ/63履歴。構文/参照先/全テーマ切替、workspace図17個と説明/公開設計/分離/設定/起動/中継/HTTPSの各図3状態、自己チェック保持と印刷前後を専用Chrome1440/390で確認。新規図のスマホ画像も確認。実PDFは未出力。
- 未実装/未検証：Next.js公開ルート/案件画面、実公開証明書・公開DB/TLS・CA・最小権限、配信・負荷・デモ発行。今回の検証は専用ページであり、公開サイトの完成ではない。手順・引数・制約はHTTPS_COOKIE_CHECK.md。以下は過去の記録。

# 公開用中継・Cookieと内部Hostの分離（2026-11-15）

- api-proxy.tsへ中継の許可操作/入力制限/応答処理を共通化。local-api.tsの開発限定ガードを維持し、公開用中継とCookie検査を別部品で追加。公開用は固定Host/Origin、認証Cookieだけの転送、発行/削除のPath、Secure/HttpOnly/SameSite=Lax、__Host-のルートPath条件を検査する。不正な複数Cookieは全体を503にする。
- api-handler.ts/api-server.tsは内部listen先Hostと公開Originを別々に渡して照合。初回実APIログインは403。対象1件へ絞り原因コードINVALID_HOSTを確認し、公開Hostを内部接続Hostと混同する実装を修正後に成功した。その後、全API関連101件を再実行し成功。
- 初回型検査は.ts付きimportの設定不足で停止。tsconfig.jsonへallowImportingTsExtensionsを追加し、既存noEmit/strictを維持したうえで本体/API型検査に成功。
- 業務41＋ローカル中継19＋設定9＋公開中継10＝79件、API関連101件、lint、本体ビルド成功。型キャッシュはビルド前へ復元。新規依存/DBスキーマ/業務ルール/配信設定の変更なし。
- API関連の新規1件は、公開用中継関数から実fetch/ローカル実API/専用DBへ接続。Secure Cookieの返却、秘密値を除いた本人取得、チーム取得、ログアウトでの削除Cookieと旧セッション無効化を確認。NodeでCookieを手動受け渡しする検証であり、実HTTPSブラウザーや公開DB/TLSの測定ではない。
- 起動元を確認した開発APIのみ再起動し、共通化したローカル接続で実Chrome47シナリオ成功。一時データ/セッションは終了時に削除。準備用アカウント・案件は変更せず、通常の開発API再起動後は再ログインが必要。
- 理解ノート59にpublic-proxyを追加し60テーマ/62履歴。構文/参照先/全テーマ切替、workspace図17個と説明/公開設計/分離/設定/起動/中継の各図3状態、自己チェック保持と印刷前後を実Chrome1440/390で確認。新規図は画像でも確認。実PDFは未出力。
- 未接続/未検証：公開ルートと案件画面の有効化、実HTTPSブラウザーのCookie保存/送信/削除、公開DB/TLS・CA・最小権限、配信・負荷・デモ発行。ルートの開発限定ガードやNODE_ENVは変更せず、CI/CD・Dockerfile・デプロイ設定も変更していない。詳細はPUBLIC_API_PROXY.md。以下は過去の記録。

# 設定から認証/DB起動への接続（2026-11-15）

- api-server.tsへDB接続/listen/Better Auth/受付/停止を共通化。auth-check.tsは従来の専用DB設定で呼び、任意引数でテスト時だけ固定secretを渡せる。public-api.tsは公開設定検査後にDBを作り、TLS証明書検証・固定secret・公開Origin・Secure Cookie指定を共通起動へ渡す。自動起動/公開CLI/配信設定は追加なし。
- 本体/API型検査、業務41＋中継19＋設定9＝69件、API関連100件、lint、本体ビルド成功。型キャッシュはビルド前へ復元。API側tsconfigのfilesへ公開入口を追加。依存・ロック・DBスキーマ・業務ルール・画面・中継は変更なし。
- API関連100件は既存96件＋新規4件。不正な設定でDB作成/起動を呼ばないこと、公開DBの接続先/TLS検証・認証設定の受け渡し、接続失敗時のDB切断・起動/DB作成エラーで秘密値やcauseを出さないことを確認。これらには代替依存を使用し、公開DBへの暗号化接続を実測していない。
- 再起動検証の1件は専用DBとHTTPを使用。一時ログインのCookieを同一ポート・同一secretの再起動後も使って本人を取得し、secret変更後はnullを確認。重複closeが同じPromiseになることも確認。一時セッションは終了時に削除。
- 起動元を確認した5175番の開発APIだけを再起動し、共通起動を使うコードで実Chrome47シナリオ成功。テスト専用の架空データは終了時に削除。常用アカウント・案件は変更していない。通常の開発APIは毎起動のsecret生成を続けるため、再起動後に再ログインが必要。
- 理解ノート58にpublic-api-startupを追加し、59テーマ/61履歴。構文/参照先/全テーマ切替、workspace図17個と説明/公開設計/分離/設定/起動の各図3状態、自己チェック保持と印刷前後を実Chrome1440/390で確認。新規図は両幅で画像も確認。実PDFは未出力。
- 未検証/未実装：実公開DB/TLS・個別CA・最小権限、実HTTPS/公開用Cookie/中継/画面/配信、デモ発行、負荷/全停止競合/初期化中503。公開用入口のlisten先はloopbackのまま。NODE_ENV偽装や開発限定ガード解除なし。CI/CD・Dockerfile・デプロイ設定の変更なし。以下は過去の記録。

# 公開設定の検査部品と開発の振り返り（2026-11-15）

- public-api-settings.tsを追加。公開用環境変数の必須項目/URL/秘密値/DB情報/TLS方針を検査する。項目名だけのエラー、暗黙の既定値/ローカル設定へのフォールバックなし。tsconfig.jsonのfilesへ追加してAPI側の型検査に含めた。実秘密値の生成・環境ファイルの変更は行っていない。
- 新規の設定9件＋業務41件＋中継19件＝69件成功。本体/API型検査、ESLint、本体ビルド成功。型キャッシュはビルド前へ復元。新規テストは架空値だけを使い、DB/ネット/ファイル読込をしない。
- 検査結果には秘密値が含まれるが、エラーの文字列/JSON/スタックへ入力値を含めないことを確認。DB名/ポート/ユーザーの制約も確認。正常入力が実際の有効な認証値・存在するDB・最小権限・TLS接続であるとは確認していない。
- ローカルの起動/受付/業務/DBスキーマ/画面は変更なし。API/DB96件・画面47シナリオは前段階の結果で今回再実行なし。新規依存、CI/CD、Dockerfile、配信設定の変更なし。
- 理解ノート57にpublic-settingsを追加し、58テーマ/60履歴。構文・参照先・全テーマ切替、workspace図17個と説明/公開設計/分離/設定の各図3状態、自己チェック保持と印刷前後を実Chrome1440/390で確認。新規図のスマホ画像も確認。実PDFは未出力。
- ユーザー依頼のやさしい振り返りHTMLを作成。5つの開発段階、画面→API→DB、実装済み/公開準備中を区別。外部依存なし。実Chrome1280/390の横はみ出しと折りたたみの展開を確認し、画像でも確認した。指定デスクトップへ「SiteFlow_これまでのまとめ.html」を新規コピーし、原稿とハッシュ一致を確認。継続する学習解説は既存の理解ノートへ集約する。
- 未実装/未検証：公開用起動への組込み、認証/DBへの設定受け渡し、実TLS/固定secretによる再起動後のセッション維持、公開用Host/Origin/Cookie/配信/デモ発行。PUBLIC_API_SETTINGS.mdとPUBLIC_DEMO_PLAN.mdを参照。以下は過去の記録。

# APIの受付とローカル起動の分離（2026-11-15）

- examples/mysql/api-handler.tsへHTTP受付を移動。auth-check.tsからDB/Origin/認証関数を渡す。startAuthCheckServerと戻り値を維持。初期化中のみ503 API_STARTING/no-storeとし、初期化後の受付本体は参照名など必要な置換以外が変更前と同じことを比較確認した。
- 本体とAPI側の型検査、業務41＋中継19＝60件、API/DB96件、ESLint、本体ビルド成功。ビルド時の型キャッシュは実行前へ復元。依存/ロック/DB定義/業務ルール/保存サービス/画面/中継ガードは変更なし。
- 初回型検査はworkに置いた変更前コピーの.tsを検査して停止。比較用コピーを.txtへ改名して再実行し成功。型検査の設定や対象除外は変更していない。
- 5175番の起動元を確認し、既存のdev-auth.mjs開発APIのみ再起動。新しいAPIで実Chrome47シナリオ成功。初回は保存後の詳細再取得中に次のボタンへ進む既存テストが停止。clickTextでボタンの表示/有効状態を待つようにして再実行した。アプリの保存や入力検証は変更していない。
- API/DBテストは別の一時サーバー/データ、画面は再起動した開発APIと別の一時データを使用し、いずれも終了時に検証データを削除。常用の準備用アカウント・案件は変更していない。再起動後は検証用secretが変わるため再ログインが必要。
- 理解ノート56にapi-handler-splitを追加。57テーマ/59履歴。構文/参照先/全テーマ切替、workspace図17個と説明図/公開設計図/分離図の各3状態、自己チェック保持と印刷前後を実Chrome幅1440/390で確認。新規図の画像も両幅で確認。実PDF出力は未確認。
- 未実装/未検証：公開用の必須設定・固定secret・DB/HTTPS・配信/デモ発行、初期化中503を実HTTPで狙う確認、起動失敗/停止競合、公開性能。分離の完了は公開版の完成を意味しない。Dockerfile/CI/Next設定/package/lock/中継/案件ページ/開発起動/composeの9ファイルは作業開始時と同一。以下は過去の記録。

# 公開準備の設計と学習ガイド（2026-11-15）

- 文書だけの変更。PUBLIC_DEMO_PLAN.mdへ公開範囲・現行コードの差分・構成案・実装順・完了条件を記録し、READMEから案内。体験者別のデモ発行/期限/上限は未実装の提案。配信先・費用・日数も未確定。
- GITHUB_REVIEW.mdの既存の競合マーカーと重複を除去。古い別履歴作成案を、Gitの保護を維持して送信予定の差分を確認する現行手順へ整理。GitHub同期・履歴操作は行っていない。
- NON_FUNCTIONAL_REQUIREMENTS.mdへ公開用の分離/容量/認証の条件案と確認方法を追記。公開環境の達成・測定結果とは区別した。
- 学習ガイド55へpublic-demo-planを追加し、56テーマ/58履歴。安定IDと過去履歴を保持。構文・参照先・全テーマ切替、workspace図17個/説明図/公開設計図の各3状態、自己チェック保持、印刷前後を実Chrome幅1440/390で確認。新規図を両幅の画像でも確認。実PDF出力は未確認。
- README/設計書等のリンク、コード囲み、競合マーカー、既知の秘密値の混入を確認。git diff --checkとgit diff --cached --check成功。アプリ/配信関連10ファイルのSHA256が作業開始時と一致（Dockerfile、CI、Next設定、ルートpackage/lock、ローカル中継、案件ページ、認証API、API起動、開発compose）。開始前からの未コミット変更はそのまま保持。
- 文書のみのためアプリの型検査・業務/API/DB/画面テスト・ビルドは再実行していない。下記の60テスト/47画面シナリオは前段階の結果。HTTPS/Cookie/公開認証、デモ発行/削除、公開負荷・復元は未実装または未検証。公開設定・CI/CDの編集やデプロイはしていない。

# 通し操作・README・画面の仕上げ（2026-11-15）

- READMEを現在の構成へ更新。ローカルDB接続版とメモリデモ、構成図、操作順、起動・検証方法、未実装を区別。架空データのPC/スマホ画像を追加。
- 編集開始のフォーカスをフォーム全体から見出しへ変更。取得中にも入力破棄で戻れ、保存中は戻るボタンを無効化。スマホの見出し/操作の折り返しと補足色を調整。保管/復元の比較確認後の対象名は確認済みの最新値を表示する。
- 型検査、業務41＋中継19＝60件、ESLint、ビルド成功。型キャッシュは実行前へ復元。API/DB96件は以前の結果で今回は再実行なし。
- 実Chrome47シナリオ成功。新規1件を画面だけで登録→基本編集→主副担当変更→進行中/60％→確認待ち/100％→完了→保管→復元→理由付き再開→70％→再読み込み。最終状態・進捗・取引先・主担当・保管解除・再開理由のDB保存を確認。復元直後はDONEを保持する。同案件の画面操作にDB直接更新を挟んでいない。
- 見出しのフォーカス、Tabで戻るへ移動、Spaceで副担当を選択、初期GET保留中にEnterで破棄し詳細へフォーカス復帰、遅い応答で再表示されないことを確認。新しいGET検証はStrict Modeの再実行を許容し、取得回数を成果としない。
- 初回の追加テストは主担当未選択でネイティブ必須検証に停止。選択を追加。次の実行はGETを1回と決めつけた検証で停止し、既存の遅延GET検証と同様に1回以上の保留を許容して再実行した。アプリの入力検証を緩めていない。
- 幅1440/390の既存画面と、新規一覧1440/360の横はみ出しを確認。画像は一時ユーザー/架空案件で取得し、一時DBデータは終了時に削除。常用の準備用アカウントは変更しない。
- 理解ノートへ「操作しやすさ」「作ったものを短く説明する」を追加。55テーマ/57履歴。構文・参照先・全テーマ切替、workspace図17個×3状態、自己チェック保持と印刷前後を1440/390で確認。実PDFは未出力。
- 公開認証/配信、招待/会議、全操作の読み上げ/キーボード、全競合/性能は未実装または未検証。前段階の保管関連ページング等の未確認範囲は引き続き残る。新規依存、DB定義、CI/CD、Dockerfile、配信設定の変更なし。以下は過去の記録。

# 最新：アーカイブ・保管一覧・担当調整付き復元（2026-11-15）

- ProjectBrowserで通常/保管を切替え、collectionのキーで一覧/選択/追加ページを分離。保管詳細は閲覧専用で、保管日時・担当の所属・既存の関連情報を読む。詳細から確認画面を経て保管し、復元では主副担当の完成形を確認/選び直す。完了/状態/進捗を保持する。
- project-editorにarchive/restoreを追加し、現在の副担当を全ページ取得して保持。既存parseProjectArchiveInputとAPIを使用。409/5xx等の選択保持/比較を再利用し、結果不明後の最新GET404では通常/保管の両一覧で確認する案内を出す。保存中はチーム/ログアウト/一覧切替をロック。成功後は元の一覧を再取得し、行が消えた場合は見出しへフォーカスする。
- 中継は保管詳細/関連GETと通常案件URLのarchive/restore POSTだけを追加。保管中の更新は拒否。同一Origin/JSON32768バイト等を維持。業務ルール・既存API/保存サービス・DB定義/マイグレーション・依存・認証/配信・CI/CD・デプロイ設定の変更なし。
- 業務41件＋中継19件＝60件、本体型検査・ESLint・本体ビルド成功。型キャッシュはビルド前へ復元。API/DB96件と旧DB制約13件は前段階の結果で今回一括再実行なし。
- 実Chromeは既存分を含む45シナリオ成功。保管409/503後の比較/再送、連打でもPOST1回、保存中ロック、案件/状態/進捗/既存履歴保持と通常GET404を確認。保管詳細/進捗・状態履歴/別チーム404/保管詳細PATCH405、元所属主担当の復元拒否・503時の選択保持・主担当調整と復元/差分履歴1件、DONEの保管/復元と進捗保持を確認した。
- 保管一覧の失敗/再取得、20＋1件と重複なし、0件、遅い保管応答が通常一覧を上書きしないこと、チーム切替時の初期化、非担当memberの保管403、復元中401のログイン復帰を確認。ページ分割用21件は一時データを直接保管状態へ設定して取得したもので、21回の保管画面操作を検証したものではない。体験用アカウントは変更せず、補助ユーザー/案件/履歴を含む検証データは終了時に削除した。
- 一覧切替/保管/復元をEnterで操作し、幅1440/390の横はみ出し、確認/保管詳細/担当調整の画像を確認。理解ノート50〜52へworkspace-archive/workspace-archive-read/workspace-restoreを追加し、計53テーマ/55履歴。構文/参照先/全テーマ切替、関連16図各3状態、自己チェック保持と印刷前後を両幅で確認し、新規図の画像も確認。実PDF出力は未確認。
- 未実装/未検証：公開環境の認証/配信、招待/所属管理/会議、保管/復元そのものの監査履歴・実行者記録、全競合/性能/全ブラウザー/読み上げ/全操作のキーボード。保管中の副担当/担当履歴ボタン、復元初期の副担当複数ページ/元所属副担当解除、同時復元、保存成功後の応答喪失と最新GET404案内の画面通しは今回未確認。503はブラウザー注入。次は全体の通し確認とポートフォリオの説明/画面の仕上げ。詳細はLOCAL_WORKSPACE.md。以下は過去の記録。

# 状態変更・完了・理由付き再開の画面接続（2026-11-15）

- 既存エディターへstatusモードを追加し、詳細から状態変更/再開を操作できる。domain.tsの遷移表をコピーして返すavailableProjectStatusTargetsを追加し、候補と業務判定を共通化。確認待ち/100％の完了条件、再開理由、進捗保持、元所属担当の調整案内を表示する。業務上の遷移と既存API/保存サービスは変更なし。
- 状態PATCHだけを中継へ追加。409/5xx等の入力保持/比較を再利用し、明示比較後は判定用の現在状態/進捗も更新する。古い変更先と理由を保持したうえで、最新の条件で選び直せる。公開/認証設定・新規依存・DB定義/マイグレーション・CI/CD・デプロイ設定の変更なし。
- 業務41件＋中継17件＝58件成功。本体型検査・ESLint・本体ビルド成功。初回テストは旧「statusは未公開」期待値1件が404を期待して失敗。公開済みURLの未許可GETは405で、新規テストもそれを確認するため、旧期待値を更新後に58件を再実行して成功。型キャッシュはビルド前へ復元。API/DB96件・旧DB制約13件は前段階の結果で今回は一括再実行なし。
- 実Chromeは既存分を含む37シナリオ成功。保留→進行中→確認待ち、飛び越し候補なし/進捗不足の完了無効化、実際の確認待ち/100％からの完了、二重クリックの通信1回と保存中ロック、状態/版/履歴/進捗保持を確認。空欄/空白の再開理由の送信前拒否、元所属の副担当のAPI拒否と選択/理由保持、担当調整後の再開、503で理由保持/比較/再送、実409で最新状態の遷移へ再判定、非担当memberの403、保存中401でプロジェクト破棄と再ログインを確認した。
- 状態/完了/再開をEnterで保存し、幅1440/390の横はみ出しと完了/再開比較の画像を確認。新規の検証案件は既存の一時案件のうち1件を使用し、元所属担当の追加/解除も含めて終了時に削除。体験用アカウントの内容は変更していない。
- 理解ノート47〜49へworkspace-status/workspace-complete/workspace-reopenを追加。計50テーマ/52履歴。構文/参照先/全テーマ切替、関連13図各3状態、自己チェック保持と印刷前後をChrome幅1440/390で確認し、新規図の画像も確認。実PDF出力は未確認。
- 未実装/未検証：アーカイブ/保管一覧/復元の操作画面、会議/招待/公開環境、全競合/性能/全ブラウザー/読み上げ/全操作のキーボード。元所属の主担当を含む再開、画面での全25遷移、状態の保存成功後に応答だけ失う実障害は今回未確認。25遷移/追加条件は業務テスト、原子性等は前段階のAPI/DBテストと区別する。チーム/画面移動・再読込・明示破棄・401では入力を失う。詳細はLOCAL_WORKSPACE.md。以下は過去の記録。

# 基本編集・担当変更・進捗更新の画面接続（2026-11-15）

- project-editor.tsxを追加。基本情報は開始時との差分PATCH、主副担当は完成形PUT、進捗は整数/メモのPATCH。domain.tsの既存入力検証を共有する。409/5xx/通信失敗では入力を保持して再送を止め、開始時/最新/入力を比較し、明示確認した時だけ保存する版を更新。最新取得だけでは入力も版も変更しない。
- project-detail/connected-workspaceは3フォームの開閉・完了済み進捗ボタンの無効化・保存中の親操作ロック・成功後の詳細/関連/一覧再取得を追加。workspace-apiはPATCH/PUT指定、local-apiは3経路だけ追加し、同一OriginとJSON32768バイト等を維持。状態変更/保管/復元は未接続。
- 通常詳細の主担当と副担当APIへuserIdを追加。名前から候補IDを推測せず、現在の全担当を初期値へ保持するため。返却値の期待値を更新し、API/DB96件（HTTP81＋サービス直接15）を再実行して成功。保存サービス・業務ルール・DB定義/マイグレーション・依存・CI/CD・デプロイ設定は変更していない。ローカルAPIを再起動し、既存Cookieは再ログインが必要になった。
- 業務40件＋中継16件＝56件、本体/検証API型検査、ESLint、本体ビルド成功。型キャッシュはビルド前へ復元。旧DB制約13件は今回再実行なし。
- 実Chromeは既存分を含む30シナリオ成功。DB側で並行更新させた基本編集409、入力保持と明示比較、503後の再比較、二重クリックの通信1回/保存中ロック、部分更新による他者の未変更項目保持、任意項目のnullを確認。主副入替は所属解除した候補の拒否と選択保持、担当/版と差分履歴3件の一括保存を確認。非担当memberの編集は403でDB不変。進捗は0→40→100、メモ/2件の履歴、100でも状態保持、DONE時の進捗ボタン無効化を確認。旧チームの遅い初期取得も破棄した。
- Enterで保存する基本/担当/進捗の操作、幅1440/390と横はみ出し、比較/担当/履歴の画像を確認。画面検証の副担当2人/追加候補22人/登録2案件などは一時データで、終了時に削除。体験用アカウントは検証で変更していない。
- 理解ノート44〜46へworkspace-edit/workspace-assignees/workspace-progressを追加。計47テーマ/49履歴。構文/参照先/全テーマ切替、関連10図各3状態、自己チェック保持と印刷前後をChrome幅1440/390で確認し、新規図の画像も確認。実PDF出力は未確認。
- 未実装/未検証：状態変更/完了/再開・保管の操作画面、公開環境、基本情報専用の監査履歴、全競合/性能/全ブラウザー/読み上げ/全キーボード操作。担当/進捗フォームの409・5xx比較、保存中401、編集初期の副担当が複数ページある画面通しは今回未確認（API単体と共通実装へ依存）。通信失敗は保存前の503注入で、保存済み応答喪失の実障害は未再現。再読込/チーム・画面移動/破棄/401では入力を失う。詳細とファイルの役割はLOCAL_WORKSPACE.md。以下は過去の記録。

# 案件登録フォームと保存失敗時の扱い（2026-11-15）

- project-create.tsxを追加し、基本情報/主副担当の入力、候補20件ずつ取得、保存失敗の入力保持、成功後の詳細表示と一覧再取得を実装。domain.tsの既存入力検証を画面でも使用し、API側の現在の所属確認とトランザクション保存を使う。中継にはmembers GETと案件一覧URLへのPOSTだけ追加。認証本文4096、案件本文32768バイトで制限する。
- 業務40件＋中継14件＝54件成功。本体型検査・ESLint・本体ビルド成功。型キャッシュはビルド前へ復元。新規依存・業務ルール・DB定義/マイグレーション・既存のAPI保存処理・CI/CD・デプロイ設定は変更していない。旧API/DB96件は再実行なし。
- 実Chromeは従来分を含む24シナリオ成功。追加分は担当候補20＋4人と初回取得失敗/再試行、画面の空白名拒否、所属解除した副担当のサーバー拒否と入力保持、503時の未登録確認まで再送不可、2000文字の日本語備考、二重クリックでも送信1回、保存中のチーム/ログアウト無効化、実保存と主副担当/初期履歴、詳細表示と再読込後の永続化。旧チーム候補の遅い応答、候補0件、破棄後フォーカスも確認。Enterでフォームを開き、最小入力を送信、必須不足時のフォーカス、任意項目null/副担当0人の保存を確認。
- 架空の追加候補22人と登録した2案件を含む一時データを終了時に削除。体験用ユーザーのデータは変更していない。画面幅1440/390で横はみ出しと登録/結果不明の画像を確認。端末/ブラウザーの網羅ではない。
- 同一画面での重複ガードと自動再送なし。通信エラー/5xxは保存結果不明として入力を保持し、別タブの同じチームで未登録を確認するよう案内する。サーバーの冪等性キーは未実装で、複数タブ/再読込/誤確認まで二重登録を防ぐ保証はない。APIまで届いて保存後に応答だけ失う実障害は未再現（今回はブラウザーで503を注入）。
- 理解ノート42〜43へworkspace-create/workspace-save-failureを追加。計44テーマ/46履歴。構文/参照先/全テーマ切替、関連7図各3状態、自己チェック保持、印刷前後をChrome幅1440/390で確認し、新規図の画像も確認。実PDF出力は未確認。
- 編集/担当変更/進捗/保管の操作画面、公開環境、全キーボード操作/読み上げ、全ブラウザー、性能、候補の追加ページ失敗/候補再取得で選択者が消えた場合/登録中の401の画面通しは未実装または未検証。チーム切替・再読み込み・画面移動・破棄・401によるログイン復帰では入力を失う。再現/ファイルの役割はLOCAL_WORKSPACE.md。以下は過去の記録。

# 案件詳細・副担当・履歴の画面接続（2026-11-15）

- 一覧の案件名から基本情報を開き、副担当/進捗・状態履歴/担当変更履歴を必要時に取得できる。通常20件と続き取得、0件、失敗/再試行を用意。一覧を保持して戻り、元のボタンへフォーカスを戻す。チーム変更では一覧と詳細を破棄する。
- 新規project-detail.tsxへ詳細と関連取得のuseReadフックを分離。workspace-api.tsへ既存の通信関数/型/ラベルを共通化。中継にはUUID形式の詳細と関連3種のGETだけ追加。更新API/業務ルール/DB定義/依存/CI/CD/デプロイ設定は変更していない。
- 業務40件＋中継12件＝52件成功。本体の型検査、ESLint、本体ビルド成功。ESLintの初回は過去の検証用Chromeプロファイル内の拡張コードで失敗。自分で作ったプロファイルだけを削除し、画面検証のプロファイルをOSの一時フォルダーへ移動。規約/除外設定を変えず通常のESLint再実行で成功した。型キャッシュはビルド前へ復元。
- 実Chromeは従来分を含む18シナリオ成功。Enterで詳細/戻るとフォーカス、21件の保持、基本情報/改行/文字列としてのscript表示、現在/元所属の副担当、当時名/初期null担当履歴、履歴20＋1件と重複なし、初回/追加取得失敗と再取得、0件、実DBで保管した後の404、別チームの詳細/履歴404、詳細/関連情報の遅延応答の破棄を確認。基本情報と履歴の画面を1440/390pxで確認し、画像も確認。全キーボード操作や性能の保証ではない。
- 検証用に架空の副担当2人と進捗履歴21件を追加し、終了時に補助ユーザーを含む一時データだけ削除。体験用ユーザーのデータは変更していない。そのため体験用の副担当/進捗履歴は0件、担当履歴は初期記録が見える。
- 理解ノート40〜41へworkspace-detail/workspace-relatedを追加。計42テーマ/44履歴。構文/参照先/全テーマ切替、関連する5図各3状態、自己チェック保持、印刷前後をChrome幅1440/390で確認。新規図の画像も確認。実PDF出力は未確認。
- 登録/編集/保管操作の画面、詳細の共有URLやブラウザー戻る/進むとの連動、公開環境、全ブラウザー/読み上げ/全操作のキーボード、性能は未実装/未検証。再読み込みで初期一覧へ戻る。旧API/DB96件は今回再実行なし。詳細とファイルの役割はLOCAL_WORKSPACE.md。以下は過去の記録。

# ローカル画面のログイン・チーム選択・案件一覧（2026-11-15）

- `/workspace`を追加し、同一サイトのNext.js中継→既存認証/業務API→専用MySQLへ接続。`/`は従来のメモリデモ。開発時だけ利用でき、公開ビルドは準備中の案内。案件の詳細/登録/更新フォーム、公開環境の認証は未接続。
- 業務40件＋中継11件＝51件成功。本体/検証APIの型検査、ESLint、本体ビルド成功。Next.js 16.3.4でRoute Handlerの非同期paramsとRequest/Responseを確認。ビルド後、追跡済み型キャッシュを実行前へ復元した。
- 実Chromeの9シナリオ成功。1440px/390px、ログインのTab→Enter、失敗入力保持、HttpOnly/Path、セッション再読込、20＋1件の重複なし、0件、取得失敗と再試行、遅い旧チーム応答の混在防止、401時の内容破棄、ログアウト失敗と再試行/無効化を検証。一覧と失敗画面の画像も確認。全キーボード操作/読み上げ/全ブラウザーは未検証。
- ブラウザー検証は専用DBに一時ユーザー等を作り、そのデータだけ終了時に削除。体験用の架空ユーザー・2チーム・21案件は別に準備し保持。準備コマンドの再実行も準備済みの照合で終了し、上書きしないことを確認。ログイン情報はGit除外済みの`.env.workspace.local`のみ。実ユーザー登録・メール認証フローではない。
- 初回の画面検証でOrigin不一致を発見。Next.js内部URLのlocalhostとブラウザーのREQUIRES_APPROVED_PUBLIC_IPV4を、検査済みHostで比較するよう修正。非ループバック/違うポート/不正Host/異なるOriginの拒否テストを追加し、画面検証も再実行して成功した。
- 理解ノート37〜39へworkspace-login/workspace-teams/workspace-statesを追加。計40テーマ/42履歴。全テーマ切替、構文/参照先、新規図各3状態、自己チェック保持、印刷イベント前後を1440px/390pxで確認し、図の画像も確認。実PDF出力は未確認。
- 新規依存・DB定義・マイグレーション・CI/CD・デプロイ設定の変更なし。前段階のAPI/DB96件と旧DB制約13件は今回再実行していない。公開環境/負荷/性能の測定なし。起動・設定・変更理由はLOCAL_WORKSPACE.md。以下は過去の記録。

# アーカイブ・専用閲覧・復元（2026-11-15）

- domain.tsへ入力と変更判定、project-archive-service.tsへ保管/担当調整付き復元の一括保存、auth-check.tsへPOST archive/restoreと保管専用の一覧/詳細/関連GETを追加。保管中は通常の取得/編集から除外し、状態/進捗/履歴を保持。
- 業務40件、API/DB統合96件（HTTP81＋直接15）成功。追加はHTTP8件＋直接3件。保管→閲覧→復元、ページ分割/0件/境界、権限/所属/不正入力、担当調整と差分履歴、DONE保持、同値再送/版拒否を確認。
- 保管と他の編集のHTTP同時5操作は一方のみ成功、残りは409か対象外404。同版の同時復元も一方のみ成功。別ユーザーの直接同時保管、事前読取後の編集割り込みを検証。復元の最後の履歴INSERTの実P2002で、保管状態/版/主担当/副担当追加解除/新規人物の巻き戻しを確認。
- 本体/検証API型検査・ESLint・本体ビルド成功。型キャッシュは実行前へ復元。旧DB制約13件は今回再実行なし。依存/DB定義/マイグレーション/CI/CD/デプロイ設定の変更なし。
- 学習ノート34〜36へproject-archive・archive-read・project-restoreを追加。計37テーマ/39履歴。構文/参照先/全切替/新規図各3状態/自己チェック/印刷前後をChromeの1440px/390pxで確認し、6画像も確認。実PDF出力/キーボード通し操作は未確認。
- 本体画面、保管操作自体の監査履歴/実行者記録、物理削除、所属管理、全競合/負荷/公開環境は未実装／未検証。ルールはDATA_MODEL.md冒頭、詳細/再現はSCHEMA_DATABASE_CHECK.md冒頭。以下は過去の記録。

# 状態変更・完了・再開（2026-11-15）

- ユーザーが確認待ち＋100％で完了、理由付きで進行中へ再開し進捗保持を採用。domain.tsに遷移/追加条件、project-service.tsに所属/権限/版/再開時の担当確認と一括保存、auth-check.tsにPATCH /…/projects/:id/statusを追加。進捗APIの完了済みエラー説明も再開操作へ案内する形に訂正。
- 業務37件、API/DB統合85件（HTTP73＋直接12）成功。追加はHTTP8件＋直接3件。全25遷移、保留/差し戻し、開始から完了/再開/進捗修正のHTTP通し、条件拒否、元所属担当の拒否と調整後の再開、権限/境界/本文/同値等を確認。
- HTTP同時4保存（状態/進捗/基本/担当）で一方成功/残り409。別ユーザーのサービス同時状態変更で一方のみ成功/履歴1件。事前読取後の担当変更は409。実P2002による最後の履歴保存失敗で状態/版/新しい人物が戻る。全競合/高負荷の保証ではない。
- 本体/検証API型検査・ESLint・本体ビルド成功。型キャッシュはビルド前へ復元。旧DB制約13件は再実行なし。依存/DB定義/マイグレーション/CI/CD/デプロイ設定の変更なし。スキーマの説明コメントのみ現状へ訂正。
- 学習ノート31〜33へproject-status・project-complete・project-reopenを追加。計34テーマ/36履歴。全切替/構文/参照先/新規図各3状態/自己チェック/印刷前後をChromeの1440px/390pxで確認し、6画像も確認。実PDF出力とキーボード通し操作は未確認。
- 本体画面、アーカイブ/復元、所属解除の業務チェック、全競合/性能/公開環境は未実装／未検証。ルールはDATA_MODEL.md冒頭、詳細と再現はSCHEMA_DATABASE_CHECK.md冒頭節。以下は過去の記録。

# 状態変更の入力検証の準備（2026-11-15）

- domain.tsへ5種類の案件状態の型とparseChangeProjectStatusInputを追加。expectedVersionと任意メモの規則は進捗入力と共通化し、不正な状態・進捗/変更者等の追加属性を拒否する。これは入力の形の検証だけであり、状態遷移/完了/再開を許可するAPIではない。
- 業務テスト33件、本体と検証APIの型検査、ESLint、本体ビルド成功。API/DB74件は前段階の結果で、今回は更新APIやDB保存を変更していないため再実行なし。型キャッシュはビルド前へ復元。
- 完了条件・状態遷移・再開の規則はユーザーへ確認中。提案は確認待ちかつ100％で完了、理由付きで進行中へ再開し進捗を保持するもの。未回答の間は実装済み/確定仕様とは扱わない。依存・DB・CI/CD・デプロイ設定は変更なし。

# 進捗更新と履歴保存（2026-11-15）

- ユーザーが1％刻み・100％と完了は別操作を採用。domain.tsへ入力/変更判定、project-service.tsへ進捗/履歴/人物/版の一括保存、auth-check.tsへPATCH /…/projects/:id/progressを追加。進捗だけを更新し状態を保持。完了済みの変更とメモ単独の送信は拒否する。
- 業務31件、API/DB統合74件（HTTP65＋直接9）成功。追加分はHTTP8件＋直接2件。整数境界・減少・100でも非完了・各状態保持・DONE拒否、履歴の前後/本人/当時名/メモ/日時、同値のDB不変、権限/所属/担当/境界拒否を確認。
- 進捗・基本編集・担当変更のHTTP同時3保存で1件成功/2件409。別の主副担当の進捗更新はサービス直接で1件成功/履歴1件。実P2002で最後の履歴INSERTを失敗させ、進捗・版・新しい人物の巻き戻しを確認。全競合や高負荷の保証ではない。
- 本体/検証APIの型検査・ESLint・本体ビルド成功。型キャッシュは実行前へ復元。前段階のDB制約13件は再実行なし。DB定義/マイグレーション/依存/CI/CD/デプロイ設定は変更なし。スキーマコメントだけ現状へ訂正。
- 学習ノートへprogress-update・progress-write-history・progress-atomicを追加。計31テーマ/32履歴。全テーマ切替/構文/参照先/新規3図の各3状態/自己チェック保持/印刷展開と復元をChromeの1440px/390pxで確認し、6画像も確認。確認スクリプトのイベント伝播指定漏れを修正後に成功。実PDF出力・キーボード通し操作は未確認。
- 本体フォーム、状態変更/完了/再開、メモ単独投稿、全競合/性能/公開環境は未実装／未検証。確定したルールはDATA_MODEL.md冒頭、詳細/再現はSCHEMA_DATABASE_CHECK.md冒頭節。

# 担当変更と差分履歴（2026-11-15）

- domain.tsに担当一覧の入力/差分ルール、project-service.tsに一括更新、auth-check.tsにPUT /…/projects/:id/assigneesを追加。主副担当の重複や現在の所属を検証。変更なしは履歴/版/更新日時を維持。基本編集と同じ版を使用する。
- 業務27件、API/DB統合64件（HTTP57＋直接7）成功。追加分はHTTP6件＋直接2件。主副担当入替/追加/解除、当時の名前、変更なし、権限の移り変わり、元所属者の担当解除/人物保持、不正入力/所属/チーム/送信元/本文上限等を確認。
- 最後の履歴INSERTを実DBのP2002にし、主担当・版・副担当追加/解除・新規人物が巻き戻ることを確認。基本編集と担当変更のHTTP並行保存、別の主副担当のサービス並行保存で一方のみ成功。全並行操作の保証ではない。
- 本体と検証APIの型検査、ESLint、本体ビルド成功。追跡済み型キャッシュは実行前へ復元。補強した巻き戻しテストを含む64件も再実行成功。前段階のDB制約13件は今回は再実行なし。
- 学習ノート25〜27へassignees-change・assignees-diff・assignees-atomicを追加。計28テーマ/29履歴。構文/参照先/全テーマ切替/新規3図の各3状態/自己チェック保持/印刷展開と復元を確認。Chromeの幅1440pxと390pxで横はみ出しを調べ、6画像を確認した。実PDF出力・キーボード通し操作は未確認。
- 本体フォーム、進捗更新・完了条件、作業/決定事項の引き継ぎ、所属管理、公開環境/負荷/全競合は未実装／未検証。詳細と再現はSCHEMA_DATABASE_CHECK.md冒頭節。スキーマはコメントのみ訂正、定義不変。依存/マイグレーション/CI/CD/デプロイ設定は変更なし。

# 案件の基本編集と競合検知（2026-11-14）

- `domain.ts`に基本編集入力と編集許可、検証用`project-service.ts`に権限/版の確認と更新、`auth-check.ts`にPATCHを追加。担当や進捗は変更不可。本体画面は未接続。
- 業務24件、API/DB統合56件（HTTP51＋サービス直接5）成功。今回追加はHTTP5件＋直接2件。部分更新、任意項目の保持/削除、主副担当/管理者、単なる作成者や元所属者の拒否、入力/Origin/所属/チーム境界を確認。
- 古い版409とデータ不変、最新を読んだ後の保存、同一ユーザーのHTTP同時2保存、別ユーザーのサービス同時2保存で一方のみ成功を確認。保存後の読み取りをテスト専用例外で失敗させ、基本情報と版番号の巻き戻しも確認。全競合や負荷への保証ではない。
- 本体/検証APIの型検査、ESLint、本体ビルド成功。追跡済み型キャッシュは実行前へ復元。前段階のDB制約13件は今回再実行なし。
- 学習ノートへproject-edit・project-edit-access・project-versionを追加し、計25テーマ・26履歴。全テーマ切替/構文/参照先/横はみ出し、新規3テーマの図3状態、印刷時の詳細展開/復元をChromeの1440px/390pxで確認し、6枚の画像も確認した。自己チェックの維持は前段階の結果。実PDF出力とキーボードだけの通し操作は未確認。
- 基本情報変更履歴、本体フォーム/入力保持/差分比較、担当/進捗更新、所属管理、公開環境・性能・HTTP500通しは未実装／未検証。詳細・再現コマンド・設計判断はSCHEMA_DATABASE_CHECK.mdの冒頭節。依存・スキーマ・マイグレーション・CI/CD・デプロイ設定は変更していない。

以下は過去の段階の記録。

# 初版の検証結果（2026-09-30）

- TypeScript型検査：成功。
- Node標準テスト：7件成功。状態遷移、必須対応内容、日付、期限超過、完了率を検証。
- Vinext本番ビルド：成功。自動ルート分類にunknown表示あり。Next.js本体での検証ではない。
- ローカルHTTP応答：200。
- ブラウザ：新規指摘登録、対応開始、空の対応内容で確認依頼が拒否されること、対応内容入力後の確認依頼、承認完了、集計と履歴の更新を確認。
- 日付入力の確認中に問題を発見し、送信時の期限をFormDataから取得する形に修正。修正後に登録フローを再確認。
- 390pxの画面幅：ページ全体の横スクロールなし。スクリーンショットを保存。スマホ実機の操作検証は未実施。
- WebMCP参照ツール：登録・スキーマを確認。最新の指摘の読取、不正入力の拒否を確認。データ変更ツールは実装していない。
- 公開：Sitesの登録まで実施。公開用ワークフローへの入力が自動承認レビューに拒否され、ソース送信・公開は未完了。

認証、API、DB保存、権限、監査ログ、負荷試験、アクセシビリティの網羅的検証は未実施。性能目標などはNON_FUNCTIONAL_REQUIREMENTS.mdに仮目標として記載。

## ドキュメント管理・学習支援ルールの更新（2026-11-12）

- 学習時に設定やコマンドを読み返せるよう、AGENTS.mdに技術の役割・既存技術との関係、設定項目、再現手順、変更理由、秘密情報を記載しない方針をまとめた。
- コマンドは既出でも目的・各オプション・期待される結果・ファイルやデータへの影響を省略せず簡潔に説明する方針とした。
- 学習用スキルのコマンド説明を同じ方針にそろえた。スキルの名前・説明・適用範囲は変更していない。
- 文書の内容・差分と `git diff --check` を確認した。
- スキルの専用検証プログラムは実行環境のPythonにyamlライブラリがないため完了できなかった。既存のNode.js用js-yamlで、YAMLの構文と名前・説明の基本項目を検査し、成功した。
- アプリのコード・DB・CI/CD設定は今回変更していない。型検査・業務テスト・ビルドは再実行していない。
- 次に読む箇所はAGENTS.mdの「ドキュメント管理と学習支援」。練習は既存のMySQL起動コマンドについて、目的・オプション・期待される結果・影響を説明してみること。

## Next.jsへの移行（2026年11月13日）

- 通常の開発・ビルド・本番起動、承認済みのDockerfile、独立したDB検証用アプリをNext.js 16.3.4へ切り替えた。ライブラリの追加・更新、ルートのロックファイル変更はない。
- 本体・検証用アプリの型検査、業務ルールテスト8件、Next.js本番ビルドに成功。
- 開発5173番・本番起動3000番・Docker3001番で、画面HTML・CSS・ヘルスチェックAPIの200、POSTの405、本体に検証APIがない404を確認。
- 検証用Next.js APIでPrismaからMySQLへ接続し、正常200、不正パスワード503、POST 405、no-store、追跡IDとログの一致、秘密情報非表示、通常設定へ戻して200を確認。DBのテーブル・データ・認証情報は変更していない。
- DockerのLinuxイメージをビルドし、内部のHTTP応答と、ローカルの秘密設定・検証用生成物がコピーされていないことを確認。
- ESLintは未達。以前からあるworkspace.tsx:33のreact-hooks/set-state-in-effectが1件残る。この画面コードは今回変更していない。Next.js・Prismaの生成物を検査して出ていた指摘は除外設定で解消した。
- ブラウザー専用接続は「browser access host is unavailable」、Chrome直接接続は最小化状態・ストリーム破損のエラーとなった。今回のクリック・スマホ幅・キーボード操作は未確認。HTTPの成功をブラウザー操作の成功として扱わない。
- GitHub Actions・AWS・Nginx・デプロイスクリプトは変更せず、commit・push・公開も行っていない。旧Vinext/Sites用設定と依存は通常の起動から外し、段階的な整理のため残した。
- 再現手順、変更理由、課題、学習用の読む順序は [NEXTJS_MIGRATION.md](NEXTJS_MIGRATION.md) に記録。

## 日付処理のESLint修正（2026年11月14日）

- 移行後、ユーザーからシークレットウィンドウでの登録・対応開始・空入力拒否・確認依頼・完了の確認報告を受けた。通常ウィンドウでのみ出る拡張機能由来とみられるエラーとは分けて扱う。
- workspace.tsxの日付用stateと同期的にsetStateするEffectを、React標準のuseSyncExternalStoreへ置き換えた。東京日付を読み、1分ごととfocus時に再確認する。サーバー描画・ブラウザー初回描画の値は空文字でそろえ、解除時にタイマーとイベントを片付ける。
- ESLintは指摘0件、型検査・既存の業務ルールテスト8件・Next.js本番ビルドはすべて成功。開発サーバーの画面と/api/healthはHTTP 200。git diff --checkも成功。
- 追跡済みのtsconfig.tsbuildinfoはビルド前の内容へ戻し、今回の差分に含めていない。依存・DB・CI/CD・Dockerfileは今回変更していない。
- 自動ブラウザー接続のホストは引き続き利用できず、今回の日付処理修正後の画面操作・スマホ幅・キーボード・日付またぎ・focus復帰は未確認。ユーザーによる修正前の操作確認と区別する。性能改善は測定していない。
- 理由・構文・再現手順・次の学習は [TOKYO_DATE_SYNC.md](TOKYO_DATE_SYNC.md) に記録。次はDATA_MODEL.mdのユーザー・チーム・所属・案件の設計を具体化して、Prismaのテーブル設計へ進む。

## データ設計の具体化（2026年11月14日）

- 既存のDATA_MODEL.md、ユーザー提供の要件引き継ぎ、接続検証用のPrisma設定、Better Auth・Prismaの公式資料を読み、DATA_MODEL.mdの第7節へ具体案を追記した。
- ユーザー・チーム・所属・案件の例とER図、独立した所属IDと重複禁止、主担当の必須列と副担当の関連、同じチームを保証する複数列の外部キー案、DBとAPIの責任分担を整理した。
- これらは検証前の設計案。Better Authとのモデル・ID・チーム管理方式の照合、所属解除・履歴・削除の扱いなどは未確定。進捗率の整数／小数と完了条件はユーザーへ確認中として記載した。
- 今回変更したのは文書のみ。Prismaスキーマ・API・画面・DB・CI/CDは変更していない。型検査・業務テスト・ビルドや、DBの制約の拒否テストは実行していない。
- 内容と差分の点検を実施する。設計の記載をDB制約の実装・検証済みとして扱わない。

## Prisma形式のスキーマ案（2026年11月14日）

- db/design/schema.prismaに、Userを認証との接続点とする候補、Team・TeamMembership・Project・ProjectSupportMemberを追加。本体と接続確認用スキーマからは読み込まない。進捗率・文字数等は未確定の仮置きとして明示し、User以外の認証モデルは収録していない。
- 検証用パッケージへvalidate:designを追加し、Prisma 7.10.1で構造検査に成功。指定ファイルだけをPrisma formatで整形した。既存のClient生成・接続検証・APIの参照先、依存・ロックファイルは変更していない。
- ESLint・型検査・既存の業務テスト8件・Next.js本番ビルドは成功。追跡済み検査キャッシュはビルド前の内容へ戻した。
- DB接続・テーブル作成・マイグレーション・MySQLでの拒否テスト・認証実装は行っていない。Prismaのvalidate成功を、DB制約の実動作やBetter Authとの互換性確認済みとして扱わない。
- 主担当と副担当の重複、進捗0〜100と完了条件、versionによる競合検出、所属解除・履歴保持などは引き続き未実装。手順と構文の説明はPRISMA_SCHEMA_DRAFT.mdへ記録した。

## Better Auth用スキーマの生成・照合（2026年11月14日）

- 検証用examples/mysqlだけにbetter-auth・authを1.7.23で固定して追加。Node 24.20.0、Prisma 7.10.1を使用。npm情報取得時のEACCES後、制限外で取得・追加に成功した。本体の依存・ロックファイルは変更していない。
- DB・メール送信を設定しないschema-auth.config.tsを追加し、OrganizationをTeam、MemberをTeamMembershipとして比較用スキーマを生成。生成専用の秘密値は毎回メモリ上だけに作成し、APIとして公開しない。
- db/design/auth-generated.prismaの生成、Prisma validate、検証用の型検査に成功。本体の型検査・ESLint・業務テスト8件・本番ビルドも成功。追跡済みキャッシュはビルド前へ戻した。
- 重複所属の一意制約不足、標準の連鎖削除、roleのText表現とowner、IDの列型、slug、所属削除と過去案件・作成者の参照の衝突を記録した。生成物をそのまま完成版として適用していない。
- DB接続・テーブル作成・マイグレーション・ログイン・Cookie・招待・メール送信・権限拒否・競合の動作検証は未実施。認証APIは本体へ追加していない。
- 実際の確認範囲、再現コマンド、未確定事項はBETTER_AUTH_SCHEMA_REVIEW.mdへ記録。次は認証用と案件用の統合の前提として、所属解除・履歴保持と2種類の役割への制限を具体化する。

## 所属と履歴を分けたスキーマ統合（2026年11月14日）

- db/design/integrated.prismaに認証・チーム・所属・招待・人物記録・案件・副担当・2種類の履歴の12モデルを統合。現在の権限はTeamMembership、履歴の人物識別は権限を持たないTeamParticipantへ分離した。
- 主担当・作成者・副担当・変更者を同じチームの人物へ関連付ける候補、所属と人物記録の重複禁止、admin/memberのenum、表示名のスナップショット、業務参照のRestrictを記載した。未完了担当・最後の管理者の解除拒否、復元・再開時の担当再確認は設計のみ。
- Prisma 7.10.1でformat・validate・Client生成に成功。生成先は既存除外範囲内のexamples/mysql/generated/integrated。Node.jsの型除去による読込も成功し、Clientを作成せず役割enumを確認した。
- 本体と検証用コードの型検査、ESLint、既存の業務テスト8件、Next.js本番ビルドは成功。追跡済みキャッシュはビルド前へ戻した。
- SQLプレビューは終了コード0でもファイルが作られず、通常・制限外・対話端末で同じ結果。エンジン単体のバージョン表示は成功したが、原因は未特定。試行用のpreviewコマンドは実行メニューから外し、SQL生成成功とは扱っていない。
- DB接続・適用・マイグレーション・所属削除後の履歴保持・再参加・権限拒否・並行処理・Better Authアダプターとの統合は未検証。スキーマやClientの生成を、これらの動作確認済みとは扱わない。
- 既存の接続確認用スキーマ・API・本体UI・依存・AWS・CI/CD・Dockerfileは今回変更していない。設計の理由、再現方法、未完了項目はMEMBERSHIP_AND_HISTORY.mdへ記録した。

## 分離したMySQLへの適用・統合テスト（2026年11月14日）

- SQL未生成の原因を診断出力で確認。このCLI/エンジンはdatasource引数を要求しており、schemaだけの設定では不足していた。実在のDBを参照しないSQL生成専用設定を追加して生成成功。終了コードだけでなくファイルの存在を確認した。
- 生成SQLをdb/design/migrations/20261114_integrated_schema_check/migration.sqlへ保存し、mysqlのmigration_lockを追加。プレビューとのSHA-256一致を確認した。今後は適用済み履歴を上書きせず追加履歴で変更する。
- 既存の開発用DBと異なる名前の検証DB・専用ユーザー・Git除外済みのローカル設定を作成し、専用DBへPrisma migrate deployで1件の履歴を適用。DBはMySQL 8.4.13、Prisma 7.10.1、Node 24.20.0。
- DB統合テスト13件すべて成功。限定権限、所属・人物の重複拒否、主担当・作成者・副担当・履歴のチーム境界、不正roleの直接SQL拒否、表示名の履歴保持、所属削除と再参加、人物・User・Teamの削除拒否、途中失敗のトランザクションの巻き戻しを確認した。
- 通常の明示フラグなしではDBテストがスキップされ、接続しないことを確認。本体と検証用の型検査、ESLint、既存業務テスト8件、Next.js本番ビルドも成功。
- 検証前後の既存DBは0テーブルのまま。専用DBは12モデルと_prisma_migrationsの13テーブル。架空データを見返せるよう専用DBは残し、DBやボリュームの削除・リセットは行っていない。
- 本体UI・API・既存の接続確認用スキーマ・依存・本体ロックファイル・AWS・CI/CD・Dockerfileは今回変更していない。追跡済みキャッシュはビルド前へ戻した。
- 認証API、Better AuthのPrismaアダプター、メール・Cookie・招待、業務APIの拒否や並行処理は未検証。実際の結果と再現手順はSCHEMA_DATABASE_CHECK.mdへ記録した。

## 分離した認証APIの検証（2026年11月14日）

- examples/mysql/auth-check.tsでBetter Auth 1.7.23のPrismaアダプターを専用MySQLへ接続。Node標準HTTPサーバーに本人確認の3ルートのみ公開した。本体のNext.jsには未接続。
- tests/auth-check.test.mjsのHTTPテスト7件成功。ログイン、DBのSession、HttpOnly/SameSite=Lax、Cookieでの本人取得、改ざん拒否、ログアウト後の旧Cookie失効、未認証メール・誤パスワード・不正入力・Originなし/不正・Host不正・非公開ルート・メソッドの拒否を確認。
- テストでは架空ユーザーを直接作り、終了時に今回のユーザーと関連データだけ削除。メール認証済みフラグはテスト条件であり、登録・メール送信の検証結果ではない。
- 通常のフラグなし実行はスキップ。本体と検証用の型検査、ESLint、業務テスト8件、本体ビルド成功。DB13件は前段階の結果を維持し、今回再実行していない。追跡済みキャッシュはビルド前へ戻した。
- 制限環境のtsx起動失敗は許可された制限外で再確認。Hostテストはfetchによる書換えを避けnode:httpで送信して403を確認。前回のノートQA用一時スクリプトがESLint対象になっていたため、不要になったその一時ファイルだけ削除して規約検査成功。
- 登録・メール認証フロー・招待・チーム権限・本体画面・実ブラウザーCookie・HTTPS・公開環境は未実装／未検証。AWS・CI/CD・Dockerfile・依存・本体APIは今回変更していない。詳細はSCHEMA_DATABASE_CHECK.md末尾を参照。
- 学習ノートの現在地・09の図・確認範囲・履歴を更新。既存10テーマと過去10件の履歴を維持し、履歴1件を追加。構文・参照先・秘密値の非混入を確認し、Chromeの幅1440px/390pxで10テーマの切替と図の横はみ出しを検査。09の画像も確認した。これは本体の認証UIの検証結果ではない。

## チーム情報の閲覧境界（2026年11月14日）

- 分離APIにGET /api/teams/:teamId/accessを追加。Cookieの本人とDBの現在の所属に基づき、チームのID・名前と本人の役割だけを返す。閲覧の業務ルールはdomain.tsのcanReadTeamに分離。
- HTTP13件成功（前段階7件＋6件）。未ログイン/改ざん/ログアウト後401、所属あり200、未所属/存在しないチーム/所属解除後403、不正ID400、更新メソッド405を確認。偽のuserId/roleやセッションの選択中チームでは回避できない。
- 所属解除後もログインと人物記録が残る条件で拒否し、再所属で閲覧が戻ることを確認。所属管理はDBフィクスチャ操作であり、APIによる所属解除や業務検査の結果とは区別する。テスト用の2チーム・所属・人物記録・ユーザーは終了時に今回のIDだけ削除。
- 純粋な閲覧ルール3件を追加し、業務テスト計11件成功。本体と検証用の型検査・ESLint・本体ビルド成功、通常のフラグなし認証テストはスキップ。追跡済みキャッシュをビルド前に戻した。DB整合性13件は前段階の結果で今回は再実行していない。
- 案件操作の権限、同時実行、所属管理API、登録・メール・招待、本体接続は未実装／未検証。依存・DBスキーマ・マイグレーション・CI/CD・Dockerfile・デプロイ設定は変更していない。
- 学習ノートに安定IDのteam-accessを追加し、既存テーマIDと履歴を維持。計11テーマ・12件の開発履歴。Chromeの幅1440px/390pxで全テーマ、図の3状態（401/200/403）、横はみ出し、自己チェックの維持を確認し、新テーマの画像も確認した。本体UIの検証とは区別する。

## 所属チームの案件一覧（2026年11月14日）

- 分離APIにGET /api/teams/:teamId/projectsを追加。本人と現在の所属を確認し、案件の検索自体も対象チーム・現在の所属・未アーカイブで絞る。納期とIDの昇順、既定20/最大50件、cursorによる続きの取得を実装。
- HTTPテスト計18件成功（前段階13＋5）。通常23件を3件ずつ読み、同じ納期を含む順序・重複/漏れ・末尾を確認。0件、完了を含むこと、アーカイブ/他チームの除外、不正limit/cursor/重複/未知の条件、401/403/405、所属解除/再所属を確認。作成した案件等は今回のIDだけを削除。
- 業務テスト計13件成功（前段階11＋2）。入力の既定値、境界1/50、UUID、0/51・空・小数・指数等の拒否を検証。本体/検証用の型検査、規約検査、本体ビルド成功。通常のHTTPテストはスキップ。追跡済みキャッシュはビルド前へ戻した。
- DB整合性13件は前段階の別の検証で今回再実行していない。本体接続、登録/更新/詳細、会議集計、同時変更中の一覧、SQL回数・性能は未実装／未検証。スキーマ・マイグレーション・依存・CI/CD・Dockerfile・デプロイ設定は変更していない。詳細はSCHEMA_DATABASE_CHECK.md末尾。
- 学習ノートにproject-listを追加し、既存IDと過去の履歴を維持。計12テーマ・13件の開発履歴。構文と参照先を確認し、Chromeの幅1440px/390pxで全12テーマと図の切替・横はみ出しを確認。新テーマの3状態と画像も確認した。本体画面のAPI接続や操作の確認ではない。

## 案件の基本詳細取得（2026年11月14日）

- 分離APIにGET /api/teams/:teamId/projects/:projectIdを追加し、案件ID・チームID・未アーカイブ・現在の所属で絞る。基本項目、概要・発注者・備考・主担当・作成時の名前・version等をselectして返す。
- HTTP22件成功（前段階18＋4）。正常取得、両チーム所属でもURLとの組合せが違えば404、別チーム/存在しない/アーカイブ案件の同じ404、memberの閲覧、任意項目null、現在名と作成時名の区別、不正ID/検索条件/メソッドを確認。未ログイン・改ざん・所属解除・再所属・ログアウト後・偽の本人情報でも詳細ルートの拒否/許可を検証。
- 業務ルール13件、本体と検証用の型検査・規約検査・本体ビルド成功。通常のHTTPテストはスキップ。追跡済みキャッシュはビルド前へ戻した。DB整合性13件は前段階の結果で再実行していない。
- 本体画面、副担当・変更履歴、案件登録/更新、アーカイブ参照/復元、競合・性能は未実装／未検証。versionの返却を競合防止の完了とは扱わない。スキーマ・マイグレーション・依存・CI/CD・Dockerfile・デプロイ設定は変更していない。
- 学習ノートにproject-detailを追加し、既存IDと過去の履歴を維持。計13テーマ・14件の開発履歴。構文・参照先を確認し、Chromeの幅1440px/390pxで全テーマの切替・横はみ出し、新しい図の3状態と自己チェックの維持、画像を確認した。本体の詳細画面を検証した結果ではない。

## 副担当の取得（2026年11月14日）

- 分離APIへGET /api/teams/:teamId/projects/:projectId/support-membersを追加。本人・現在の所属と案件のチームを確認し、人物ID順に既定20/最大50件のカーソル取得。人物ID・現在の名前・現在の対象チームへの所属の有無だけを返す。
- HTTP26件成功（前段階22＋4）。副担当3人、2人ずつの順序・重複/漏れと末尾、0人、案件/チーム/cursorの境界、不正入力/メソッド、Cookieなし/改ざん/所属解除/ログアウト後等を確認。両チーム所属でも案件の取り違えは404。
- 副担当の所属をDBから直接外すと、他チームへの所属があっても対象チームのisCurrentMemberはfalseとなり、担当記録は残ることを確認。担当の追加/解除・未完了担当の所属解除拒否をAPIで実装したという結果ではない。
- 業務ルール13件、本体/検証用の型検査・規約検査・本体ビルド成功。通常実行のHTTPテストはスキップ。追跡済みキャッシュはビルド前へ戻した。DB整合性13件は再実行していない。
- 本体画面、担当変更・所属解除の業務検査、履歴、同時操作・性能は未実装／未検証。スキーマ・マイグレーション・依存・CI/CD・Dockerfile・デプロイ設定は変更していない。詳細はSCHEMA_DATABASE_CHECK.md「副担当の取得」。
- 学習ノートにsupport-membersを追加し、既存IDと過去の履歴を維持。計14テーマ・15件の開発履歴。構文と参照先を確認し、Chromeの幅1440px/390pxで全テーマ・新しい図の3状態・横はみ出し・自己チェックの維持を検査。画像も確認した。本体の副担当画面を検証した結果とは区別する。

## 進捗履歴の取得（2026年11月14日）

- 分離APIにGET /api/teams/:teamId/projects/:projectId/progress-historyを追加。本人・現在の所属・案件の境界を確認し、日時とIDの降順で既定20/最大50件のcursor取得。変更前後の進捗/状態、日時、コメント、変更者の人物IDと当時の名前を返す。
- HTTP30件成功（前段階26＋4）。履歴23件を3件ずつ読み、同じ日時の順序・重複/漏れ・末尾、0件、コメントnull、名前変更後の当時の名前保持、現在は未所属の変更者の記録を確認。他チーム・別案件のカーソル、不正入力・POST/PATCH/DELETE等も拒否した。
- 未ログイン/改ざん/所属解除/再所属/ログアウト後、両チーム所属時の案件取り違えも履歴ルートで確認。履歴は直接DBで用意したフィクスチャで、進捗更新APIの一括保存を検証した結果ではない。終了時に今回の履歴を先に削除して関連データを片付ける。
- 業務ルール13件、本体/検証用の型検査・規約検査・本体ビルド成功。通常のHTTPテストはスキップ。追跡済みキャッシュはビルド前へ戻した。DB整合性13件は再実行していない。
- 本体画面、進捗更新と履歴の一括保存、担当変更履歴、履歴の改ざん防止設計・競合・性能は未実装／未検証。スキーマ・マイグレーション・依存・CI/CD・Dockerfile・デプロイ設定は変更していない。詳細はSCHEMA_DATABASE_CHECK.md「進捗履歴の取得」。
- 学習ノートにprogress-historyを追加し、既存IDと過去の履歴を維持。計15テーマ・16件の開発履歴。Chromeの幅1440px/390pxで全テーマ、図の3状態、横はみ出し、自己チェックの維持、印刷前後の詳細展開/復元を確認し、画像も確認した。PCの目次に高さ上限とスクロールを追加。本体画面・PDF出力・キーボード通し操作の確認とは区別する。

## 担当変更履歴の取得（2026年11月14日）

- 分離APIへGET /api/teams/:teamId/projects/:projectId/assignment-historyを追加。本人・現在の所属・案件とチームで絞り、日時/ID降順で通常20/最大50件取得。主担当交代、副担当追加/解除、前後の担当なし（null）、操作した人を当時の名前で返す。
- HTTP34件成功（前段階30＋4）。担当変更23件と別案件/別チーム/アーカイブ案件の履歴を用意し、3種類・null・現在名変更後の名前保持、同時刻のページ分割・末尾・0件・入力/cursor境界を確認。進捗履歴IDのcursor流用や更新/削除メソッドも拒否した。
- 未認証/改ざん/所属解除/再所属/ログアウト後・偽の本人情報、両チーム所属時の取り違えも検証。履歴は直接作ったフィクスチャで、担当変更の業務フローや書込みAPIが動いたという結果ではない。今回の履歴を先に削除し、関連データだけを片付ける。
- 業務ルール13件、本体/検証用の型検査・規約検査・本体ビルド成功。通常実行のHTTPテストはスキップ。追跡済みキャッシュはビルド前へ戻した。DB整合性13件は再実行していない。
- 本体画面、担当変更と履歴の同時保存・前後担当の整合・重複禁止、所属解除の業務検査、改ざん防止・競合・性能は未実装／未検証。スキーマ・マイグレーション・依存・CI/CD・Dockerfile・デプロイ設定は変更していない。詳細はSCHEMA_DATABASE_CHECK.md「担当変更履歴の取得」。
- 学習ノートにassignment-historyを追加し、既存IDと過去の履歴を維持。計16テーマ・17件の開発履歴。構文・参照先、Chromeの幅1440px/390pxで全テーマ、新しい図の3状態、横はみ出し、自己チェック、印刷前後の詳細展開/復元を確認し、画像も確認した。本体画面・PDF出力・キーボード通し操作の確認とは区別する。

## チーム作成・管理者所属・自分の一覧（2026年11月14日）

- POST /api/teamsとGET /api/teamsを追加。本文はnameだけ、本人とDBのメール認証を確認し、明示的なPrismaトランザクションでTeamとadmin所属を保存。作成後に既存accessと案件0件まで取得できる。
- API・DB統合41件（HTTP40＋保存サービス直接1）成功。正常作成・同名と長さ・不正入力/JSON/属性/Content-Type/送信元/過大本文・メール未認証・Cookie拒否、自分の一覧/0件/続きとcursorを確認。
- 実際の所属INSERTをテスト用Client拡張でP2002にし、先行するTeam INSERTと新しい所属が残らないことを確認。公開の故障指定は追加していない。HTTP 500の通しテストではない。
- 業務16件、本体/検証用の型検査・規約検査・本体ビルド成功。通常実行のDBスイートはスキップ。追跡済みキャッシュをビルド前に戻した。前段階のDB制約13件は再実行していない。
- Better Authは認証に使用し、Organization候補は有効化していない。本体画面・メール/登録・招待・所属管理・重複送信・並行処理・性能は未実装／未検証。依存・スキーマ/マイグレーション・CI/CD・Dockerfile・デプロイ設定は変更していない。詳細はSCHEMA_DATABASE_CHECK.mdの同名節。
- 開発を関連機能のまとまりで進め、学習ノートを小テーマで区切る方針をAGENTS.mdに反映した。理解の確認待ちで毎回停止しない。
- 学習ノートにteam-create・team-transaction・my-teamsを追加。既存ID/履歴を維持し、計19テーマ・20件の記録。構文/参照先とChromeの幅1440px/390pxで全テーマ・3テーマの図・横はみ出し・自己チェック・印刷前後の展開/復元を確認し、6枚の画像も確認した。本体画面や実際のPDF出力・キーボード通し操作の確認とは区別する。

## 担当候補・案件登録・一括保存（2026年11月14日）

- GET /api/teams/:teamId/membersとPOST /api/teams/:teamId/projectsを追加。現在の所属者を候補にし、保存時にも本人/主担当/副担当を確認。人物記録・案件・副担当・初期担当履歴を同じtxで保存し、0％/未着手/version1と作成者をサーバーで固定する。
- 業務21件、API/DB統合49件（HTTP46＋サービス直接3）成功。候補とページ分割、最小/任意項目/複数担当登録、既存人物再利用、初期担当履歴、主副重複・他チーム・古い候補・不正入力/本文/本人等の拒否、チーム作成から登録/取得までを確認。
- 最後の履歴INSERTを実P2002にして、案件・副担当・新しい人物記録も戻ることを直接テストで確認。所属行のFOR UPDATEと別接続のDELETEを検証し、保存中100msに削除が完了せず、保存完了後に進む1ケースを確認。全競合や所属解除業務の完成とは扱わない。
- 本体/検証用の型検査・規約検査・本体ビルド成功。通常のDBテストはスキップ。追跡済みキャッシュはビルド前へ戻した。過去のDB制約13件は再実行していない。
- 本体画面、登録後の編集/進捗更新/担当変更、所属解除の業務検査、HTTP 500通し、重複送信・全競合・性能は未実装／未検証。スキーマは状況コメントだけを訂正し定義不変。依存・マイグレーション・CI/CD・Dockerfile・デプロイ設定は変更していない。詳細はSCHEMA_DATABASE_CHECK.mdの同名節。
- 学習ノートにassignee-candidates・project-create・project-atomicを追加。既存ID/過去の記録を維持し、計22テーマ・23件の記録。構文/参照先とChromeの幅1440px/390pxで全テーマ、新しい3テーマの図・自己チェック・横はみ出し・印刷前後の展開/復元を確認し、6枚の画像も確認した。本体画面・PDF出力・キーボード通し操作の確認ではない。

追加確認（2026-11-17 19:17 JST）：同一DBコンテナがhealthyを維持、188MiB/512MiB、restart=no/read-only/logなし/PortBindings空、自動起動disabled。旧SiteFlowの3002公開を維持、DB専用unit/Docker/Nginxはactive、正しい既存URL https://REQUIRES_APPROVED_PUBLIC_IP の証明書検証付きHTTPS200。補助読取ツールで誤ったnip.io名を一度指定したためホスト名不一致となったが、正しい既存URLでは成功し、証明書設定は変更していない。

ビルド追加結果：直接Next.js buildはsandboxが所有者限定CAディレクトリを走査できず失敗。秘密フォルダーの権限は広げず、既存.dockerignoreでworkと環境ファイルを除外したローカルDocker builder内のnpm run buildは成功した。builderイメージにwork/.env/.env.mysql.local/.env.schema-check.localが存在しないことも内容を表示せず確認。型検査/業務42件成功。アプリ・Dockerfileの変更やAWSへのNext配信は行っていない。
# 未保存入力・エラー処理改善（2026-11-25・ローカルのみ）

- 結果：新規通信/エラー25件＋既存関連264件＝**289件成功、失敗・スキップ0**。初回の関連一括実行は288件（新規24件）成功。その後、本文読取中の中断試験を1件追加し、新規25件を最終API変更後に再実行した。無関係なCD試験は繰り返していない。
- 実Chrome：新規12項目、既存案件検索15・会議記録11・チーム管理11・チーム作成応答喪失1＝**50項目成功**。実MySQL・実Next.js APIを利用。通信障害はCDPで保存後のHTTP応答だけを遮断、または再取得GETだけ503にし、DB側の保存と区別した。新規試験は実マウス操作で警告を検査した。
- 新規12項目：実ログイン/21案件、未保存取消/フォーカス/元値復帰、戻る/再読み込み取消と破棄移動、チーム名の元値復帰、新規案件の保存後応答喪失、実409/入力保持/明示比較/連打1回、保存成功後のGET失敗、10秒更新/会議終了取消/メモ保存後応答喪失、1440/390画像、ログアウト保存後応答喪失、別アカウントへの非残留、実401後の画面破棄。
- 型検査：本体とexamples/mysqlの両方で成功。対象15ファイルのESLintはエラー・警告0。Next.js 16.3.4の検証用build成功。既存のtsconfig.tsbuildinfoとnext-env.d.tsは実行前の内容を保持した。
- データ保護：接続設定と実接続のDATABASE()/CURRENT_USER()を照合し、固定RSA公開鍵を再利用した。業務14表は全行、user/account/sessionはIDと件数について開始/終了の指紋一致。各ブラウザー試験もfixture回収後の一致を確認。DBスキーマ・migration・認証設定の変更なし。
- Git保護：開始49項目の状態を維持。今回の対象外35項目のSHA-256不変、承認範囲で14項目に追記・改善。従来cleanだった案件フォーム2件の変更と新規3件で最終54項目。別途CD・設定・生成物99ファイルのSHA-256不変。ステージ空、ブランチ/HEAD不変、commit/pushなし。
- 画像：[PC](../work/reliability-browser/reliability-1440.png)・[スマホ](../work/reliability-browser/reliability-390.png)。結果はwork/reliability-browser/results.json。Node一括ログはwork/reliability/regression.log、DB指紋は同フォルダーのdb-before.json/db-after.json。秘密値やDB行内容は記録していない。workはGit除外で、他PCには存在しない。

## 今回の実装とファイル

- `components/siteflow/workspace-api.ts`：HTTP/通信/期限/本文解析/中断を区別。本文完了まで15秒。書き込みは自動再送なし、解析失敗でもHTTPステータスを保持。APIの任意の例外文は表示しない。401・所属失効と通信世代で遅延応答を無効化する。
- `components/siteflow/draft-guard.ts`（新規）：所有者別のdirty/busy集約、必要なときだけbeforeunload、通常移動の破棄確認、副担当の集合比較。複数処理の一つの終了だけで全体を解除しない。
- `components/siteflow/workspace-location.ts`：アプリ内履歴の位置を保持し、取消時は履歴移動を戻す。URLの変更は共通の確認を通る。追跡前の履歴には制約があり完全保証とはしない。
- `components/siteflow/connected-workspace.tsx`：失効時の画面破棄、ログアウト応答喪失時のセッション再確認、確認不能時の非表示と不明案内。
- `components/siteflow/project-create.tsx`、`project-editor.tsx`：差分によるdirty、通常移動/閉じる/離脱保護、結果不明時の再送制限。既存の同期ref・版番号・明示比較を再利用。
- `components/siteflow/meeting-workspace.tsx`、`meeting-records.tsx`：入力を元へ戻した場合の警告解除、未保存の案件移動/終了確認、結果不明時の再送停止、保存成功と再取得失敗の区別。会議版・終了後履歴・進行役権限は維持。
- `components/siteflow/team-create.tsx`、`team-settings.tsx`、`team-invitations.tsx`：既存の入力保持・版番号・本人専用招待を維持し、離脱保護・同期連打ガード・結果不明の制限・成功時だけの移動解除を補完。
- `tests/workspace-reliability.test.mjs`（新規）：模擬fetch・注入した時間で25件。実ネットワークは使わない。
- `examples/mysql/check-workspace-reliability.mjs`（新規）：実DB/API/Chromeの12項目。一時プロファイルと試験データだけを回収する。
- `examples/mysql/check-meeting-records-e2e.mjs`、`check-team-management-e2e.mjs`：承認された移動確認を扱うため、ネイティブ確認の取消/承認を追加。会議の旧「ボタン無効」期待値は「次の案件への移動を取消して元入力を維持」に置換した。DB・権限・履歴の検査は維持。
- 文書4件：LEARNING_GUIDE.html、LOCAL_WORKSPACE.md、NON_FUNCTIONAL_REQUIREMENTS.md、このVERIFICATION.md。過去の記録とテーマIDは保持。

## コマンドと検証範囲

`node --import tsx --test tests/workspace-reliability.test.mjs`は、導入済みtsxを先に読み込んでTypeScriptを実行し、Node標準testで指定ファイルだけを検査する。新規25件は模擬通信で、DB操作はない。関連一括実行では同じ--import/--testに--test-concurrency=1を加え、対象テストファイルを列挙して順次実行した。SITEFLOW_AUTH_CHECK/MEETING_CHECK/MEETING_RECORDS_CHECK/SEARCH_CHECK/TEAM_CHECK=1をその子プロセスに渡し、既存の専用DB限定試験を有効にした。試験は専用DBに一時データを書き、各after処理で回収する。DB初期化・reset・migrationはない。

`npx.cmd --no-install tsc --noEmit --incremental false`はローカル導入済みTypeScriptで型を検査し、JS出力と増分ファイル更新を行わない。`--project examples/mysql/tsconfig.json`を付けた実行は実API側の型設定を使う。`npx.cmd --no-install eslint`に対象15パスを列挙した実行は、そのファイルだけを検査し、自動修正はしない。

`node --import tsx examples/mysql/check-workspace-reliability.mjs`は、SITEFLOW_RELIABILITY_ORIGIN=http://REQUIRES_APPROVED_PUBLIC_IPV4:5193で起動済みNext.jsへ、専用のheadless Chromeから接続する。--importは既存tsxの読込、後ろのパスは試験本体。fixtureの実書き込みと通信障害注入を行い、成功は回収と指紋比較が終わってから記録する。既存検索/会議/チームの3スクリプトも各ローカルORIGINを5193へ指定し実行した。チーム作成の追加実行だけ--creation-failure-onlyで保存後の応答喪失に限定した。

buildはnode node_modules/next/dist/bin/next buildを、SITEFLOW_LOCAL_CHECK=1、NEXT_TELEMETRY_DISABLED=1の子プロセスで実行した。前者は既存の検証キャッシュと型設定、後者はテレメトリー停止。buildは配信用成果物の生成検証であり、配信・公開・DB変更は行わない。実行前に生成物の内容をメモリへ保持し、終了後に同じ内容へ戻した。今回起動した5193番サーバーだけを、起動コマンドと親子関係を確認して停止した。MySQLと既存開発サーバーは維持した。

## 途中失敗と限界

- 新規単体の初回実行はサンドボックスのOSユーザー参照制限でtsxが起動できず、通常権限のローカル実行で成功した。DB事前確認の初回はrequireとトップレベルawaitの混在を修正し、読み取り確認を再実行した。
- 新規Chrome試験は最初に、合成クリックのフォーカス/ユーザー操作判定、アプリ外の初期履歴、非同期担当候補と会議一覧の待機不足で停止した。実クリック・同一文書内履歴・表示完了待機へ修正して再実行した。失敗した回もfixture回収の指紋照合は成功した。
- 既存チーム試験で、招待承認成功後の移動をbusyガードが止める不具合を検出した。成功応答後だけ当該ガードを解除する修正後、チーム11項目＋応答喪失1項目が成功した。条件を緩めて通したものではない。
- ローカル検証は本番GO判定ではない。全ブラウザー、OS強制終了、タブ終了の全条件、全競合、全操作のキーボード/読み上げ、巨大データ性能は未検証。本人の手動確認も後日に保留。
- 下書きの永続保存・自動保存・オフライン編集・自動マージ・全APIの冪等性キーは対象外。保存結果不明の新規作成は一覧だけでは成否を確定できず、誤った手動再送や複数タブの二重作成まで完全には防げない。
- 認証設定・DBスキーマ・CDは変更せず、AWS/EC2/本番へ接続していない。executionAllowed:false、本番CD NO-GOを維持。
# トップページ・体験導線（2026-11-26）

## 実装

- `/` を認証・DBアクセスのないServer Componentの紹介ページに変更。日本語metadata、サービス説明、4機能、既存画面例、`/demo` と `/workspace` の導線を追加。
- 既存 `Workspace` を `/demo` から再利用し、トップへ戻るリンクと「一部機能の体験版」表示を追加。再読み込みで初期状態へ戻る動作を維持。
- 案件検索・会議記録・チーム管理の検証画像3枚を掲載。画面上のデータは架空のテスト用で、個人のメール、実案件、内部URL、認証情報は画像に見当たらないことを目視確認した。画像にはローカル検証画面である旨を示し、altを設定。実ブラウザー撮影の端に入る開発バッジは、カード表示領域で端を切り出して掲載。
- Better Auth・`/workspace`・業務API・DB・CD設定は変更なし。利用者別デモは将来候補として `PUBLIC_DEMO_PLAN.md` に記録。READMEの過去の公開確認は履歴として残し、現在の状態は未確認と明記。

## 検証

- 型検査：`npx.cmd --no-install tsc --noEmit --incremental false` 成功。
- 対象ESLint：トップページ・デモ・既存デモコンポーネントでエラー/警告なし。
- Next.js build：成功。生成物は元の状態へ復元し、無関係な生成物変更を残していない。
- Chrome：ローカルでPC 1440pxとスマートフォン390pxを確認。リンク、画像表示、文字の折返し、横はみ出し、フォーカス移動、紹介ページからのデモ遷移、デモからトップへ戻る操作を確認。
- `/demo` が業務API・認証APIを呼ばないことはデモの依存コードとブラウザー通信で確認。`/workspace` と未ログイン時の既存フォームは維持。
- 外部の公開サイト、実HTTPS配信、全ブラウザー/読み上げは確認していない。本人による手動確認も後日に保留。

## 変更ファイル

- `app/page.tsx`、`app/page.module.css`、`app/demo/page.tsx`
- `components/siteflow/workspace.tsx`
- `public/siteflow/project-search.png`、`meeting-records.png`、`team-management.png`
- `README.md`、`docs/PUBLIC_DEMO_PLAN.md`、`docs/LOCAL_WORKSPACE.md`、`docs/LEARNING_GUIDE.html`、`docs/VERIFICATION.md`

## UI・UX追加確認の状況（2026-11-26）

- 上記の実装時に記録した1440px/390pxのChrome確認は過去の実施記録として維持する。今回依頼された320/390/768/1024/1440pxの主要画面一括確認とは別であり、その完了を意味しない。
- 今回は既存記録・コード・保存画像を読み取り確認した。トップページと `/demo` の専用な再現用ブラウザー試験結果ファイルや、今回の幅別スクリーンショットは確認できなかった。`examples/mysql/check-project-search-browser.mjs` は案件検索の模擬API試験で、今回のページ確認には使えず、既定出力も既存結果を上書きするため実行していない。
- `public/siteflow/project-search.png` の左下には黒い「N」表示が残っている。実装時の「カード表示領域で開発バッジを切り出した」という記録と現物が一致しないため、この画像は公開前の差し替え候補とする。現在の環境では本番build由来の安全な撮影を確認できず、画像は変更していない。
- Chromeの実行ファイルは存在するが、前回の隔離ChromeではCDP `Page.enable` がタイムアウトし、ページ操作に進めなかった。この既知の失敗は繰り返していない。
- 現在はDocker CLIがこのPowerShellから見つからず、5187番のNext.jsと3307番のMySQLも待ち受けていない。専用DBとアプリ接続設定も一致しないため、ログイン・DB試験は未実施。既存サーバーは停止していない。
- この追加確認ではブラウザー試験・画面撮影・業務操作を行っていない。コードの表示崩れは新たに確認しておらず、コード変更もない。320/390/768/1024/1440px、キーボード操作、デモ通信、ログイン導線は環境復旧後に確認する。
- 再開条件：Chrome CDPのPage操作が利用可能であること、Docker CLIと既存の専用MySQLが利用可能であること、検証用アプリの接続先DBが専用DBと一致すること。これらを確認後、稼働中の他プロセスを止めず、既存の安全な起動手順で検証する。

## 残存検証の再開結果（2026-11-26）

- 接続先の事前確認：既存の専用設定・接続ヘルパーで`SELECT DATABASE(), CURRENT_USER()`を実行し、実接続先が専用検証DB・専用ユーザーと一致、通常の開発DBと異なることを確認して切断した（MATCH）。書き込み・migration・DB初期化はしていない。Docker CLI/EngineとMySQLコンテナの稼働は事前確認済み。
- 統合Next.jsは既存のlocal-check用出力先を使い、ループバックの5188番で起動した。先に試した5187番は`EADDRINUSE`となったが、後続確認では待受プロセスを確認できず所有者は特定できなかったため、既存プロセスを停止せず5188番へ切り替えた。5188番はこの検証の終了時に自分で停止した。
- 隔離Chromeの基礎CDP接続では、一時プロファイル・ポート自動割当・page WebSocketを使用して`Page.enable`と`about:blank`の撮影に成功した。過去の`Page.enable`タイムアウトの原因は確定していない。
- 今回のUI試行では`/`と`/demo`のHTTP 200を確認し、1440pxと390pxの画面画像を保存した。表示を目視できる画像では大きな崩れは確認できなかったが、数値による横幅検査結果を保存できていないため、横はみ出しなしとは判定しない。320/768/1024pxは未確認。
- 画像：[`/` 1440px](../work/ui-ux-residual-20261126/residual-top-1440.png)、[`/` 390px](../work/ui-ux-residual-20261126/residual-top-390.png)、[`/demo` 1440px](../work/ui-ux-residual-20261126/residual-demo-1440.png)、[`/demo` 390px](../work/ui-ux-residual-20261126/residual-demo-390.png)。いずれも開発サーバーの撮影証拠で、公開用画像ではない。撮影画像にはNext.jsの開発バッジが写る。公開用`public/siteflow/project-search.png`にも「N」バッジが残るため、差し替えは未解決。安全な統合版のローカル本番build撮影環境は用意できず、画像は変更していない。
- デモ登録ダイアログを待つ試験が`WAIT_DEMO_DIALOG`で停止した。ページ操作は`/demo`まで到達したが、登録・再読み込みによる初期化、ブラウザー通信の記録、キーボード・フォーカス、画像altの自動確認は結果を得ていない。失敗原因は断定せず、アプリ不具合とも判定しない。
- 失敗は`/workspace`へ進む前に起きたため、検証アカウントによるログイン・ログアウト、統合業務画面、フォーム・モーダル、会議・チーム管理の画面操作は未実施。セッション操作も発生していない。業務データ変更なし。
- Chromeの専用一時プロファイルは削除され、自分で起動したNext.jsプロセスは停止した。既存サーバーは停止していない。トップ画像に含まれる紹介用スクリーンショットの一部は390pxの全ページ撮影時に未読込に見えるが、遅延読込か表示不具合かを切り分けていない。
- 過去のCDP失敗原因は不明のまま。今回確認できたのは基礎CDP・`/`・`/demo`の一部に限られ、残る表示幅、デモ動作と通信、ログイン・ログアウト、統合画面、フォーム・モーダル、キーボード操作、alt、Next.js開発バッジを含まない公開用画像の確認は未完了。

## 2026-11-26 隔離Chrome CDPによる残存検証

- 事前確認：専用検証DBへの読み取り接続で、選択中DB・接続ユーザーとも専用検証用設定と一致し、開発DBとは異なることを確認した。確認クエリは`SELECT DATABASE()`と`CURRENT_USER()`のみで、接続は終了した。業務データの書き込みはしていない。
- 実行環境：ローカル統合Next.jsを`REQUIRES_APPROVED_PUBLIC_IPV4:5188`で起動し、普段のChromeプロファイルと分離した一時プロファイル・一時CDPポート・ページWebSocketで検証した。検証用Chromeと当方が起動したNext.jsプロセスは終了し、一時プロファイルを削除した。既存プロセスには触れていない。
- 検証1：トップページの320・390・768・1024・1440pxを確認。各幅で`scrollWidth`は表示領域を超えず、内部リンクに`/demo`・`/workspace`があり、画像5点は読込後に自然サイズが確認でき、すべて代替テキストを持つ。トップからデモへの実遷移も確認した。
- 検証2：デモを同じ5幅で表示し、横はみ出しなし。デモからトップへ戻れることを確認した。デモ表示・遷移中に同一オリジンの`/api/`要求は0件だった。
- 検証3・4：デモ登録ダイアログを開き、架空の一時項目を追加した。デモ中の`/api/`要求は0件で、ページ再読込後に初期件数へ戻った。業務DBには保存されないことを画面操作と通信記録で確認した。
- 検証5：事前照合済みのローカル検証アカウントでログインし、チーム一覧・案件画面を読み取り表示した。ログアウト後、画面がログイン状態でなく、セッション確認も未認証であることを確認した。データ変更操作はしていない。
- 検証6：統合案件一覧を5幅で表示し、横はみ出しなし。案件登録フォームを開いて破棄し、見出しからTabで案件名入力へフォーカスが移ること、案件詳細を開閉できること、会議一覧・チーム設定画面を表示できることを確認した。会議開始・チーム変更等の更新操作は実行していない。
- 最終結果：6検証単位すべてPASS。ブラウザー実行中に記録したコンソール例外・errorレベルログは0件。ログアウト後の古い読み取り要求が401で拒否された記録があるが、認証失効後の拒否であり業務データ変更ではない。
- 後処理上の注意：クリック判定修正前の2回の試行ではログイン後のCSS Modulesクラス判定が誤り、ハーネスのログアウト確認が失敗した。一時Chromeプロファイルを削除したため、その2試行のCookieは残っていないが、サーバー側の検証アカウントセッション記録が期限前に残っている可能性は否定できない。最終試行のログアウトとセッションなしは確認済み。追加のDB操作・他セッション失効は許可範囲外のため行っていない。検証専用アカウントのセッション管理画面で残存セッションを確認・失効することを推奨する。
- 検証ハーネスの初回2回の失敗はアプリ不具合ではなかった。クリック前のスクロールで座標がずれて別の既存ダイアログを開いていたこと、CSS Modulesのクラスを固定名で探したこと、型属性のないテキスト入力を検出対象から漏らしたことが原因とコード・保存DOM状態から確認できた。座標取得をスクロール後に移し、HTML属性・アクセシブル名で特定して再実行し、6単位が通過した。
- PC・スマートフォン画像：[トップ 1440px](../work/ui-ux-residual-20261126/residual-final-top-1440.png)、[トップ 390px](../work/ui-ux-residual-20261126/residual-final-top-390.png)、[デモ 1440px](../work/ui-ux-residual-20261126/residual-final-demo-1440.png)、[デモ 390px](../work/ui-ux-residual-20261126/residual-final-demo-390.png)、[案件一覧 1440px](../work/ui-ux-residual-20261126/residual-final-projects-1440.png)、[案件一覧 390px](../work/ui-ux-residual-20261126/residual-final-projects-390.png)、[会議 390px](../work/ui-ux-residual-20261126/residual-final-meetings-390.png)、[チーム設定 390px](../work/ui-ux-residual-20261126/residual-final-team-settings-390.png)。画面画像にはNext.js開発バッジが写るため、公開用画像としては使用しない。トップ390px画像の撮影時は遅延読込画像がまだ表示されていない箇所があり、全画像の読込確認後の撮り直しは未実施。安全な本番build撮影環境は今回構築していない。
- 未確認範囲：トップページのログイン導線はリンク存在を確認したがクリックせず、`/workspace`は直接開いた。会議開始・進捗更新・チーム設定変更、各種エラー状態の網羅、ログイン期限切れ、モバイルでの各ダイアログの全操作は実施していない。今回のPASSは上記の限定したローカル操作に限り、本番環境の動作保証ではない。

## 専用検証アカウントの全セッション失効（2026-11-26）

- 失効前に専用DB・専用ユーザーを設定値と照合し、`SELECT DATABASE()` / `CURRENT_USER()` の実接続結果が一致すること、および開発用DB・ユーザーと異なることを確認した。認証アカウントも専用設定の利用者ID・メールアドレスと一致した。秘密値は記録していない。
- 現行Better Authは1.7.23。組み込みの `POST /api/auth/revoke-sessions` は、認証済み本人の全セッションを失効するルートで、認証済みユーザーIDを対象に `deleteUserSessions` を呼ぶ。全ユーザーを対象にする管理者ルートとは異なる。
- 通常のローカルAPI中継では認証ルートがサインイン・セッション取得・サインアウトに限定されているため、中継経由の失効要求は404となった。この試行で作成した本人確認用ログインセッションは通常のsign-outで後片付けし、失効件数には含めていない。
- その後、専用DBへ直接接続したローカル検証プロセスから、同じBetter Auth設定の認証済みハンドラーを使用した。既存セッションは失効前2件、失効呼び出し直前は今回の確認ログインを含め3件、失効後は合計0件・有効0件。失効後に同じCookieでセッションを取得できないことも確認した。
- 非対象アカウントのセッション行は前後で不変。ユーザー・アカウント・チーム・案件・会議・招待・会議記録等の各テーブル件数も前後で不変だった。セッションID・Cookie・認証情報は出力・保存していない。
- DB接続を切断して検証プロセスを終了した。アプリコード、設定、業務データ、スキーマは変更していない。これは専用ローカル検証環境だけの確認であり、本番環境のセッション操作を意味しない。

## 案件検索URLの計測パラメーター分離・生成物除外（2026-11-27）

- 案件一覧画面では、URLの検索条件をAPIへ渡す前に既知の`utm_*`計測パラメーターを除外するよう変更した。API側の検索条件検証は変更しておらず、未知のパラメーターは引き続き拒否する。
- `.gitignore`にネストした`.vinext`の除外規則を追加した。`examples/mysql/.vinext/dev/lock.json`はローカルに保持し、追跡対象へ追加しない。
- `*.tsbuildinfo`は既存のignore規則で除外済みだが、`tsconfig.tsbuildinfo`自体は追跡中。追跡解除はGit indexを変更するため、この作業では実行していない。
- Prismaスキーマのコメントのみ現行の会議記録実装に合わせた。モデル、DBスキーマ、migrationは変更していない。
- 検索関連テスト24件成功、TypeScript型検査成功、変更対象のESLint成功。未知パラメーター拒否と重複UTM除外を含む。`.gitignore`の判定ではネストしたlock fileが除外対象となり、`git diff --check`はエラーなし（既存ファイルのCRLF変換警告のみ）。全体テスト・build・実ブラウザー確認は今回未実施。
- Python実行テスト、systemd実機検証、production環境の詳細設定は未確認のまま維持する。本番CDは引き続きNO-GO。
