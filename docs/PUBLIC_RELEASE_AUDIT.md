# Next.js公開前・承認付きCD最終監査

確認日：2026-11-19 05:24〜05:34 JST。GitHub API/接続プラグイン、EC2 SSHの読み取り、ローカルの安全な検査のみ。

**判定：現状のまま承認付きCDでNext.jsへ公開切替するのはNO-GO。旧Vinext公開を維持する状態は正常。** Next.jsの正式DB接続・S3復元後の業務操作・HTTPSは確認済みだが、GitHub/EC2の配信実設定、追跡可能な公開イメージ、配信コードの補強と再検証が不足している。

Git push、Actions実行、Docker pull/build/start on EC2、Nginx変更/test/reload、サービス再起動、DB書込/新規作成/再取込はしていない。ローカルDockerも起動していない。変更したのは監査用workファイルと文書のみ。

## 1. すでに確認済み

| 対象 | 実測した状態 |
| --- | --- |
| GitHub main | ae3e31a78da037d0f855e9143ea5cce5e0a6cfe3。公開repository。workflowはci.ymlの1件、active |
| 最新push CI | 2026-11-06のrun 42215641340がsuccess。今回の実行ではない |
| 実GitHubのCI | main push/PRでビルド・domain test・HTTP smoke。main pushだけGHCRへSHAタグを保存。承認jobはまだない |
| ローカルとの差 | local HEADは同じ旧SHAだがworktree99件、ci.yml変更・deploy未追跡。ローカルの新CD実装をGitHub反映済みと扱わない |
| 旧EC2 CD | siteflow-cd.timer disabled/inactive、service inactive。関連cron entryなし。稼働中はVinext・Next候補・MySQLの3件だけ |
| 新EC2 CD | siteflow-release.service/timerはnot-found。release/settings/runtime/upstreamと常設cd-check/release scriptも未配置 |
| 公開先 | /etc/nginx/conf.d/siteflow.confが127.0.0.1:3002へ直接proxy_pass。まだupstream include/slot headerなし |
| 旧Vinext | 3d97924314a0b8131b53137ce1306c1ab778352c03548e56d58296eb077adc82、ghcr.io/syucream02/siteflow:ae3e31a78da037d0f855e9143ea5cce5e0a6cfe3。GHCR digest ghcr.io/syucream02/siteflow@sha256:46305b1d7ab09f8a7ce1002d2b82dd75d934545b5d45288f805ea646cba741fd、稼働中 |
| Next候補 | 73f46217da34222bc4ed6ccf5f5273b036f33f152531b8c5fe2448d31fb340b5、127.0.0.1:3001→3000。image ID sha256:44b74c75c1829b97311362138c730c0a8034ecbab6d275ea799b5667b184dbcf、read-only、384MiB/swap禁止、restart=no、log-driver none |
| Next候補のDB設定 | mysql.siteflow.test:3306 / **siteflow_public_app** / siteflow_runtime / TLS required。復元DB名を使っていない |
| 実DB接続 | information_schema.PROCESSLISTでsiteflow_runtime→siteflow_public_appを2件確認。ほかのDBへの接続なし |
| runtime権限 | 正式DBの15業務テーブルだけCRUD各15件。globalはUSAGEだけ、schema-wide0、継承role0。migration表の権限なし |
| 秘密 | password/auth-secretは暗号化EBSのcandidate/、uid1000/0400、readonly bind。Docker Envに平文secretなし。実値は読まず出力しない |
| 移行 | 正式DBの適用2履歴がローカルSQL checksumと一致。候補の検証receiptとローカルschemaHash 80b4eb7a951cd8da6f6a7ef4a68c9f63d52dbc624db2476f3cf93e5901959e07が一致。sf_migrate_candidateはlocked |
| 既存サービス | 候補readiness200、MySQL healthy、旧HTTPS200、Nginx設定hash不変 |
| HTTPS | 直前監査で外部/EC2指紋一致、期限2026-11-25 03:18:43 JST、自動更新/reload実績あり。今回のEC2期限/serialも同じ |
| S3復元 | 直前の承認済み試験で16テーブル、27外部キー、CHECK TABLE、復元側ログイン/案件保存/再取得/ログアウト成功。今回その試験を繰り返していない |

### pushによって動くものを区別する

**現在GitHubにある版**：main push → Docker build → test/smoke → GHCRへcommit SHAタグ保存。PR → build/testだけ。workflowにEC2 SSH/切替命令はない。EC2側の旧polling CDは停止中なので、確認できた経路ではpushだけでNginxは切り替わらない。

**ローカルの新ci.ymlを将来pushした場合**：そのpushのworkflow内容で実行されるため、build/test・app/migrationの2イメージ保存に加えproductionを参照するrelease-approved jobが対象になる。main以外のpushやPRを本番承認としない。productionが未作成だと、参照だけで無保護の環境が作られ得るので、**push前に保護設定を作る**。SITEFLOW_RELEASE_ENABLED未設定/falseなら承認記録作成は拒否するが、それだけで本人承認の実装を代用しない。

GitHubのwebhook一覧とActions管理権限は公開APIでは401で未確認。外部の配信受信先が絶対に存在しないとは断言しない。承認付きCDの実設定ができたという判定にも使わない。

## 2. 未確認・不足している項目

- production環境は一覧0件/production404。本人review、自己review許可、main限定、admin bypass禁止、許可変数の実設定・承認runは未実施。
- repositoryはpublicなので現行GitHubプランではRequired reviewersを利用する条件に合う。実アカウントの契約明細や全管理設定は今回取得していない。環境を作って本人承認の実動作を確認する必要がある。
- Next候補はEC2ローカルimage ID固定だがRepoDigests空・OCI revisionなし。今の候補を「CI承認済みGit SHA/GHCR digest」として追跡する証拠はない。
- 公開用app-runtime.env/settings.json/current.json/schema.json/legacy.json、最小read token、EBS guard付き常設CD、Nginx bootstrapは未導入。settings.example.jsonは例でpublicOrigin=siteflow.example.comのまま。実公開値に勝手に読み替えない。
- Docker Desktop Linux engineが停止。既存のLinux模擬配信62件は過去ログとして残るが、今回再実行していない。WSLはdocker-desktopだけ。EC2を代わりのテスト場にしていない。
- 本番のNginx切替/失敗後復元、GitHub承認を使った実CD、公開HTTPSでのNext業務操作は未実施。
- Next restart=no、MySQL unit disabled。EC2再起動で両方が自動復帰するとは言えない。既存recover-candidate.shは3001候補用で、新blue/greenの復旧をそのまま代用しない。
- Next/MySQLのDocker log-driverはnone。docker logsでアプリログを確認できる前提を置かない。保護された必要最小限の障害記録/メトリクスと、HTTP/Nginx/systemd状態でどう調べるかを公開前に確定する。

## 3. 公開前に修正・整備が必要

| 優先 | 対象 | 理由・必要な確認 |
| --- | --- | --- |
| P0 | production保護 + 配信ゲート | 本人required reviewer、prevent_self_review=false、bypass禁止、main branchのみ。最初はGitHub許可false/EC2 paused。承認記録があっても本番切替許可と同一にしない |
| P0 | 公開成果物の確定 | レビューした変更を明示commitし、承認後のpush/CIでappとmigrationの固定digest・revision・同一run/attemptを得る。今回pushしない |
| P0 | 実settings/receipt/秘密/転送先 | 正式DBはsiteflow_public_app、user siteflow_runtime、origin https://13.237.188.172。復元DBや検証ユーザー文字列を実公開設定に混ぜない。CLIに秘密値を展開しない |
| P1 | release.shのmigration結合 | schema receiptのschemaHash/DB/host/CAは比較するが**receipt.migrationDigestとmanifest.migrationDigestの一致を比較していない**。固定migration artifactを承認する設計に合わせて等価性チェックを追加する案。静的所見で、改ざんreceiptによる実行再現は今回未検証 |
| P1 | 同一digest時の稼働確認/復帰 | release.shはcurrent.image一致だけでALREADY_RELEASED終了し、実containerの稼働/readyを確認しない。再起動復帰をCD任せにしない。EBS guard→DB healthy→承認済みcurrent枠を復帰する手順/仕組みを整備 |
| P1 | 実proxy統合テストfixture | tests/deploy-proxy-check.mjsのsettings/runtime fixtureに、現行release.shが要求するdatabasePasswordFile/authSecretFile/EBS等がない。現行の秘密保護条件へ追従させてLinux上で再検証する。これは静的所見で、今回その統合テストを実行して失敗を観測したわけではない |
| P1 | Linuxと実CDの検証 | 下記ローカル検証に加えて62シナリオ・実Nginx/TLS/Nextと拒否/rollbackケース、migrationDigest不一致、同digestだが停止中のケースを確認。模擬成功と実EC2成功を区別 |

これらは調査で挙げた修正案で、CI/CDファイル・本番設定は変更していない。CI/CDソース修正・GitHub設定変更・EC2常設反映・push・本番切替は、対象と影響を提示して事前承認を得る。

### ローカルで今回実施した安全な検査

- Git Bashのbash -nで配信関連シェル6件の構文成功（-nは実行せず構文だけ）。
- node --test --test-name-pattern「承認記録は」で承認recordの純粋テスト成功。--testはテスト実行、--test-name-patternは対象限定。実Docker/GitHub/DBへ接続しない。
- node scripts/check-deploy-config.mjsでCompose設定5項目成功。compose configだけで、外部volume/network必須・MySQL port非公開・loopback app ports・memory/readonly等を確認。サービスは起動しない。
- 完全なLinux統合は未再実行。静的な不足を「既存62件が合格したから安全」と打ち消さない。

## 4. 公開切替前に確定する構成

~~~text
現在：外部HTTPS → Nginx（証明書live）→ Vinext 127.0.0.1:3002
                          非公開確認：Next候補 127.0.0.1:3001 → 正式MySQL

承認付きCD案：main → CI → GHCR固定app/migration digest
                        → production本人承認のrecord
EC2：enabled + pausedなし + incidentなし + main/run/attempt/承認/receipt照合
    → blue 127.0.0.1:3101 または green :3102 を非公開起動
    → 正式DB実接続 + ready → Nginx upstreamだけを切替 → 外部HTTPS/slotを確認
~~~

3001の既存候補はCD枠として再利用しない。旧CDは3001/3002を使いdocker stop/rm/run/nginx操作を持ち、本人承認ゲートの参照がない。**旧timerや旧deploy.shを再開しない**。旧公開3002を残し、初回bootstrapもlegacy3002で作ってから承認後にblue3101へ。

Nginx変更点はlocation /の直接proxy_passを/etc/nginx/siteflow/upstream.inc参照へ分離し、X-SiteFlow-Slotと既存Host/X-Forwarded-*を維持すること。80番のACME例外、HTTPS転送、certificate/keyのliveパスは保持する。証明書とDB設定を切替のついでに変えない。

## 5. 当日の具体的な手順（未実行・各承認後だけ）

| 順序 | 操作と合格条件 | 中止条件 |
| --- | --- | --- |
| 0 | 本監査P0/P1を解消して再検証。今回の候補ではなく公開するGit SHA/app digest/migration digest/schemaHash/run/attemptを1枚の承認記録に確定 | 不一致、未知の変更/秘密混入、追跡できない成果物 |
| 1 | GitHub productionとEC2ゲートを保護・pausedで用意。新CD未有効、旧CD停止を確認。authenticatedなwebhooks/Actions権限も読取確認 | 無保護な環境/旧CD稼働/外部自動デプロイ経路が不明 |
| 2 | レビュー済み差分のcommit/pushを別承認。CIで固定2imageを得る。本人のproduction承認を実試験する間もEC2 paused。リリース許可変数の変更も承認を得る | CI失敗/skip、本人承認なし、別SHA/attempt、mainが進んだ |
| 3 | 公開直前に外部/EC2証明書の指紋・期限・IP名を照合、HTTPS200/Certbot timerと直近成功を確認 | 期限不足/不一致/更新失敗。更新/reloadは必要なら別承認 |
| 4 | 正式DB最新backupをsf_s3_backupでTLS取得し、gzip→既存age公開鍵で暗号化し既存S3 protectedへ新規保存。サイズ/hash/VersionId照合。これは当日batch承認に含める。既存復元成功の証拠と対応付ける | backup不一致/保存失敗/接続先不明。古いbackupを最新としない |
| 5 | Nginx conf/include/current/previous/legacy state・旧image/CID・現在の開始時刻を暗号化EBS root700/600で保護記録。既存secretの扱い変更は明示承認。Nginx bootstrapをlegacy3002のまま承認後適用しnginx -t→reload→HTTPS200/legacy slot | 構文エラー、元のVinext応答が保てない |
| 6 | settingsとmigration receiptのDB名=siteflow_public_app、host=mysql.siteflow.test、CA・schemaHash・migration digestを照合。正式userの限定権限/秘密400:1000、EBS UUID/VolumeIdを確認 | 復元DB名/検証user混入、履歴差、CA差、未知/破壊的SQL。DB更新は勝手に実行しない |
| 7 | 1候補だけ3101等で非公開起動。image revision=承認SHA、Memory384MiB/swap0/read-only/logなし。起動前後のRAM/ディスク/既存サービスを測定。readinessはhttp.requestまたはcurlの正Hostで確認し不正Host拒否も確認 | 残りメモリ低下/timeout/OOM、既存サービス異常 |
| 8 | PROCESSLISTで公開枠runtime→正式DB、ほかDB0、正式用権限を確認。/api/ready200。migrationに新SQLが必要なら、別に内容/backup/承認を提示してここで止める | 実接続を確定できない。書き込んで接続先を推測しない |
| 9 | **公開切替の本人承認後だけ** enabled/pausedを承認範囲で操作し、upstreamをblue3101へatomic更新。nginx -t→reload→外部HTTPS /api/readyとX-SiteFlow-Slotを3回連続確認 | 構文/HTTPS/slot不一致、既存異常。以下rollbackへ |
| 10 | PCブラウザーでHTTPS→ログイン→案件1件作成→進捗保存→再取得/再読込→ログアウト/旧session401を確認。ここは正式DBへsession/架空案件を書き込むため**別途、対象と件数を明示して事前承認**。既存案件は変更/削除しない | 認証/保存不整合、チーム境界異常。勝手にtestデータを削除しない |
| 11 | MySQL healthy・OOM0、正式DBの意図した書込だけ、旧Vinext維持、Nginx error/HTTP5xx、readiness/slot、資源/承認recordを最終確認。旧枠を即削除しない | 予想外のデータ変更/漏洩疑いは停止 |

上記は予定であり、今回の公開切替許可ではない。最短の手動公開を別に選ぶ場合も、3001候補への直接proxy変更は別案・別承認とし「承認付きCDが稼働した」と扱わない。

### ログ確認の具体的な範囲

Nginx access/errorは/var/log/nginx/access.logとerror.logが存在（本文は今回未読）。切替時刻以降のstatus/5xx/upstream connect error/reload errorだけを抽出し、Cookie・Authorization・POST本文・個人情報を出さない。systemdは新CDのResult/exit status、nginx reload結果、DB unit状態を照合。Next/MySQLはlog-driver noneなのでdocker logsに依存せず、ready/API応答・DB health・memory.eventsのoom/oom_kill・保護された最小診断記録を使う。必要な本番ログ設定の変更は事前承認。Nextの失敗を捕まえるために秘密入りenvをdumpしない。

## 6. Vinextへのロールバック（未実行）

### 前提・保持するもの

対象はNginx公開経路であり、**正式DBを過去へ復元しない**。旧VinextはMySQL版と機能/保存先が異なるため、旧画面への復帰は公開可用性の復旧であり、Next.jsのログイン/保存済み案件が旧画面で使えることを意味しない。Nextで受け付けたデータはMySQLへ保持する。Nextへの復帰に向けて同schema互換の正常imageを確保する。

旧VinextのCID/imageは上表で固定。停止/削除せず3002が応答することを確認。新NextとMySQLもデータを消さず保持し、処理中の書込があり得る間は候補を強制削除しない。

### A. 切替途中の失敗

整備後のrelease.shは未commitの切替失敗時に、transactionに保存したupstream.beforeへ戻しnginx -t/reload→旧slotの外部HTTPSを確認する設計。rollbackも失敗したら両containerを保持しincident.jsonで再配信を止める。これはソース確認と過去の模擬結果であり、今回の実EC2 rollback成功とはしない。

### B. 切替成功後の業務不具合で手動復帰

1. 承認範囲に従いserver側pausedを作り新CD timerを止め、実行中配信の完了/排他lockを確認する。GitHub許可もfalseへ戻すならその変更を承認に含める。旧CDは起動しない。
2. /srv/siteflow-mysql/release/release.lockの同じlockをflockで取得し、他配信と競合しない状態にする。60秒等の上限で取得できなければ強行しない。
3. **bootstrap前の元confへ戻す場合**は、当日承認したbackupのsiteflow.confを/etc/nginx/conf.d/siteflow.conf.rollbackへコピー→同じdirectory内でmvしてatomic置換。次の例は未実行で、APPROVED_RELEASE_IDは当日記録で確定する。

~~~bash
release_backup='/srv/siteflow-mysql/release/backups/APPROVED_RELEASE_ID'
sudo cp -- "$release_backup/siteflow.conf" /etc/nginx/conf.d/siteflow.conf.rollback
sudo mv -- /etc/nginx/conf.d/siteflow.conf.rollback /etc/nginx/conf.d/siteflow.conf
if sudo nginx -t; then
  sudo systemctl reload nginx
else
  exit 1
fi
~~~

release_backupは承認済み復元元の指定、cpは元を保持してコピー、mvは同directory内の置換、--はオプション解釈の区切り。nginx -tは構文確認のみ。systemctl reloadは成功した場合だけ現在の公開Nginxへ反映する変更で、事前承認が必須。これらの実行は上記paused/排他を確保した管理操作内で行う。構文エラーならreloadせず、旧workerを維持して停止・調査する。

4. **bootstrap構成を保ったまま戻す場合**は、承認前に保存したlegacy用includeを/etc/nginx/siteflow/upstream.inc.rollbackへコピーしてmvし、同じnginx -t/reloadを実施。内容は次の2行だけ（現時点ではこのinclude自体が未導入）。

~~~nginx
proxy_pass http://127.0.0.1:3002;
set $siteflow_slot legacy;
~~~

5. paused状態でcurrent.jsonを当日の検証済みlegacy記録と一致させ、失敗したNextのimage/CID/run/attemptをincidentとして保持する。previous.jsonが常にlegacyとは限らないので盲目的にコピーしない。失敗を隠してCDを再enableしない。
6. 外部の新しいHTTPS接続で200、設定上の転送先3002、保持したVinext CID/image/開始時刻を確認。bootstrap版ならX-SiteFlow-Slot: legacyを連続確認。証明書は同じliveパスを使い、旧い証明書や鍵へ巻き戻さない。候補/DBの正常性も確認する。
7. Nextでの書込をDBへ保持したまま、原因・影響範囲・再公開案を報告。DB rollback/reset/dropや検証案件の物理削除は含めない。

## 7. 公開直前の証明書再確認

直前監査の期限は2026-11-25 03:18:43 JST。短期証明書なので当日再取得し、EC2 liveと外部leafのSHA256/serial/期限、IP名、TLS検証、HTTPS200を照合。certbot-renew.timer enabled/active、直近Result/更新・reloadログも確認。更新が必要なら保護backup/renew/reload/事後確認の承認を先に得る。今回その操作は実行していない。詳細はAWS_DEPLOY_RUNBOOK.mdの11月19日HTTPS監査を参照。

## 8. 根拠・公開可能へ進む次の一歩

- work/cd-github-readonly-20261119.json、GitHub接続プラグインで取得した実main/ci.yml。webhooks/Actions管理APIは401を未確認と記録。
- work/s3-cd-audit-20261119-result.json、work/s3-cd-audit-supplement-20261119-result.json。
- work/cd-local-audit-20261119.json、純粋テスト/Composeの当日log、既存tests/deploy.test.mjsとdeploy-proxy-check.mjsの静的確認。
- migration checksums [{"name":"20261114_integrated_schema_check","matchesRaw":true,"matchesNormalizedLf":true},{"name":"20261115_meeting_round","matchesRaw":true,"matchesNormalizedLf":true}]。
- [実mainのCI](https://github.com/syucream02/siteflow/blob/main/.github/workflows/ci.yml)、[最新の既存run](https://github.com/syucream02/siteflow/actions/runs/42215641340)。
- [GitHub公式production環境/自己承認/管理者bypass/環境自動作成の説明](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)。2026-11-19確認。

まずローカル配信コード/fixtureの補強とLinux再検証を承認対象として具体化し、その後GitHub保護・push・EC2設定反映・公開切替を別々に承認する。監査完了は公開操作の承認ではない。未完成の決定事項・招待・進捗差分等を、本番に置いたことだけで完成扱いしない。

## 追記：承認付きCDのローカル補強（2026-11-19）

migration digest/revision結合、同版の健全性確認、管理者迂回拒否、file-secret proxy fixtureをローカルで補強した。実GitHub/EC2には未反映。4件実行成功・Linux72件skip、業務42件、型検査/build/Compose5項目成功。全体lintは既存workの5エラー等で失敗、変更JS個別lintは成功。Docker Engine停止でLinux統合は未実行。**公開NO-GOは継続**。過去の監査結果を上書きせず、最新の手順・残条件は[APPROVED_CD_SETUP.md](APPROVED_CD_SETUP.md)にまとめた。

## 追記：ローカルLinux配信試験成功（2026-11-19）

Linux限定72件＋共通1件の73件が成功（失敗0・skip0）、追加image照合3件成功。ソース修正不要。network none/mounts0のローカル専用コンテナで検証し、実GitHub/EC2/正式DBは操作していない。GitHub production設定手順の案内へ進めるが、実proxy統合・GitHub保護・EC2新CD・復帰・公開切替は未実施のため公開NO-GOは継続。[最新結果と設定手順](APPROVED_CD_SETUP.md)を参照。
