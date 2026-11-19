# 承認付きCD・GitHub反映前監査

## 最終確認：検証ブランチへのcommit・push準備はGO（2026-11-19）

**GO対象は許可リスト190件を専用ブランチへcommit・pushする準備。実行許可ではない。** 推奨ブランチ名は`feat/nextjs-mysql-approved-cd`（作成前に未使用を確認し、既存branchを上書きしない）。その後、別途承認したmain向けPRでCIを確認する。mainの直接pushは保護ルールに反するためNO-GO。mainマージ・本番CD・公開切替は今回の対象外で、まだ実行しない。

### 最終確認の根拠

| 項目 | 2026-11-19の確認 |
| --- | --- |
| Git | main、stage0件、未送信commit0件。実GitHub mainもae3e31a78da037d0f855e9143ea5cce5e0a6cfe3でローカルHEADと一致 |
| 差分 | 変更20＋新規174＝194件。許可リスト候補190件・個別除外4件を確定。個別一覧は末尾と今回追加表を参照 |
| 秘密情報・生成物 | 既知の秘密鍵/token/AWS ID形式、ローカル.env秘密値との一致0件。候補にwork/node_modules/generated/.next/.vinext/.env/鍵/log/キャッシュ/archiveなし。画像6枚の直前目視と内容不変の結果も再利用 |
| 容量 | 記録前の候補合計3,806,123bytes（約3.8MB）、最大package-lock.json 581,183bytes。5MiB超0件。以後は文書追記分だけ増える |
| main保護 | active ruleset 25826993。PR必須、docker-build成功必須、最新baseへの追随必須、削除/非fast-forward禁止、bypass0件。変更していない |
| production | Chrome設定ページを再読込しfalseを確認。承認者syucream02、自己承認可、管理者迂回不可、main1本/tags0、secretなし |
| EC2 CD | 21:17 JST読取。旧timer disabled/inactive、旧service static/inactive。新timer/service/script/stateは未導入。関連cron0件 |
| 既存公開 | Vinext3002・Next候補3001・MySQLがrunning、OOMなし。Nginx activeで旧3002へ転送。MySQL healthy/SELECT1成功、候補ready200/ok:true、正式DB接続2件、平文secret Envなし |
| HTTPS | EC2/PC外部GETとも200、PCのTLS検証成功。配信とEC2証明書の指紋一致、有効期限2026-11-25 03:18:43 JST。Certbot timer active/enabled。更新・reloadはしていない |
| 調査の無変更性 | 前後のNginx hash・3コンテナID/起動時刻が一致。サービス操作・DB書込・配信なし |
| ローカル検証 | 最新ソースhashがLinux103件/追加image3件成功時と一致。今回workflow/false CLI等8項目を再確認。型/lint/業務42/buildの直前成功を再利用し、無関係な反復テストなし |

EC2リソース読取はMemAvailable875MiB、root空き8.2GiB、暗号化DB EBS空き9.7GiB。これは確認時点の余力で、将来の新旧同時起動やEC2上のbuildを承認する結果ではない。

### 送信するファイルの確定方法

対象190件の内訳はroot/config13・app5・components8・lib13・db7・deploy34・examples45・scripts5・tests19・docs41。以下の4件は追加しない。

- `.agents/skills/web-development-learning/SKILL.md`
- `AGENTS.md`
- `tsconfig.tsbuildinfo`
- `examples/mysql/.vinext/dev/lock.json`

`.openai/hosting.json`は変更のない既追跡ファイルで今回のcommit差分に含めない。ignore指定済みでも追跡中のものを自動除外できるわけではない。許可後も一括`git add .`を使わず、今回の許可リストをliteral pathとして明示追加し、cached diffのファイル集合が190件だけか再照合する。`[...path]`を含むpathはglobとして解釈させない。削除・追跡解除・履歴修正・強制pushは含めない。

### push後の自動処理と確認

1. 専用branchの作成・commit・pushを承認後に行う。commit案は「Prepare Next.js MySQL app and approval-gated CD」。GitHubの専用branchでcommit SHA/190件を確認し、mainのSHAと公開先は変わっていないことを確認する。
2. **専用branchのpushだけでは、このci.ymlは起動しない。** 現在のpush triggerはmainだけ。Actions runがなくても正常。GitHub上のworkflowもci.ymlの1件だけと確認した。
3. **main向けPRの作成はCIを自動起動する。** PR作成・CI実行も別途明示承認してから行う。アプリbuild、Compose設定検査、image/許可のunit、Linux配信103件、migration image build、業務テスト、runner内localhost HTTP smokeを行う。PRなのでGHCR pushはしない。release-approvedはskipし、production承認やEC2接続は発生しない。
4. CIでdocker-build成功・対象SHA一致・main未変更・production job skip・公開HTTPS/EC2停止状態の維持を確認。実GitHubでの成功はこれから測定する結果で、ローカル成功を代用しない。
5. mainマージは別承認。mainへ反映すると同じCIに成功後、GHCRへアプリとmigrationのSHAタグを保存し、digest/revisionを照合。その後productionの本人承認待ちになる。falseでもbuild/GHCR保存は実行される。
6. falseのままproduction jobを実行する場合も別承認。承認後はgate disabled、record/upload skip、新artifactなしが期待結果。EC2は新CD未導入・旧CD停止なので配信されない。新CDを将来導入した場合も現在値falseを拒否するローカル検証済み。trueへ変更しない。

### 失敗時の対応と残る未検証

- branch pushが認証・保護・secret protectionで拒否されたら停止する。強制push、main保護緩和、secret protectionのbypass、無断token権限追加はしない。
- PR CI失敗時はmainへmergeしない。失敗stepを調査し、ローカル修正/再検証後の追加pushも承認範囲を確認する。実行されるDocker操作はGitHub runner内だけで、本番をrollbackする必要はない。
- 将来main CIのimage送信途中で失敗してGHCRに片方が残っても、成功run/承認artifactがないため配信しない。mainの履歴をreset/force-pushで戻さず、必要なら別承認の修正commit/revertで対処。既存Vinextを維持する。
- **EC2専用GitHub API実tokenは未配置・権限試験未実施。** 今回のGitHub接続ツールの読取認証と、将来EC2に置くContents/Actions/Environments read tokenの試験は別。自動CDのGOには実token/API応答形式・期限・保管の検証が必要。
- 実proxy統合、起動復帰・再起動試験、DB互換のNext復旧版、公開経路変更、正式DB smokeは未完了。VinextはMySQL案件データを操作する互換版ではない。これらはcommit/pushのGOと切り離し、本番公開NO-GOを継続する。
- 判断は観測時点のもの。承認から実行まで時間が空く、remote main/設定/対象ファイルが変わる場合は関連箇所を再確認する。

証跡：`work/github-push-audit-20261119.json`、`work/approved-push-files-20261119.txt`、`work/prepush-github-readonly-20261119.json`、`work/s3-prepush-readonly-20261119-result.json`、`work/prepush-external-https-20261119.json`。今回はstage/commit/push/PR作成/Actions実行/本番設定変更はしていない。

---

以下は経過記録。最新の判定と対象範囲は上記。

最新追記（2026-11-19）：以下の「false失効不足」は修正前の監査記録。本人承認を受け、ローカルで現在値の再照会・期限・1回の試行への限定を補強し、Linux103件と追加image3件が成功した。最新仕様/結果は[承認付きCD準備](APPROVED_CD_SETUP.md)を参照。新しい`deploy/check-release-permission.sh`1件が増え、最新差分は194件、候補190件・除外4件。再秘密点検も該当0件。以前の193件の一覧は当時のsnapshotとして残す。実API/token/EC2/CD/公開の検証と反映承認は別の条件で、今回はpushしていない。

| 前回一覧への追加 | 区分 | 用途 |
| --- | --- | --- |
| `deploy/check-release-permission.sh` | 条件付き送信候補 | 現在のproduction変数を読み、HTTP200/文字列true/更新時刻を検証する |

確認日：2026-11-19 JST。Gitの読み取り、ソース照合、ローカルCLI試験、通信を遮断したDocker内の代役試験のみ。commit・stage・push・fetch・Actions実行・GitHub設定変更・EC2接続/配信・正式DB変更・公開切替は行っていない。

**判定：現状のままCD有効化・本番配信はNO-GO。pushも今回は実行せず保留。** ActionsからEC2への接続処理はないが、`false`が過去の承認artifactを失効させないことを追加試験で確認した。ローカル修正を勝手に加えず、提案として残す。

## 1. Git差分・送信範囲

作業ブランチはmain。ステージ0件、ローカルに記録されているupstreamとの差分コミット0件。remoteをfetchしていないため、実GitHubの最新状態と同じとは断定しない。pushは作業フォルダーのファイルを直接送るのではなく、承認して作成したコミットを送る操作。今は送信する新コミット自体がない。

監査開始時は変更20件＋未追跡172件＝192件。そのうち4件を除外し、既存の送信候補は188件。本監査文書を加えると候補189件となる。CDだけでなくNext.js・認証・Prisma/MySQL・会議機能・文書を含む大きな差分で、workflowだけを送ると必要な未追跡ソースが欠落する。末尾に個別一覧を置く。候補は内容/依存関係の確認対象であり、pushの許可ではない。

### 除外する変更

| ファイル | 理由 |
| --- | --- |
| `.agents/skills/web-development-learning/SKILL.md` | ローカルのエージェント設定。既に追跡されているためignoreだけでは除けない |
| `AGENTS.md` | ローカル開発指示。今回は送信対象に含めない。既に追跡中 |
| `tsconfig.tsbuildinfo` | 生成キャッシュ。既に追跡中 |
| `examples/mysql/.vinext/dev/lock.json` | 過去のローカルPID・port・絶対pathを持つ生成lock。未追跡のまま除外する |

別途、変更のない`.openai/hosting.json`もignore指定済みだが追跡中。今回の新規差分にはない。これらの追跡解除や過去履歴の扱いは別にレビューする。`git add .`/`git add -A`は使わず、承認した一覧を明示的に追加し、cached diffを再確認する。今回はindexも変更していない。

秘密情報点検：候補テキストを秘密鍵・age秘密鍵・GitHub token・AWS access ID形式、およびローカル.env内の秘密値との一致で検査し、該当0件。値は出力していない。docs/imagesの6枚も目視し、架空案件のアプリ画面で、ブラウザーの認証情報は写っていないことを確認。これは全履歴や任意の埋込秘密の完全検査ではない。`.env`・鍵・work・node_modules・生成Prisma Clientは候補外。migration.sqlは秘密のDBダンプではなくschema履歴なので送信に必要。

## 2. workflowの起動とfalseの作用範囲

| 条件 | CI / GHCR | production job |
| --- | --- | --- |
| main宛てPR | build・domain test・配信制御試験・HTTP smoke。GHCR送信なし | jobごとskip |
| main push | 同じ検査に成功してからアプリ/migrationをSHAタグでGHCR保存 | CI成功後に本人承認待ち。falseでも承認待ちは発生し得る |
| 別ブランチpushだけ | このworkflowは起動しない | 起動しない |
| production承認後、変数false/未設定 | GHCR保存は既に済んでいる場合がある | `enabled=false`、record生成とartifact uploadをskip |
| production承認後、変数true | CI成功版のみ | 2イメージdigest・SHA・run・attempt・schemaHashのartifactを作る。EC2配信命令はない |

判定箇所：`.github/workflows/ci.yml`の`release-approved`→`Check release permission switch`→`deploy/release-record.mjs --check-gate`→`releaseEnabled`。文字列trueだけ有効、false/空/未設定は無効、TRUE等の誤記は拒否。record/uploadの両方に`steps.release-switch.outputs.enabled == 'true'`があり、直接record CLIを呼んでもfalseなら拒否する。

production画面は直前に本人が作成し、再読込でsyucream02のみ・自己承認許可・管理者迂回禁止・mainのみ・falseを確認済み。今回の監査では設定を変更していない。

## 3. falseだけでは満たせない条件（重要）

**ActionsからのEC2接続・配信は、false/trueのどちらにも実装されていない。** ActionsはGitHub/GHCR内のbuild・保存・承認記録作成まで。SSH鍵、AWS資格情報、EC2 socket/hostの指定や配信script呼出しはない。

ただし、EC2へ将来導入する`deploy/cd-check.sh`はGitHub変数の現在値を取得しない。最新mainに対応した過去の成功runと本人承認artifactが残り、EC2側enabled・pausedなしなら、その後GitHub変数をfalseへ戻してもartifactが選ばれる可能性がある。

追加のローカル再現では、過去にtrueで承認されたartifactを代役APIに用意し、実行環境の変数をfalseとして実CD scriptを通した。新規recordは作らず、既存artifactから代役公開枠がgreen→blueになった。**これは不足を再現する試験が成功したのであって、要件を満たした成功ではない。** GitHub環境変数へのAPI照会自体がないこともソースで確認。証跡は`work/prior-artifact-audit-20261119.log`。実サービスはすべて代役、network none、host mountなし。

推奨修正（未実装）：EC2側でproductionの`SITEFLOW_RELEASE_ENABLED`を読取り、true以外・欠損・403・通信失敗は停止。処理開始時とrelease呼出し直前に再確認する。falseへ戻した既存artifact・API失敗・途中false化を追加テストする。配信中の停止は別にpaused/lockと進行状態を使う。GitHub変数だけで既に進行中の処理を即時中断できるとは説明しない。

当面の安全策は**EC2側CDを未導入/停止・paused維持**。前回EC2監査では旧CD disabled/inactive、新CD未配置だったが、今回はEC2へ接続していないので現在の状態は再確認していない。将来のpush前に読み取りで確認する必要がある。現在のmainには新しい承認artifactのworkflowをまだ送っていないため、この再現は今ただちに配信事故が起きたという報告ではない。

## 4. 権限・秘密情報

| 対象 | 必要な権限・参照 |
| --- | --- |
| workflow全体 | contents:read |
| docker-build | contents:read + packages:write。main pushのdocker/login-actionだけsecrets.GITHUB_TOKENを参照 |
| release-approved | contents:read。productionの非秘密変数を読む。新しいDB/SSH/AWS secretは不要 |
| GitHubへworkflowを含むcommitを送る本人 | repositoryへの書込権限とbranch保護への適合。利用認証によりworkflow変更権限も必要。tokenの新規作成・権限拡大は今回しない |
| 将来のEC2読取token | 対象repository限定のContents/Actions読取。提案した環境変数再照会にはEnvironments読取。書込・Administrationは配信実行に不要 |

必要権限はGitHub公式の[環境変数読取](https://docs.github.com/en/rest/actions/variables#get-an-environment-variable)、[承認履歴読取](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run)、[環境読取](https://docs.github.com/en/rest/deployments/environments#get-an-environment)と照合（2026-11-19）。実tokenによるAPI取得は未検証。classic tokenへ広いrepo/admin権限を無断追加しない。GHCR private packageを読む資格情報はEC2側で別管理し、非暗号化rootへ保存しない。

GitHub UIのproductionにはsecretなし。アプリの秘密はEC2暗号化EBSから起動時にfile参照する。Docker buildへ渡さない。CI smokeはDB接続モードを有効にせず、localhostの指摘デモを確認する。CI failureログに実DB秘密を持ち込まない。

## 5. digest・revision・CI依存

- アプリとmigrationを同じ`GITHUB_SHA`のOCI revisionラベル付きでbuild。GHCRへ別のSHAタグで保存する。
- `deploy/image-record.mjs`はrepositoryの正確なRepoDigestとrevisionを2イメージ分照合。複数の曖昧なdigest、別repo、タグだけ、revision違いを拒否。
- recordは2つのdigest、SHA、run ID/attempt、schemaHashを保持。EC2は最新main/run・本人approval・production保護・job成功・同run/attemptのartifactを照合する。
- `release.sh`はアプリをdigest指定でpullしrevision一致を確認。migrationは承認digestとschema receiptの一致、および同digestのimage revisionを確認。receiptのDB名/host/CA/schemaHashも照合する。正式DBへのmigration自体は自動CDに含めない。
- `release-approved`は`needs: docker-build`。`always()`やcontinue-on-errorによる失敗迂回なし。テスト/smoke失敗時はpublishに進まず、承認jobも進まない。2つ目のimage push等で失敗してGHCRに片方が残っても、成功run/artifactがないので配信対象にしない。
- EC2側も最新の同SHA runが失敗・保留なら、過去の成功へ戻らない。既存73件のfailed/pending/stale/attempt不一致等の試験結果を再利用した。

## 6. Vinextへ戻した場合の案件データ互換性

以前の`PUBLIC_RELEASE_AUDIT.md`にも報告済み。今回、HEADの旧`app/page.tsx`、`components/siteflow/workspace.tsx`、`lib/siteflow/domain.ts`、`db/schema.ts`を再確認した。

| 項目 | 旧Vinext | Next.js＋MySQL | 切り戻し結果 |
| --- | --- | --- | --- |
| データ元 | projects/seedIssuesとuseState | 正式DBのProject等 | 新DB案件を旧画面で表示・編集できない |
| 識別子・状態 | p1/SF形式、open/in_progress/review/done | UUID等、NOT_STARTED/IN_PROGRESS/REVIEW/ON_HOLD/DONE | 自動変換/同期処理なし |
| ログイン・所属 | DB認証なしのデモ | Better Auth・所属・権限 | 新セッションを旧版で利用できない |
| 会議・履歴 | 新DBの会議を読む処理なし | Meeting/MeetingProject/MeetingConfirmation等 | 会議は旧画面では利用不可 |
| 保存 | 再読込でリセット | MySQLへ永続化 | DBデータは残るが旧版から操作不可 |

**Vinextへのrollbackは公開経路の復旧であって、案件管理機能を同等に継続するrollbackではない。** Nginxを旧3002へ戻し、MySQLとNextのデータは維持する。DBを昔のdumpへ戻す・reset/dropする操作は含めない。新しい正式データを受け付けた後は、Vinextを一時デモとして使う機能低下を承認し、同じDBを読める既知の正常なNext imageを主な復旧先として確保するのが適切。

## 7. 安全なGitHub反映後の確認手順（未実行）

1. 今回のfalse失効不足をどう扱うか決める。推奨はローカルCD補強と追加拒否テストを先に完了。これは今後の別作業として承認を受ける。
2. EC2側旧/新CDが停止・pausedであることを読み取り確認。既存Vinext/候補/正式DB・HTTPSも確認する。設定や公開経路を変更しない。
3. 候補一覧を再点検し、除外対象がcached diffへ入らない方法を具体化。commitの作成承認とpush先/ブランチの承認を受ける。今回は実施しない。
4. 推奨は専用branchへpush後、main宛てPRでCI検証。PR作成もCIを起動するため、push/PR/自動CIの実行をまとめて明示承認する。PRではGHCR保存・production jobなしが期待結果。
5. main反映は別承認。mainへのpush/mergeはCIとGHCR保存を自動実行する。falseでもGHCRへの書込はあるので「何も動かない」と説明しない。
6. CI成功と2imageのdigest/revisionを読取り、production jobが本人承認待ちになることを確認。承認しなければここで停止。EC2は停止・paused維持。
7. falseの動作を実Actionsで試す場合は、その承認job実行を別途許可してから本人が承認。gate disabled、record/upload skipped、対象run/attemptの新artifactなしを確認する。trueへ変更しない。
8. 以後のEC2配置、token管理、必要なmigration、候補起動、復帰設定/再起動試験、公開切替、正式DB smokeは各範囲の承認を受ける。実proxy統合と実API認証も残る。

## 8. 今回の検証と残リスク

今回：workflow YAMLを実parserで読み、起動・依存・権限・falseの2重guard・非接続・publish順序等8項目成功。false CLIを実行しdisabled/記録拒否を確認。過去artifact失効不足の再現1件。候補テキストの秘密検査0件、画像6枚確認、git diff --check成功。ソースやCI/CDファイルは変更していないため、直前のLinux73件・image3件・全体lint/型検査/業務42件/build成功を再利用し、同じテストは繰り返していない。

残る主な条件：false失効不足、EC2停止状態の当日再確認、送信ファイルの確定、GitHubでの実CI/承認artifact/API、実proxy統合、DB互換のNext復旧版、起動復帰、公開/正式DB操作の承認。`db/design/integrated.prisma`先頭には過去時点の「本番未適用」コメントが残っており、適用済みの実績と区別する文言整理も必要。今回はソースを変更していない。ローカルstage/commit/pushに進める許可はまだない。

## 9. 個別ファイル一覧

一覧取得時点：2026-11-19T11:39:17.646Z。変更20件・新規173件、計193件。条件付き候補189件・除外4件。以後の文書追記を含め、commit直前に一覧/内容を再取得する。

| Git状態 | 区分 | 用途 | ファイル |
| --- | --- | --- | --- |
| 変更 | 除外 | アプリ/設定 | `.agents/skills/web-development-learning/SKILL.md` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `.dockerignore` |
| 変更 | 条件付き送信候補 | CI/CD設計・配信 | `.github/workflows/ci.yml` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `.gitignore` |
| 変更 | 除外 | アプリ/設定 | `AGENTS.md` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `Dockerfile` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `README.md` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `app/page.tsx` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `components/siteflow/workspace.tsx` |
| 変更 | 条件付き送信候補 | 文書/画像 | `docs/GITHUB_REVIEW.md` |
| 変更 | 条件付き送信候補 | 文書/画像 | `docs/NON_FUNCTIONAL_REQUIREMENTS.md` |
| 変更 | 条件付き送信候補 | 文書/画像 | `docs/VERIFICATION.md` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `eslint.config.mjs` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/domain.ts` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `next.config.ts` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `package-lock.json` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `package.json` |
| 変更 | 条件付き送信候補 | テスト/検証 | `tests/domain.test.mjs` |
| 変更 | 条件付き送信候補 | アプリ/設定 | `tsconfig.json` |
| 変更 | 除外 | アプリ/設定 | `tsconfig.tsbuildinfo` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `.gitattributes` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `app/api/health/route.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `app/api/ready/route.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `app/api/siteflow/[...path]/route.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `app/workspace/page.tsx` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `components/siteflow/connected-workspace.module.css` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `components/siteflow/connected-workspace.tsx` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `components/siteflow/meeting-workspace.tsx` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `components/siteflow/project-create.tsx` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `components/siteflow/project-detail.tsx` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `components/siteflow/project-editor.tsx` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `components/siteflow/workspace-api.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `compose.dev.yaml` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `config/mysql.env.example` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `db/design/auth-generated.prisma` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `db/design/integrated-preview.sql` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `db/design/integrated.prisma` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `db/design/migrations/20261114_integrated_schema_check/migration.sql` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `db/design/migrations/20261115_meeting_round/migration.sql` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `db/design/migrations/migration_lock.toml` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `db/design/schema.prisma` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/app-runtime.example.env` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/backup/bucket-policy.json` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/backup/bucket-settings.json` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/backup/lifecycle.json` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/backup/restore-policy.json` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/backup/role-policy.json` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/cd-check.sh` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/check-app-secrets.sh` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/check-database-mount.sh` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/compose.production.yaml` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/github-production-branch.example.json` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/github-production-environment.example.json` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/github-production-variable.example.json` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/image-record.mjs` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/migrate.mjs` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/migration/package-lock.json` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/migration/package.json` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/mysql.cnf` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/nginx-siteflow-bootstrap.example.conf` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/nginx-upstream.example.inc` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/nginx-upstream.legacy.example.inc` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/prisma-public.config.ts` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/private-preview-https.mjs` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/recover-candidate.sh` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/release-record.mjs` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/release.sh` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/schema-hash.mjs` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/settings.example.json` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/siteflow-mysql.service` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/siteflow-release.service` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/siteflow-release.timer` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/start-database.sh` |
| 新規 | 条件付き送信候補 | CI/CD設計・配信 | `deploy/start-secure-mysql.sh` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/API_HEALTH.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/APPROVED_CD_SETUP.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/AWS_DEPLOY_PLAN.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/AWS_DEPLOY_RUNBOOK.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/BETTER_AUTH_SCHEMA_REVIEW.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/DATABASE_BACKUP_CHECK.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/DATA_MODEL.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/GITHUB_PUSH_AUDIT.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/HTTPS_COOKIE_CHECK.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/LEARNING_GUIDE.html` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/LOCAL_DATABASE.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/LOCAL_DOCKER_CHECK.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/LOCAL_WORKSPACE.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/MEETING_FLOW.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/MEMBERSHIP_AND_HISTORY.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/NEXTJS_API_INTEGRATION.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/NEXTJS_MIGRATION.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/PREDEPLOY_VALIDATION.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/PRISMA_API.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/PRISMA_CONNECTION.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/PRISMA_SCHEMA_DRAFT.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/PRODUCTION_MYSQL_DESIGN.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/PUBLIC_API_PROXY.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/PUBLIC_API_SETTINGS.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/PUBLIC_DEMO_PLAN.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/PUBLIC_INTEGRATED_TLS.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/PUBLIC_RELEASE_AUDIT.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/RESPONSE_REQUIRED_FOR_COMPLETION.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/S3_BACKUP_APPROVAL.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/SCHEMA_DATABASE_CHECK.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/TOKYO_DATE_SYNC.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/WORKSPACE_PREVIEW.md` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/images/aws-candidate-https-desktop.png` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/images/aws-candidate-https-mobile.png` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/images/preview-workspace-desktop.png` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/images/preview-workspace-mobile.png` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/images/workspace-desktop.png` |
| 新規 | 条件付き送信候補 | 文書/画像 | `docs/images/workspace-mobile.png` |
| 新規 | 除外 | DB/API/検証例 | `examples/mysql/.vinext/dev/lock.json` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/api-handler.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/api-server.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/app/api/db-check/route.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/app/layout.tsx` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/auth-check.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/auth.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/backup-check-settings.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/check-backup-restore.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/check-https-cookies.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/check-integrated-next.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/check-meeting-browser.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/check-public-migration.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/check-workspace-browser.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/check.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/database.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/dev-api.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/dev-auth.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/json-body.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/local-workspace-data.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/meeting-service.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/next.config.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/package-lock.json` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/package.json` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/prepare-schema-check.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/prepare-workspace.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/prisma-backup-check.config.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/prisma-design.config.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/prisma-schema-check.config.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/prisma/schema.prisma` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/prisma7.config.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/project-archive-service.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/project-service.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/public-api-settings.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/public-api.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/public-database.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/run-auth-check.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/run-meeting-check.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/schema-auth.config.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/schema-check-settings.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/secret-files.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/team-service.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/tls-mysql-fixture.mjs` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/tsconfig.json` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/vite.config.ts` |
| 新規 | 条件付き送信候補 | DB/API/検証例 | `examples/mysql/web-api-handler.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/api-proxy.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/integrated-api.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/integrated-handler.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/integrated-runtime.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/local-api.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/proxy-origins.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/public-api-proxy.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/public-cookies.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/public-integrated-api.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/public-integrated-runtime.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/readiness.ts` |
| 新規 | 条件付き送信候補 | アプリ/設定 | `lib/siteflow/workspace-connection.ts` |
| 新規 | 条件付き送信候補 | テスト/検証 | `scripts/check-candidate.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `scripts/check-deploy-config.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `scripts/check-docker-image.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `scripts/check-private-preview-browser.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `scripts/private-preview-proxy.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/auth-check.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/backup-check.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/candidate-check.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/deploy-proxy-check.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/deploy.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/image-record.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/integrated-api.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/local-api.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/local-settings.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/meeting-check.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/meeting-domain.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/public-api-proxy.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/public-api-settings.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/public-integrated.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/readiness.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/schema-check.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/secret-files.test.mjs` |
| 新規 | 条件付き送信候補 | テスト/検証 | `tests/workspace-connection.test.mjs` |
