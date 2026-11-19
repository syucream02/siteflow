# SiteFlow公開前の読み取り調査・ローカル検証

2026年11月16日。ユーザーがMySQL設計を基本方針として採用した後の事前検証。**本番のファイル/コンテナ/image削除、MySQL起動、Docker設定変更、EBS変更、S3作成、Git push、本番切替は行わない。** 実測・試験・推定・承認待ちを区別する。

最新の追加調査・提案は[9節](#9-削除対象の再確認暗号化の推奨と個別承認手順2026-11-16)。削除候補の現物・依存を再確認し、root暗号化をDB導入前に行う案と30GiB化を比較した。**採用/作成/削除の承認を得た状態ではない。**

その後、停止4containerだけの整理をユーザーが条件付き承認。[10節](#10-承認された停止4コンテナの整理結果2026-11-16)に23:07〜23:08 JSTの復旧情報保存・削除・公開維持確認を記録した。9節の未承認は過去時点。**image削除・EBS/S3・DB/Next起動・push・切替は引き続き未実施/未承認。**

最新：ユーザーの効率化指示に従い、[実行計画冒頭](AWS_DEPLOY_PLAN.md)をA容量/B暗号化DB保存先/C候補起動の3承認群へ整理。[11節](#11-候補起動を優先したローカル実装と検証)のローカル実装/変更箇所の検証まで完了。今回はEC2調査を繰り返しておらず、本番へ変更を加えていない。

その後の最新実績：2026-11-17、ユーザーがAだけ承認。[12節](#12-承認a旧2イメージの整理結果2026-11-17)の対象2imageを削除し、現公開/直前版/保留版とHTTPSを維持、空き約9.69GiBを確認した。11節の本番未変更はその時点の記録。B/C/EBS/DB/Next/S3/push/切替へ承認を拡張していない。

最新のB準備：[13節](#13-b準備ebs作成値と画面別手順2026-11-17)に06:01 JSTの読み取りでAZ ap-southeast-2c/既存rootだけを確認。作成/アタッチ/format/mountの各変更は個別承認。EBSはまだ作成していない。

最新のユーザー実施/OS確認：[14節](#14-ユーザー作成接続後のnvme読み取り照合2026-11-17)に、新EBS `vol-01a737715ed956301`の作成/接続報告と06:26 JSTの実測を記録。10GiBの`/dev/nvme1n1`、AWS名`/dev/sdf`と一致し、FS署名/UUID/mountなし。フォーマット・マウント・fstab/DB変更は未実施。13節の未作成は過去時点。

最新の限定実行：[15節](#15-b3承認後の新10gib-xfsフォーマット結果)に、06:34 JSTのB3 formatだけの完了を記録。新UUIDは`276f374a-7e33-4ff0-b6f4-b0f185280cd6`、label SITEFLOW_DB、未mount。B4/mount/fstab/DB以降は未承認・未実施。

最新：B4手動mountの承認後、06:40 JSTに新UUIDを`/srv/siteflow-mysql`へ接続し、findmnt/lsblk/dfで新EBSとの一致を確認。[16節](#16-b4承認後の手動マウント結果)。fstab/Docker/DB/Next/pushは変更していない。15節の未mountは過去時点。

最新B5：[17節](#17-自動マウントとmysql起動保護の設定結果)に06:58 JSTのfstab backup/UUID自動mount/DB専用systemd/Compose restart=noの設定と無起動検証を記録。DBサービスはdisabled/inactive・許可markerなし、MySQL起動/実再起動は未実施。16節の未設定は過去時点。

## 1. 本番EC2のディスクと整理候補

21:57:55 JST（12:57:55 UTC）からSSH読み取り。root EBS20GiB、空き約7.1GB/使用65％、RAM1909MiB/available1461MiB/swap使用0。旧Vinext約69.73MiB/上限192MiB、旧CD inactive/disabled、HTTPS200/TLS検証成功。今回の調査中に削除や設定変更をしていない。

22:39:25 JSTの最終再確認でも空き約7.1GB/65％、同じ旧Vinext image/127.0.0.1:3002、HTTPS200、CD timer inactive/disabled。Nginx設定SHA256は`2c874b818a1e865283f62cec2e61478d3c4d104beb523bb700e58815bd64d595`で不変。RAM availableは1018MiBへ変動、swap2047MiB中使用0。idle時の余力も固定値ではないため、本番負荷測定で判断する。

### 残すものと候補

| 判定 | 対象 | 理由/容量 |
| --- | --- | --- |
| 必ず残す | 現在のae3e31a版・siteflow-3002・image d74947ec157c | 実際の公開/切り戻し先。固有1.286GB |
| 残す | 直前の8dd6fc2版・siteflow-backup-3001-1793967269・image31b80a0e6ea8 | もう1世代の復旧先。固有1.059GB＋共有層。現在版と合わせ保持 |
| 条件付き整理候補A | e0aa5cb版・siteflow-backup-3002-1793548783・image04d3b36a25dc | さらに古い停止済み。mountなし。固有1.059GB |
| 条件付き整理候補B | 16d10b2版・imagebf9dda4647e1と参照する停止済み3コンテナ | 固有1.286GB。同じimageなので3コンテナ×1.286GBとは計算しない |
| 保留 | siteflow:1.0・siteflow-legacy-backup・image6585a70b7615 | 固有1.286GB、RepoDigestなし。ローカルだけに残る版の可能性があり、不要と断定しない |
| 効果ほぼなし | hello-world、BuildKitの固有cache | 約10KBと約2.096MB。危険な一括pruneで追わない |

Bの参照コンテナは`siteflow-backup-3001-1793545823`、`siteflow-3001-pre-cd-backup`、`siteflow-3002-pre-cd-backup`。A+Bは停止済み4コンテナ/2イメージを対象とする承認案で、固有領域の目安は2.345GB（約2.18GiB）。実際の解放量は共有層/cache依存を含め削除後に測定し、保証しない。

必要条件：現公開/直前版は維持、対象ID/label/mount/停止状態を実行直前に再確認、復旧に必要な設定を秘密として適切に保管し、対象4コンテナ→対象2imageの順に明示承認後に整理する。imageがcontainerから参照されている間はimageだけ消せると説明しない。`--force`や一括container/image/system pruneは採用しない。**今回は候補提示だけで削除しない。**

現版/直前版/候補2版のGHCR固定digestのmanifest参照はすべて成功した。イメージ層の再取得や実復旧が成功した証明ではない。固定digestとコンテナIDの詳細は読み取り結果/既存runbookを参照する。

### cache・ログ・その他

- `/var/lib/docker`約6861MiB、うちoverlay2約6838MiB。imageの論理サイズ/共有サイズ/du実占有を混同しない。BuildKitに1GB級の共有行があっても、それをcache削除で1GB解放できるとは扱わない。
- containerの書込層は全7件0B、Volumeは本番に0個。停止済みのexit137はOOMフラグfalseで、メモリ不足の証拠にはしない。
- Docker JSONログ7件の合計は108,661バイト程度。現公開ログ約31KB、最大の旧ログ54KBで、容量対策として消す価値は小さい。Docker管理ログを手で削除/truncateしない。
- OSログ約365MiB、journald約307.1M。保持期間/監査要件/別保管を決めた後なら古いarchiveの整理候補だが、activeログも含む総量を全削除可能量としない。今回vacuum/rotation設定変更なし。
- `/var/cache/dnf`約183MiB、npm cache約215MiBは再取得可能なcache候補。ただし対象と影響の別承認が必要。まずDocker旧世代を優先する。
- `/home/ec2-user/siteflow`約966MiBは旧ビルド作業領域と思われるが依存関係未調査のため保留。Certbot用venv約56MiBは証明書更新に必要なので残す。NVM/SSH/AWS/認証設定も一括削除しない。

## 2. メモリ・ディスクの運用条件

本番の実RAMは1909MiB。初期値はMySQL512MiB/キャッシュ128MiB/接続30、Next.js各384MiB/接続pool2、既存Vinext192MiB。上限は予約量ではなく、超過するとOOMの可能性がある。OS/Docker/Nginx等には250〜450MiBの仮予算を置く。

| 状態 | container上限合計 | 運用条件 |
| --- | ---: | --- |
| 初回：Vinext＋Next候補1＋DB | 1088MiB | DB/TLS/復元を先に検証、候補は1台のみ |
| 通常：Next1＋DB | 896MiB | 日次backup時を含め測定 |
| 更新：Next2＋DB | 1280MiB | 旧Vinextは成功後に別承認で停止済みであること。3アプリ＋DBを同時稼働しない |
| migration：CLI512＋DB＋Vinext | 1216MiB | Next候補増台/backup/復元と重ねない |

実機の公開条件は21案件以上・5利用者・15分・更新/保存/会議操作を含み、OOMなし、available200MiB以上を目安に維持、swap増加が続かないこと。今回のDocker Desktop検証や短い読み取り負荷だけで合格にしない。

t3.smallはCPUを常時使い続ける大規模運用向けではない。CIでimageをビルドし、EC2ではビルドしない。CPU credit残高/Unlimitedの設定と追加課金の有無は今回独立照会していないので、長時間負荷前に確認する。swapは突然のhost OOMへの補助で、containerのメモリ上限超過を救う設定ではない。available低下/継続swap/timeout/OOM/空き25％未満なら新候補を増やさず、旧公開を維持して負荷/接続/同時処理を確認する。サイズ変更は別承認。

ローカルのcached image論理サイズはNext.js391,425,603バイト、migration991,781,391バイト、MySQL1,102,624,541バイト。合計約2.486GBは共有層を差し引く前の値で、展開/DB/tmp/backupは別。従来の「追加0.8〜2.0GiB」は確定値ではなく、この実サイズで再評価する。本番で新imageを取得する前後に実占有を確認する。

20GiBの25％空きは約5GiB。現空き7.1GBに追加image/DB/ログ/backupを置くと不足し得る。候補A+Bを承認後に整理する案で約2.18GiB増が見込めるが、実測前に足りると確定しない。空き不足なら起動せず、対象限定整理/容量拡張/暗号化データEBSを比較する。無断prune/4GB化/EBS拡張はしない。

## 3. ローカルのデータ保持・TLS・復元検証

実行用コードはGit対象外の`work/check-predeploy-database.mjs`。既存fixture/Prisma/Next.jsイメージを使い、ランダム名network/volumeと架空DBだけを作る。通常の開発DBは使わない。Docker Desktopは当初停止していたため起動した。本番Dockerは変更していない。

計画/期待結果：

1. 正しいCA/SANでTLS接続、誤CA/接続先名不一致/平文は拒否。Next.jsの誤CAはreadiness503。runtime用ユーザーはDDL拒否。
2. 5架空ユーザー/105案件/会議の確認取消データを作り、Next.jsからログイン/案件取得。回数制限を守ってログインし、5並列45秒の読み取りとメモリを測定する。
3. MySQLを通常停止しExitCode0/OOMなしを確認。containerのみ再作成し、同じVolumeのserver UUIDと全16tableの内容/認証/履歴を2回比較。Next.jsも作り直して保存sessionが使えることを確認。
4. TLS付き専用backupユーザーでdumpし、専用restoreユーザーで別の空DBへ復元。元DBへのアクセスとbackupのDDLは拒否。全行/会議取消を照合、復元sessionを失効して元DB不変を確認。復元DBにつなぐCRUD権限だけのNext.jsで再ログイン/案件取得する。
5. 自分が作ったcontainer/Volume/network/一時鍵/証明書だけを削除し、成功結果だけ記録。失敗時はphase/安全なエラー番号を残し、秘密/SQL/生の例外を出さない。

### 今回の実行結果：15項目成功

2026-11-16、既存のNext.js公開用imageとMySQL8.4.13を使用。結果はGit対象外の`work/predeploy-database-results.json`。秘密値/SQL本体は記録せず、試験用資源の回収完了も確認した。

| 確認 | 結果と範囲 |
| --- | --- |
| migration/拒否条件 | 正常2履歴/16table。無承認・誤CA・構造差分などを拒否。アプリのCREATEも拒否 |
| 実アプリと負荷 | 架空5ユーザー/105案件、5並列45秒で案件取得1100要求成功。15分/書き込み負荷の合格ではない |
| サンプル時メモリ | ログイン後〜読み取り終了：Next151.6〜176.7MiB、MySQL264.3〜265.4MiB。離散的な採取値で瞬間最大を保証しない |
| TLS | Prisma経由TLSv1.3。CA不正/接続名不一致/平文を拒否、実Nextの誤CAはready503、正しいCAは200 |
| Volume保持 | MySQL正常停止ExitCode0/OOM=falseの後にcontainer再作成を2回。同じserver UUID、全16tableの全行/履歴/認証を照合 |
| Next再作成 | 固定認証secretとDBに残ったsessionで案件取得成功。container内だけにsessionを保存していないことを確認 |
| 専用backup/restore | TLSと対象DB限定ユーザーで取得→空の別DBへ復元。全16table一致、backupのDDL/restoreの元DB参照は拒否 |
| 復元後の動作 | 会議1件/確認取消を含む確認記録2件を保持。復元session失効後は旧cookie401、新ログイン200/案件取得200。元DBの全行は不変 |
| サイズ | 試験Volume223,870,976バイト（約213.5MiB）、SQL104,951バイト。小規模の試験値で、本番最大値ではない |
| 後片付け | 試験専用container/Volume/network/一時証明書・鍵を回収。通常開発DB/本番資源は対象外 |

最終一覧で試験名の資源が残らないことも確認。既存`siteflow-dev-mysql-1`、`siteflow-dev_mysql-data`、`siteflow-dev_default`は保持している。この一覧確認だけで普段の開発DBの正常動作を再試験したとは扱わない。

本番のRAM1909MiBに制限したホスト試験ではなく、Docker Desktop上の測定。OSの余力、CPUクレジット、15分の更新/会議操作、backupとの同時負荷、MySQL初期化中のピーク、EC2 Docker25/Composeでの再作成は未検証。上限512/384MiBが十分と確定しない。

#### 試験で見つかった注意点と対処

- 同一IPから5ログインを短時間に行うとBetter Authの既定制限（sign-inは10秒に3回）で429になった。製品の制限は緩和せず、試験を2ログインごと11秒待機にして成功。将来の公開時は同一IP利用者とログイン失敗表示を確認する。通常UIの429専用案内は今回改善していない。
- 最初の専用restoreは権限エラー1044。dumpの既定`--add-locks`が復元SQLへLOCK TABLESを入れるためで、`--skip-add-locks`にして再検証成功。取得中の`--skip-lock-tables`だけでは代わりにならない。元DB/復元先を取り違えた場合や未知の権限不足では中止し、rootへ切り替えて続行しない。
- SQLはテストプロセスのメモリ内だけで扱い、平文ファイルとして残していない。本番のgzip/age/S3への暗号化・転送・復号はまだ試験していない。

#### 実Nginx経由の公開切替：3項目成功

既存コマンド`node --import ./examples/mysql/node_modules/tsx/dist/loader.mjs examples/mysql/check-public-migration.mjs --proxy`を実行。`--import`は既存のTypeScript読み込み、`--proxy`はNginxを含む専用ローカル試験を選ぶ。使い捨てDB/ネットワーク等を作成して最後に回収する。本番切替は行わない。

結果は`work/deploy-proxy-check.json`。実NginxのHTTPS→実Next.js→TLS MySQLの切替、候補設定不備なら旧転送維持、切替後HTTPS失敗なら旧転送へ戻す、の3件が成功。ただしDocker CLIはローカルprocess adapter、旧転送先はHTTP fixture（試験用の代役）で、実Vinext imageの再取得/再起動や本番Nginxを変更する復旧試験ではない。

### 本番Volumeで後日行う試験（未承認・未実施）

- 旧Vinext/HTTPを維持したまま、明示初期化した本番Volumeへ検証用の架空レコードを保存。volume ID/所有label/DB名/MySQL digest/schemaHash/件数を記録する。
- backupと別DB復元合格後、DBのみ正常停止→そのcontainerのみ再作成。`down -v`は使わず、既存volume存在/所有label/auto.cnf/mysqlディレクトリを確認して再開。
- 同じserver UUID/全table/会議取消/適用履歴を照合し、アプリ経由の再読込・保存を確認。何もないvolumeを見つけたら初期化せず拒否する。
- 失敗時は旧サイトを維持し元volumeを残す。繰り返し空初期化せず原因/バックアップを確認する。取得前backupを元へ自動上書きしない。

## 4. S3バックアップの具体案

S3は未作成。次の案をレビュー/見積/承認してから導入する。regionはap-southeast-2、bucket名は`siteflow-backup-<AWSアカウント識別>-ap-southeast-2`を候補とし、実アカウント/一意性は作成前に確認する。業務名/メール/パスワード等を名前やmetadataへ入れない。

| 設定 | 具体案/意味/期待 | 失敗時 |
| --- | --- | --- |
| 公開防止 | bucketのBlock Public Access4項目をON、Object OwnershipはBucket owner enforcedでACL不使用 | public/共有の想定外設定ならuploadしない |
| 保存暗号化 | bucket default SSE-S3、PUTでAES256を明示。さらにSQL/秘密設定はageで暗号化してから送る | SSE-S3だけでEC2一時SQLが暗号化されたとは扱わない。暗号化失敗なら転送/成功記録なし |
| 通信 | HTTPSのみ。bucket policyでSecureTransport=falseを拒否 | TLS失敗を回避せず中止 |
| 世代保護 | Versioning ON。dailyの最新成功7世代をcurrent objectで保持、noncurrentは30日を候補。protected/configは自動期限なし | dailyの新規成功前に古い成功を消さない。失敗時も前のbackupを維持 |
| 保存層 | 初版はS3 Standardのみ。Glacier/Archive/replication/Object Lockは追加しない | 料金や待ち時間の複雑さを増やさず、迅速な復元を優先 |
| 復号鍵 | EC2はageの公開recipientのみ。秘密identityは手元と別の安全な場所で二重保管 | 鍵が利用できなければ復元可能としない。初回に復号/復元試験する |

保存prefixは`daily/`（自動のSQL）、`protected/`（公開前/構造変更前/休止前）、`config/`（秘密設定archive）で分ける。日付UTC＋run IDの一意なキーを使い、再試行時に同じrunを上書き/重複作成しない。protected/configは2027年1〜4月または希望時の再開確認まで自動削除しない。既存EBS snapshotは別保管で、このS3整理の対象にしない。

### IAMの最小権限案

EC2の既存instance roleに対象bucketだけのpolicyを追加する案。rootやS3FullAccess、長期access keyをruntime.envへ追加する案は採用しない。以下は権限の設計で、適用していない。

| 主体/操作 | 許可する範囲 |
| --- | --- |
| EC2 backup・ListBucket | このbucketのdaily/protected/config prefixのみ。bucket自体のResourceとprefix条件を使う |
| EC2 backup・PutObject/GetObject | 3prefixだけ。single PUTとHEAD/read-backでchecksum/サイズを確認する |
| EC2 backup・DeleteObject | daily/*だけ。protected/configは明示拒否。日次の成功7世代整理だけに使う |
| EC2 backup・DeleteObjectVersion | 全prefixで拒否。Versioning有効時の削除で古いversionを直ちに消さない |
| EC2 backup・bucket/IAM変更 | 許可しない。bucket削除、Versioning/lifecycle/policy/ACL変更や権限拡張をしない |
| 運用者の復元用認証 | 必要時に対象versionのGetObjectVersion/ListBucketVersionsを使用。日常のアプリへ渡さない |

Versioningの旧版保持にも料金がかかる。dailyのnoncurrent30日だけを限定lifecycle対象にし、protected/configへ誤適用しない。上記の権限/拒否を実AWSで試験するのはS3作成/IAM変更の承認後。ローカルで仕様表を書いただけで権限分離検証済みとはしない。

### 取得・保存・復元の確定する流れ

1. DB構造変更と排他し、専用user/VERIFY_IDENTITYでdump→gzip→age→ciphertext.partial。Docker backup clientにはlog-driver none、ホストはumask077、pipefail、SQL/秘密をstdoutログへ出さない。
2. dumpはskip-add-drop-table/skip-lock-tablesに加えて**skip-add-locks**を使う。前者は取得中のlock、後者は復元SQLにLOCK TABLESを追加しない指定で意味が違う。復元先は自分だけが使う空DBなので不要なLOCK TABLES権限を与えない。
3. 完了したciphertextのSHA256/サイズを計算し、unique keyへsingle PUT（初期のbackup対象DBは100MiB以下、archiveは上限256MiBを想定）。checksum確認後にmanifestを保存。VersionId/UTC時刻/schemaHash/MySQL digest/ciphertext SHAを記録し、HTTP成功やETagだけを完全性確認にしない。
4. 期待するSHA/サイズ/manifestが揃ったものだけ成功世代として数える。upload不明なら同じkeyのHEAD/照合を行い、無確認で新しいkeyを増やさない。失敗/世代削除の前に旧backupを保持する。
5. 復元は運用者が対象VersionIdを固定→archive/hash確認→ageで復号/認証→gzip検査→元と異なる空DBへimport。専用restore userはそのDBだけにDDL/DML、元DBには権限なし。復号鍵や平文SQLを常設しない。
6. 全table/会議取消/Prisma履歴を照合し、復元sessionを失効、専用CRUDアプリで再ログイン/権限/案件を確認。実データ復旧は損失範囲/停止の別承認後、接続先と管理記録を更新して切替。元DBは残す。

初期目標はDB100MiB以下・運用者が対応可能な条件のRPO24h/RTO60分。EC2全損の再構築は別測定。backup失敗は即時に成功扱いから除外し、最終成功からの経過も確認する。メール/Slack等の通知先は未承認なので、導入案で利用者が選んでから設定する。ここでは送信/設定しない。

## 5. 非暗号化EBSの将来移行

現在の非暗号化EBSをその場で暗号化することはできない。snapshotから暗号化copy/新しいencrypted volumeを作る。これは停止/新規保存費/付け替えがあるため、今回の検証から実行しない。

### root全体を暗号化する案

1. SQL/秘密設定をEC2外へ暗号化backupし復元試験。既存image、root device名、volume ID/AZ、filesystem UUID、SG/起動条件、EIP関連付け、CD休止を記録する。
2. 書き込み停止・MySQL正常停止・EC2停止はそれぞれ承認。最新root snapshotを取得しcompleted確認。以前のsnapshotを使って現在の設定/将来DBを無断で過去へ戻さない。
3. 承認後に同じregionのencrypted snapshot copyと、同じAZ/20GiB以上のgp3 encrypted volumeを作る。AWS管理のEBS KMS keyを候補とし、利用権限/暗号化state/完了を確認。CMKを新規作成しない。
4. 停止中にroot device名を実照合して、旧rootをdetach/保管、新rootを同じdeviceへattach。NVMeの番号を固定名と思い込まない。旧root/旧snapshotは削除しない。XFSの同じUUIDを持つcloneを同時mountしない。
5. 起動を承認後、同じEC2/EIP、AWS側の新VolumeId/Encrypted=true、Docker保存領域、MySQL/アプリdata/TLS、旧CD休止/新CD pause、HTTPSを検証。合格までは新しい本番書き込みを開放しない。
6. 失敗時は新rootを消さず、再停止/旧root再接続/起動を個別承認で行う。新側で更新を受けた後なら、失われる書き込みを評価してから戻す。EIPを解放せず、無条件で昔のsnapshotへ戻さない。

同じ20GiBを置換しても、旧volumeを保持している期間は追加保存費が発生する。既知のgp3単価なら追加20GiBは月1.92ドル相当、standard snapshotは実保存量に応じ別途。暗号化copy/旧snapshotも保持するため無料とは扱わない。保管期間と削除は後で別承認する。

### DB用の暗号化データEBSを先に追加する代案

DB未導入の今なら、暗号化データEBS（例10GiB、gp3保存費月0.96ドル相当）を追加し、そこを保存先とするexternal named volumeを作る案もある。root交換を避けられる一方、mount/起動順/追加費用が必要。Volumeのdeviceをbindする場合はmountpoint/VolumeIdの検証が必須で、未mount時にrootの空ディレクトリへDBを初期化しない。

この代案はDBデータの暗号化だけで、既存root/環境変数ファイル/ログを暗号化したことにはならない。まず安全性/費用/学習負担を比較し、ユーザーが選ぶ。新EBS作成・format・fstab・交換・停止は未承認/未実施。

## 6. TLS証明書・Next.js接続の管理

既存publicDatabaseOptionsはCA/証明書名/TLS1.2以上を検証し、pool2/connect5秒/acquire5秒。DB aliasはmysql.siteflow.test、SANのDNS名と一致させる。CAは公開証明書だけをread-only mount、CA秘密鍵はEC2外で保管する。サーバー鍵はmysqlの実UID/GIDへ0600で読ませ、host root700のまま読めない問題を導入時に検証する。

初期案はCA3年/leaf1年、30日前に期限/serial/fingerprint/SAN/EKUと疎通を確認する。現在のローカルfixtureは1日証明書で、これを本番へ流用しない。IP向けHTTPSの短期Certbot証明書とも分ける。

更新は新leafを別ファイルへ配置/検証→承認したMySQL証明書reloadまたは制御した再起動→Nextの再接続/ready/ログインを確認。CA切替は新旧CAを一時的に両方信頼→サーバー切替→全client確認→旧CA除去の順を別計画にする。現adapterは複数CAのPEM読み込みを許すが、更新の実動作は未検証。TLS検証をfalseにしない。

失敗時は既知の有効な旧証明書/CAへ戻しreadinessを再確認。無効証明書で公開を続けたり、チェックを無効にして通したりしない。現在はEC2に本番DB証明書/秘密を作っていない。

## 7. 旧Vinext切り戻しとschema互換性

切り戻し先の現物は稼働中siteflow-3002、固定RepoDigest `ghcr.io/syucream02/siteflow@sha256:46305b1d7ab09f8a7ce1002d2b82dd75d934545b5d45288f805ea646cba741fd`、Nginxは127.0.0.1:3002。現物/設定hash/manifest参照を確認した。本番で切替/再起動による試験は行わない。

VinextはMySQLを読まないメモリデモなので、初回切り戻しは画面/公開の復旧で、DBを昔へ戻す必要はない。新DB/volumeを削除せず、データが見えないことを消失と混同しない。

現在のmigration2件はCREATE TABLE計15、ADD CONSTRAINTによる外部キー計27で、DROP/TRUNCATE/rename/列型変更は検出しなかった。履歴tableを含め現在の全tableは16。旧VinextとのDB互換性は不要だが、将来の旧Next.jsとの互換性は別に検証する。

将来は「nullable/default付き列や新tableを先に追加→新旧image双方でready/ログイン/CRUD/会議を確認→新コード切替→旧版保管期間後に削除変更を別計画」が基本。NOT NULL追加/名前変更/列削除/型縮小は同じリリースで実行しない。MySQL DDLが一括rollbackできると仮定せず、失敗時は旧公開維持/実構造/履歴を調査する。

必要な本番変更の順序は[設計書](PRODUCTION_MYSQL_DESIGN.md)と[AWS手順書](AWS_DEPLOY_RUNBOOK.md)。アプリ切り戻し、DB復元、EBS交換を同じ操作として扱わず、それぞれ対象/損失/承認を分ける。

## 8. コマンド・期待・失敗時の対処

今回の本番読み取り：SSHは既存鍵、BatchMode=yes/StrictHostKeyChecking=yes/ConnectTimeout=10。docker system df -vの-vは共有/固有容量の詳細、ps -a --sizeは停止済みを含む書込層、stats --no-streamは一時点測定。du -xは別filesystemへ渡らず-mはMiB、--max-depth=1は上位集計。findはサイズ/時刻だけでログ本文を表示しない。journalctl --disk-usageは保持量だけ。manifest inspectはregistry metadataだけでpullしない。いずれも削除しない。

ローカルは`node --import ./examples/mysql/node_modules/tsx/dist/loader.mjs work/check-predeploy-database.mjs`。--importは既存TypeScript読み込み機能を使う指定。nodeがPC内専用fixtureを作り、正常/拒否/再作成/復元を検証する。失敗時はphase/安全な番号を報告し、今回の所有label一致の資源だけ片付ける。普段の開発DBや本番Dockerを指定すると拒否する。

不足容量/不明volume/不正CA/復元権限エラーが出た場合、権限を広げたりデータを消したりして通さない。原因を分けて修正する。削除や起動の実行コマンドは、対象を絞った承認後の作業案で再提示する。

参考（2026-11-16参照）：[EBS暗号化copy](https://docs.aws.amazon.com/ebs/latest/userguide/encryption-examples.html)、[snapshotからのvolume復元/同じAZ](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-restoring-volume.html)、[S3公開防止](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)、[S3のAPIと権限](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html)、[SSE-S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingServerSideEncryption.html)、[S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)、[MySQL dump](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html)。仕様参照は実AWSへの適用/復旧実証ではない。

## 9. 削除対象の再確認・暗号化の推奨と個別承認手順（2026-11-16）

### 9.1 今回の範囲と再確認した現物

22:47:04 JST（13:47:04 UTC）にSSHで読み取り。今回も本番削除/pull/起動/設定変更/AWS変更/push/切替なし。文書と学習ガイドだけ更新した。前段のローカル15＋3項目は今回再実行していない。

| 対象 | 完全なimage ID | 論理サイズ/固有領域 | image作成日時（JST） |
| --- | --- | --- | --- |
| 整理候補A・e0aa5cb版 | `sha256:04d3b36a25dcb25355e43d393149271847a89b605c333eca29f71eda12603389` | 1,285,978,706B／固有約1.059GB | 2026-11-01 23:38:41 |
| 整理候補B・16d10b2版 | `sha256:bf9dda4647e1b32954ea8cd834b2e4000427f43288250dd8e97681ee63e7aa1d` | 1,285,978,949B／固有約1.286GB | 2026-10-28 06:48:17 |
| 保持・現在ae3e31a版 | `sha256:d74947ec157c7f0523d95002c328b76e199d6defca2eadb613949770350dc868` | 1,285,988,141B | 2026-11-06 21:11:05 |
| 保持・直前8dd6fc2版 | `sha256:31b80a0e6ea8c8ba671ba1d32aa06be3a04dd5788df126813a291774f9aaa008` | 1,285,978,624B | 2026-11-02 00:53:18 |

作成日時はimage内のCreatedで、EC2への取得日時やGit commit日時とは違う。固有領域はDockerの集計で丸めを含む。GBは10億バイト、GiBは1,073,741,824バイトで区別する。

#### 削除の承認候補は次の4container＋2imageだけ

| image | コンテナ名 | 完全なcontainer ID |
| --- | --- | --- |
| A | `siteflow-backup-3002-1793548783` | `36d92b8410d46a319b9ed8c3c31d7e9d768590281ada504c82df8062b517776c` |
| B | `siteflow-backup-3001-1793545823` | `36e877f0240781d3b42deaeab5139b21cced30a06cdb283da4d64aaf8df644e8` |
| B | `siteflow-3001-pre-cd-backup` | `330e54de523a79c2716365b1cd857b063986846bd34ce5be524caec68b47de86` |
| B | `siteflow-3002-pre-cd-backup` | `bc19c9bd2f01f4bb62e6dfa7f43592b526ae4f3a3de9b260639746b87acb85c9` |

すべてexited、mountなし、SizeRw=0。必要なDB/ファイルをcontainer内だけで保存している形跡は、この調査範囲ではない。保持対象は現在の`siteflow-3002`、直前の`siteflow-backup-3001-1793967269`、保留の`siteflow-legacy-backup`と各image。Volume/cache/OSログ/ソース/証明書も削除対象外。

### 9.2 旧公開・復旧への影響を確認した根拠と限界

1. 公開中containerはimage d749、Nginxは127.0.0.1:3002。候補A/Bのimage/container IDとは異なり、候補は停止している。HTTPS200、Nginx設定hashは前段と同じ。
2. 旧CD timerはinactive/disabled。`state/deployed-sha`は現在のae3e31a版。check-update.sh/deploy.shのhashも前段と一致した。
3. `/etc/nginx`、`/etc/systemd/system`、`/usr/local/bin`、`/usr/local/sbin`、`/etc/cron.d`、既存repoの`.github`の文字列検索では候補名/短縮SHAの参照は見つからなかった。全filesystemや動的な参照を網羅した証明ではない。
4. CDディレクトリにはB版を指す`test-deployed-sha`/`.bak`と`siteflow-3001-backup.json`があった。後者はcontainer330eの過去のinspect記録で、保存時のState=runningを現在の稼働と誤解しない。既知の現行check/deployスクリプトにこれらのファイル名/候補名の直接参照はなかった。これらの履歴ファイルは残す。手動で当時の版へ戻す場合はimage再取得が必要になる。
5. 現在/直前/候補A/BのGHCR固定digest manifestを再照会し、4件とも参照成功。image層のpullや起動は未実施。GHCRの将来保持、再取得やアプリ復旧の成功までは保証しない。

**判断：今回定義した「現公開ae3と直前8ddへ戻せる」復旧方針には候補A/Bは不要。対象限定整理を提案できる。ただし実削除の無影響試験は未実施で、実行前の状態照合が必要。** 旧A/B自体のローカル即時起動はできなくなる。

実行承認後は、対象の起動条件（image/command/port/restart/必要なenv等）を権限0600の非公開記録へ保存し、秘密を含むinspect全文はdocsへ載せない。現在/直前版の記録も照合する。実行直前に停止・mountなし・書込0・参照関係が同じか再確認→対象4containerのみ除去→対象2imageのみ除去→HTTPS/現container ID/直前版/空き容量を確認する。`--force`、prune、volume削除は使わない。

削除したcontainer ID/実行履歴そのものは元に戻せない。imageはGHCRの固定digestから再取得できる可能性があるが、元のcontainer再作成には安全に控えた起動設定が必要。参照増加やID不一致なら中止し、削除に失敗しても強制を付けない。誤って現公開を停止/削除した場合の再作成/Nginx復旧も承認を得る別操作であり、「無条件に戻せる」とはしない。

### 9.3 EBS暗号化：推奨判断と比較

**提案：本番MySQLを初期化する前にroot EBSを暗号化する。** 現時点で業務DBがないため移すデータの整合性が単純で、後から移すよりDB停止/復元の負担を減らせる。rootの秘密設定・Docker保存領域もまとめて対象にでき、mount忘れによる誤初期化を避けやすい。暗号化を「EC2管理者から秘密を隠す機能」とは説明しない。root/Docker操作権限を持つ運用者は引き続き参照できる。

| 案 | 現環境への変更/停止の見込み | 復旧/注意 | 保存費の差の目安 |
| --- | --- | --- | --- |
| A：現20GiBを非暗号化で維持 | 停止不要。最も少ない変更 | 認証情報/SQLが非暗号化媒体へ保存される。架空データでも残るリスク。後日の移行が必要 | 追加0。ただしbackup費は別 |
| B：暗号化root20GiBへ置換 | root全体を交換。EC2停止が必須 | 旧rootを保持して戻せる。現容量の境界問題は残る | 新root月1.92ドル。重複保管中は旧20GiB分も月1.92ドル、snapshot別 |
| C：暗号化root30GiBへ置換（容量対策も同時に行う推奨候補） | Bと同じ交換＋filesystem拡張。20→30GiBも個別承認対象 | 起動後のpartition/filesystem拡張を実測確認。過去の小さいrootへデータをそのまま縮小して戻すことはできない | 新root月2.88ドル＝現状比＋0.96ドル。旧root保持中はさらに月1.92ドル |
| D：暗号化DB用10GiBを追加 | 別EBS/format/mount/Volumeのbind/起動順保護。通常はEC2停止不要の設計 | DBは暗号化されるがrootの秘密ファイル等は非暗号化のまま。未mount時は必ず起動拒否 | 月＋0.96ドル。root20GiBも継続 |

Cは**提案であり容量変更の承認を得ていない**。まず整理後の実占有を測って、Bの20GiBを維持できるか判断する。10GiB追加と30GiB rootは保存費だけなら同額増だが、Dはmount管理とroot非暗号化の課題が残る。EC2サイズはt3.smallを維持する提案で、さらに増強する計画ではない。

B/Cの停止枠は**仮に30〜90分、作業枠2時間**を確保する提案。実測した停止時間/保証値ではない。停止後の最新snapshot完了・暗号化copy・volume作成・起動・検証の待ち時間で延びる。手動承認の待ち時間も含め、別作業時間に旧サイトが一時停止することを事前に伝える。EIPは関連付け/確保を保ち、停止しても解放しない。HTTPS期限が停止中に切れたら、再公開前に更新を別途確認する。

B/Cの順序は、復旧情報と秘密設定backup→EC2停止承認→停止確認→最新snapshotを1件作成/完了→暗号化copy→同じAZのencrypted gp3 volume作成→旧root detach/保持→実際のRootDeviceNameへ新root attach→必要な終了時削除属性を個別承認で設定→起動承認→旧サイト/HTTPS/CD休止/Encrypted=true/容量を確認。各AWS操作をまとめて実行しない。root/VolumeId/AZは現EC2ロールで独立照会できない項目があるため、コンソールで対象を確認してから進める。

既存snapshotは今回のroot交換用に最新と決めつけず保持する。新root失敗時は停止承認→新root detach→旧root attach→起動承認で復旧し、新側で書き込みを受ける前に旧サイトを検証する。旧root/snapshotを消さない。XFSの同じUUIDを持つ旧新rootを同時mountしない。新側にDBデータができた後の切り戻しは別の整合性/損失判断が必要。

### 9.4 S3：実際に承認できる設定単位

対象はシドニーの専用bucket1個。既存bucketを探して無断利用しない。bucket名/role ARNは作成前に確定する。**以下は文書上のIAM仕様で、policy作成・適用・有料資源作成はしていない。**

| 項目 | 具体的な設計 |
| --- | --- |
| 非公開 | BlockPublicAcls/IgnorePublicAcls/BlockPublicPolicy/RestrictPublicBucketsをすべてtrue、BucketOwnerEnforced、ACL不使用 |
| 暗号化 | default SSE-S3（AES256）。bucket policyでPutObjectの`s3:x-amz-server-side-encryption`がAES256以外/未指定ならDeny。gzip→ageをEC2内でstream接続し、SQL/秘密の平文をEBSへ保存しない |
| 通信 | bucket policyでaws:SecureTransport=falseをDeny。Resourceは対象bucket ARNとその`/*`。HTTPでの本番送信試験は秘密を流さずpolicy評価で検査 |
| 世代 | Versioning=Enabled。キーはprefix/UTC日付/run-idで一意。DBの正規archiveとmanifestの両方が揃って成功とする |
| 保存期間 | dailyは最新成功7セット。新成功後だけ古いセットへDeleteObjectし削除マーカー化。dailyだけnoncurrentを30日で期限削除、期限切れ削除マーカーの掃除も限定設定 |
| 長期保護 | protected（公開/構造変更/休止前）とconfig（秘密設定）はlifecycle対象外。2027年1〜4月/希望時の再開確認後に削除対象と費用を再レビュー |
| 不完全backup | `.partial`はローカルの暗号文だけ。S3へ不完全品を成功名で送らない。archiveだけ転送済みでmanifest失敗の場合は成功に数えず、次回照合する。孤立版の整理を通常backupの一括削除に混ぜない |
| 実装の制約 | archive上限256MiB、single PutObject。`aws s3 cp`の既定multipartへ任せずSDK/CLIのPutObject相当を明示。上限超過なら中止して容量/権限を再設計 |

IAM（AWSの「誰に何を許すか」の規則）は次のResource/Action/Conditionに絞る。bucket ARNは`arn:aws:s3:::<対象bucket>`、object ARNはその後ろにprefixを付ける。

| 主体 | Action | Resource/Condition |
| --- | --- | --- |
| EC2 backup role | `s3:ListBucket` | bucket ARNのみ。`s3:prefix`を`daily/`・`daily/*`・`protected/`・`protected/*`・`config/`・`config/*`へStringLikeで限定。bucket全一覧は不要 |
| 同role | `s3:PutObject` | `daily/*`、`protected/*`、`config/*`。StringEqualsでSSE-S3 AES256を要求 |
| 同role | `s3:GetObject` | 上記3prefixだけ。HEAD/チェックサム照合・現行archive取得用 |
| 同role | `s3:DeleteObject` | `daily/*`のみ。成功7セットの整理用 |
| 同role・明示Deny | `s3:DeleteObject` | `protected/*`、`config/*`。誤った日次整理から保護 |
| 同role・明示Deny | `s3:DeleteObjectVersion` | bucket配下全体。特定の旧versionを消す権限は持たせない |
| 運用者の復元セッション | `s3:ListBucketVersions`、`s3:GetObjectVersion` | 前者はbucket＋必要prefix条件、後者は復旧する対象prefixのみ。対象VersionIdを記録して取得。EC2日常roleへ追加しない |
| 設定管理者 | bucket設定/lifecycle/IAM変更 | この導入時だけ別途承認。アプリやbackup処理には不要 |

PutObjectAcl/PutBucketPolicy/PutBucketVersioning/PutLifecycleConfiguration/DeleteBucket、他bucket、全S3権限はbackup roleへ追加しない。長期アクセスキーを発行せずinstance roleの短期認証を使う。既存roleに別の広いAllowがあれば追加policyだけで最小権限にはならないため、現在の関連policy/boundary/SCP等を読み取りレビューしてから最終JSONを提示する。今回は実IAMを独立検査していない。

Versioningは完全な改ざん防止ではない。運用管理者やlifecycleは旧版を消せるし、runtimeにPut権限があれば不要な版を増やすこともできる。サイズ/保存量/最終成功を監視し、Object Lockのような複雑な追加機能は初版に入れない。保護prefixの削除例外が必要なら、理由/対象VersionIdを別承認して運用者の権限で扱う。

#### 復元試験の手順・成功条件・失敗時

1. 導入前はローカルで架空dump→gzip→age→復号→別DB復元を一巡する。ageの固定版/公式取得物確認、復号鍵二重保管を確認。これはまだ未実施で、先の15項目はSQL/TLS/権限の試験だけ。
2. S3承認後、架空データの小さいarchiveをsingle PUT。SHA256/サイズ/AES256/VersionId/UTCを記録し、HEADと取得内容を照合。別prefix/bucketへの権限拡張はしない。
3. 検証用dailyキーの上書き/削除マーカー/過去version取得を試し、旧内容が戻るか確認する。この試験キーの作成/削除もS3導入承認に対象を明記する。protected/configのDeleteや旧version削除はpolicy simulation/拒否試験で検査し、大切なbackupを試験対象にしない。
4. 運用者が対象VersionIdを固定して取得、hash一致→age認証付き復号→gzip検査。復号鍵がなければ中止。未検証のSQLを本番DBへ流さない。
5. 元DBと異なる空の復元先を用意し、専用restoreユーザー/TLSでimport。元DBへの権限なし、既存tableがあれば拒否。全table/会議確認取消/履歴照合、復元session失効後に実アプリの再ログイン/権限/保存を検証する。
6. 元DB不変、元公開のまま、復旧所要時間と残る差分を記録する。成功しても接続先を本番へ勝手に切り替えない。hash/復号/権限/整合性の失敗は公開中止とし、元DBを残して調査する。

上の一巡を実測して初めてS3復元検証済みにする。RPO24h/RTO60分は継続目標であり、現在は未達成。

### 9.5 追加費用（22:48 JSTに公式公開料金を再確認）

通貨USD、シドニー、通常オンデマンド/Standard、税/割引/クレジット適用前。請求/残高は再照会していない。クレジット87.87ドル/推定80.63ドルは11月15日ユーザー申告のままで、追加費用を必ず賄えるとは判断しない。

| 項目 | 単価と試算 |
| --- | --- |
| gp3 | 0.096ドル/GB月（基準性能内）。20GiB＝1.92ドル、30GiB＝2.88ドル。追加10GiBまたは20→30の増分は0.96ドル/月 |
| 旧root保持 | detachしても課金継続。旧20GiBを7日残す目安は1.92×7/30＝0.448ドル。削除時期は別承認で、7日で自動削除しない |
| 標準snapshot | 0.055ドル/GB月。20GiB相当を全保存すると1件1.10ドル/月の予算。新規最新＋暗号化copyで2件なら最大20GiB相当ずつとして計2.20ドル/月の仮予算。増分/実保存量に依存し、df使用量や容量20から請求を確定しない。既存snapshot費は別 |
| KMS | AWS管理EBS keyを使用する案で顧客管理key新設の月額は避ける。KMS要求等の対象費用は利用条件を確認。KMS権限不足なら作成成功と扱わず中止 |
| S3 Standard保存 | 0.025ドル/GB月。日次7＋非現行30＋保護2＋設定1＝40個相当が各100MiBなら約3.9GiB、月約0.10ドル。各256MiBなら10GiB、月0.25ドル。再試行/重複版/保護世代増加は別 |
| S3リクエスト | PUT/COPY/POST/LISTは1000回0.0055ドル、GET等は1000回0.00044ドル。両方月1000回ずつでも約0.00594ドル。日次＋訓練を含む予算例で実利用回数ではない |
| S3暗号化 | SSE-S3の暗号化自体に追加料金なし。ageはソフトウェアで、処理時間/運用負担は必要。SSE-KMSの新規keyは今回導入しない |

S3初期予算は上記条件で月約0.11〜0.26ドル＋通信/増加分。EC2とS3を同regionに置く案だが、PCへの復元download/ネットワーク経路による料金は別に見積もる。NAT Gateway、新EC2、RDS、FSR、snapshot Archive、時間指定copyは作らない。月0.96ドルの増分は4か月なら3.84ドルで、年内/休止中もEBS保持は課金される。

料金根拠：[S3 Sydney公開料金JSON](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-southeast-2/index.json)（publicationDate 2026-11-16T07:13:00Z）、[EBS公開料金JSON](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ebs.json)、[S3料金](https://aws.amazon.com/s3/pricing/)、[EBS料金](https://aws.amazon.com/ebs/pricing/)、[KMS料金](https://aws.amazon.com/kms/pricing/)。AWS公開JSONはPCから参照しただけで認証付きの課金APIは使っていない。

### 9.6 整理後に必要な容量と公開の最低条件

今回の`df -B1 /`は全21,395,124,224B、空き7,616,745,472B（約7.09GiB）。候補A+Bの固有約2.345GBを解放できれば約9.28GiBになる推計。共有層/丸めで実際は変わる。

| 予算 | 目安/条件 |
| --- | --- |
| 最後まで残す空き | filesystemの25％以上。この20GiB rootでは約5GiB |
| 新image | 前段のNext/MySQL/migration論理合計約2.32GiB。共有層差引前、追加実占有未測定 |
| DB・一時DDL | 初期1GiBを確保する仮予算。試験Volume約213.5MiBを本番の最大値としない |
| ログ・暗号化backup等 | 初期0.5GiBの仮予算。上限/世代/backup失敗時の増加を実装・確認 |
| pull/展開等の一時領域 | 追加0.5〜1GiBを仮置き、実取得サイズで見直す。通常更新では新Next世代の分も必要 |

上記は合計約9.3〜9.8GiBの開始前空きを要する仮計算なので、**当面の取得開始ゲートを空き10GiB以上**とする提案。実測に基づく計画変更は可能だが、今回の整理推定9.28GiBだけで自動合格にはしない。30GiB化ならfilesystemも拡張できたことを確認し、その25％（約7.5GiB）を最後まで残す。容量が増えた分を全部消費してよいわけではない。

20GiBを維持する場合は取得対象の圧縮/展開ピークと共有層を再計算するか、local-only1.0等のEC2外退避/必要性を別調査し、新しい対象限定整理案を別承認する。一括pruneで10GiBへ合わせない。image取得・DB初期化・migration・復元・新旧切替の各段階で空き/inodeを再計測し、予算超過なら止める。

最低条件は次のすべて。文書への記載だけで達成とはしない。

- 保存先：選択した暗号化方針を承認/実施/検証し、volume所有label/ID/起動時mountを照合。現在rootは非暗号化のまま。
- 復旧：現公開/直前版と起動設定を保持、SQL＋秘密設定のEC2外暗号化backupと別DB復元を検証。S3/ageは未実施。
- DB：3306を公開しない、CA/SAN/TLS、CRUD/DDL/backup/restore分離、固定auth secret、正常停止猶予/ログ上限/初期化保護。保護設定の変更は未承認。
- メモリ：t3.small/RAM1909MiB、MySQL512MiB/Next384MiB/旧Vinext192MiBを初期候補。旧公開＋候補Next1＋DBまで、migration/backup/復元と増台を重ねない。15分/5人/21案件以上/保存・会議込みでOOMなし、available200MiB以上を目安に維持、継続swap増なし。CPU credit/Unlimitedも確認。
- 公開：本番candidateのready/認証/権限/会議/拒否条件/HTTPSを確認、期限内証明書と更新経路、自動配信承認/pauseと復旧手順。決定事項/招待/進捗差分を完成扱いしない。

### 9.7 個別承認する作業順（今回はすべて計画）

| 順 | 承認単位/変更するもの | 失敗時/元へ戻す方法 |
| --- | --- | --- |
| 1 | 整理対象の起動設定を秘密保管し、表の停止4containerだけ除去 | container ID自体は戻せない。設定から再作成が必要。現公開に触れない |
| 2 | 再照合後、表の古い2imageだけ除去 | 固定digest再取得が必要。現/直前imageを残す。失敗時は強制しない |
| 3 | 空き/公開を読み取り再確認し、20GiB維持か暗号化30GiB案を選択 | 10GiB開始ゲート未達なら取得/DB起動へ進まない |
| 4 | 暗号化を選んだ場合、停止前の復旧情報/秘密設定backupを作成・搬出 | 不完全なら止める。backupの実値をGitへ入れない |
| 5 | 同EC2を停止 | 公開停止。EIP保持、起動は別承認 |
| 6 | 停止したrootの最新snapshot1件を作成 | 完了不明なら重複作成せず確認。旧snapshot保持 |
| 7 | 新snapshotの暗号化copyを1件作成 | 失敗なら元を保持、KMS権限/状態を調査 |
| 8 | 承認した容量20/30GiBでencrypted gp3を1個作成 | 同じAZ/暗号化/容量確認。旧root保持。不要になった新volumeの削除も別承認 |
| 9 | 旧rootをdetach | 停止中だけ。旧VolumeId/実RootDeviceNameを記録。戻す場合のattachも別承認 |
| 10 | 新rootを同じdeviceへattach | 誤った接続なら起動せず照合。終了時削除属性の変更は対象を明記して別承認 |
| 11 | EC2起動 | 旧公開/HTTPS/CD休止/EIP/暗号化/容量を検証。30GiBのfilesystem拡張が必要ならコマンド/影響を別承認 |
| 12 | S3 bucket1個の作成と、公開防止/Versioning/暗号化設定 | 各設定を読取照合。失敗ならbackup成功にしない。bucket削除で戻す操作は別承認 |
| 13 | 対象bucketだけのIAM/bucket policyを適用 | policy単位の旧設定を保管、認証拒否時は戻す差分を提示。全権限へ広げない |
| 14 | daily限定の30日noncurrent lifecycle設定 | 自動の永久削除を伴うため独立承認。protected/configを含めない。削除済み旧版は戻せない |
| 15 | age/backup/復元処理とCompose/mysql.cnf/release等のローカル差分を実装・検証 | ファイルごとの目的/差分/復旧を提示。別承認なしに本番へ配布しない |
| 16 | ホストへ承認済み設定/証明書/固定秘密を配置 | 旧サイトへ影響させず権限/期限を確認。既存秘密を再生成して上書きしない |
| 17 | 固定digestのimageを取得 | 空きゲート/実占有を確認。pullは有料通信/保存の影響があり別承認 |
| 18 | 専用network/Volumeの作成 | 所有label確認。空でもvolume削除は通常復旧に含めず別承認 |
| 19 | MySQLを初回明示起動・ユーザー権限設定 | 失敗なら停止の範囲を確認して旧公開維持。dataを消してやり直さない |
| 20 | migrationを専用userで適用 | DDLは一括で戻せる保証なし。履歴/実構造を確認、旧Vinextを維持 |
| 21 | S3 backup/別DB復元試験、必要なtimer/監視設定 | 本番DB上書きなし。復元先の削除や自動設定も承認範囲を明示 |
| 22 | Next候補をloopback3001へ配信し負荷/認証を検証 | Nginxは旧3002維持。候補停止/再作成は対象限定承認 |
| 23 | GitHub設定/保護されたCI差分の反映・Git push | pushだけの承認を本番切替へ流用しない。旧CDは休止、新配信もpauseを確認 |
| 24 | 本番Nginxの転送先を候補へ切替 | 失敗時は同じ承認範囲に明示した旧3002への復帰。DBは戻さない |
| 25 | 本番合格後の旧Vinext停止/通常配信開始 | 別承認。旧image/起動設定は保管。停止再開試験/長期休止もさらに別承認 |

順12〜15などはローカル実装/暗号化準備の都合で前後できるが、依存する検証を飛ばさない。1回の「はい」でこの表全体を実行しない。今の最小の次作業は、順1の対象4containerと非公開起動設定保管の範囲をレビューし、その操作だけを承認してもらうこと。

### 9.8 今回のコマンドの意味と確認範囲

- SSH：既存鍵＋BatchMode=yes（対話待ちしない）、StrictHostKeyChecking=yes（登録host鍵を検証）、ConnectTimeout=10（接続10秒上限）。コマンドは読み取りだけを送信。
- `docker image inspect --format`：指定imageのID/Created/Size/タグ/digestだけ出す。`docker inspect --size --format`：containerの参照/mount/書込層/port等だけでenvは出さない。`docker ps -aq`：停止済みも含むID一覧。`docker system df -v`：共有/固有容量の詳細。起動/削除はしない。
- `df -B1 /`：rootの容量/空きをバイト単位で取得。`free -m`：RAM/swapをMiB表示。`grep -RIlE`：再帰/バイナリ除外/一致ファイル名だけ/拡張正規表現で依存先候補を探す。ログ/設定本文を無差別表示しない。
- `sha256sum`：既知スクリプト/設定の指紋を照合。`docker manifest inspect`：GHCRのmetadataだけ照会してlayersは取得しない。固定digest4件の成功/失敗だけ表示。
- `curl --fail --silent --show-error --max-time 10 --output /dev/null --write-out`：HTTP失敗を非0、進捗は隠しエラーは出す、上限10秒、本文を保存せずstatusだけ出す。TLS検証は有効のまま。
- `Invoke-RestMethod -Uri`：AWS公開料金JSONをPCのメモリへ読み、シドニーの該当単価だけ選択。AWS認証情報不要、リソース作成/料金API変更なし。

今回の限界：実削除後の空き/旧版復旧、EBSの暗号化/起動、S3実権限/復号/保持、実機DB/負荷はまだ未実施。削除の可否は上の条件付き判断であり、実運用の無障害保証ではない。

## 10. 承認された停止4コンテナの整理結果（2026-11-16）

### 承認範囲と実行結果

ユーザーは「報告済み4件と一致し、保存mount/書込dataなしを再確認できた場合だけ削除」を承認した。**今回の削除対象は以下の4containerのみ。image/Volume/現公開/直前版は削除していない。**

| 削除したcontainer ID（短縮。完全IDは9.1節） | 名前 | 保持したimage |
| --- | --- | --- |
| `36d92b8410d4` | `siteflow-backup-3002-1793548783` | `04d3b36a25dc` |
| `36e877f02407` | `siteflow-backup-3001-1793545823` | `bf9dda4647e1` |
| `330e54de523a` | `siteflow-3001-pre-cd-backup` | `bf9dda4647e1` |
| `bc19c9bd2f01` | `siteflow-3002-pre-cd-backup` | `bf9dda4647e1` |

23:07 JSTに事前保存、23:08:01 JST（14:08:01 UTC）に削除後の検証完了。containerの停止/強制削除/再起動はせず、既に停止しているIDだけへ`docker rm <完全ID>`を1件ずつ実行した。

### 実行直前に満たした条件

- 全7containerのID集合が候補4＋保持3と完全一致。候補の名前/参照image完全IDも9.1節と一致し、全4件exited/Running=false。
- Mounts/Binds/Tmpfs/宣言Volumeなし、SizeRw=0、`docker diff`が空（書込層のファイル差分なし）。保存用volumeとcontainer書込dataを失う状態ではない。
- 共通起動条件はentrypoint `docker-entrypoint.sh`、command `node node_modules/vinext/dist/cli.js start`、作業dir `/app`、restart unless-stopped、既定bridge、memory192MiB/memorySwap384MiB。AとBのbc19はloopback3002、Bの残り2件はloopback3001。環境変数4件の値は非公開保存しdocs/出力へ載せない。
- 削除前後に現公開/直前/保留版のID・image・Config/HostConfig/mount・Status/StartedAt/portを照合。削除の各1件直前にも保持対象と対象の条件を再照合した。
- Nginx設定hashは既知値と一致、旧CD timer inactive/disabled、service inactive、HTTPS200。

### 復旧情報の安全な保存

保存先は**EC2側**の`/var/backups/siteflow-container-cleanup/20261116T140723Z-a7201bd6/`。ローカルrepo/公開URLではない。所有root、専用dir0700、ファイル0600、umask077で新規排他作成した。親dirもroot所有/他ユーザー書込不可/symlinkでないことを確認した。

削除前に12ファイルを作成：対象4件の完全inspect＋各Config/HostConfigのcreate用payload（8）、保持3件のinspect（1）、全6imageのinspect（1）、復旧注意（1）、baseline/hash台帳（1）。ファイルの書込flush/fsync→読み戻し一致、削除前にhash/権限照合を実施。その後各削除の完了記録4件と最終result.jsonも保存した。秘密を含み得るinspect全文は画面/Git/docsへ出していない。

この保存は既存の**非暗号化root EBS上**の権限制限された記録で、暗号化backup/EC2外災害backupを作った意味ではない。S3/ageは導入していない。以前のsnapshotと古い履歴JSONも保持。

復旧時は別承認で、保存したConfig/HostConfig/inspectのnetwork設定を確認し、残したimageから新しいcontainerを作る。元のcontainer ID/ログ/実行履歴は再現できない。create payloadはそのままシェル実行するファイルではない。現在使っている3001/3002のportを確認し、重複起動しない。実再作成試験は今回実施していない。

### 削除後に確認できたこと

| 対象 | 結果 |
| --- | --- |
| 公開中 | `siteflow-3002` / `3d97924314a0` / ae3e31a版はrunning。ID/設定/StartedAt/portは不変 |
| 直前の復旧版 | `siteflow-backup-3001-1793967269` / `dee26e30f6ca` / 8dd6fc2版はexitedのまま保持、設定不変 |
| 保留版 | `siteflow-legacy-backup` / `44838c58ec71` / local1.0はexitedのまま保持、設定不変 |
| コンテナ数 | 7→3。指定4件だけがなくなった |
| image | 全6image ID集合が前後一致。候補A/Bも残存 |
| Nginx/CD | hash不変、timer inactive/disabled、service inactive。設定編集/reloadなし |
| HTTPS | EC2から通常の証明書検証付きで200、その後PC側のcurl.exeからも200。アプリを再起動していない |
| root空き | 前7,616,651,264B→後7,616,921,600B（どちらも約7.09GiB/使用65％）。ログ/metadata等の変動込みで＋270,336B。2.345GB解放した結果ではない |

イメージを保持したので大きな容量増はまだない。約9.28GiBになる予測は将来のimage2件削除を含む案で、今回の達成値とは区別する。取得前10GiB/本番DB/負荷の公開条件は未達成。

### コマンドの目的・影響と失敗時

SSHは既存鍵、BatchMode=yes/StrictHostKeyChecking=yes/ConnectTimeout=10。`sudo -n python3 - prepare`はrootで安全確認と専用backup作成（-nは対話待ち拒否、-は標準入力の専用コード）。`delete <保存dir>`はbackupのhashを検査してから承認されたIDだけを除去し、結果を同dirへ記録する。helperはローカルGit対象外`work/cleanup-approved-containers.py`で、EC2の配信scriptを編集/配置していない。

`docker inspect --size`は書込層を測り、`docker diff`はimageからの差分を読む。`docker rm <ID>`は停止containerの記録/ログ/書込層を除去するが、image/volumeは除去しない。`--force`/`-v`/pruneは使わない。条件不一致なら削除前に中止し、途中失敗ならそれまでの個別完了記録を残す。強制実行・他対象への拡大・自動再試行をしない。今回は4件すべて正常終了した。

今回未実施：image2件の削除、EBS暗号化/容量/停止起動、S3/IAM、MySQL/Next.js起動、Git push、本番切替、旧container再作成。次に検討するのは、残った候補A/Bの参照0と復旧情報を読み取り再確認し、**image2件だけの削除を別承認**すること。

## 11. 候補起動を優先したローカル実装と検証

### 方針と変更したファイル

既存試験15＋3項目と停止4件整理を引き継ぎ、同じ実機照会や復元負荷を繰り返さず、今回変更する設定と新しい候補確認ツールを検証した。ユーザーの「ローカル実装/テストはまとめて進める」に基づく限定変更で、本番配置を許可されたわけではない。

| ファイル | 今回の役割・理由・影響 |
| --- | --- |
| deploy/compose.production.yaml | 新MySQL/Nextのlog上限10MiB×3、DB停止猶予60秒/app30秒、認証したSELECT 1のhealthcheck、appのHOSTNAME/PORTを明示。既存Docker daemonや旧containerには適用されない |
| deploy/mysql.cnf | skip-log-binを追加。初版はSQL backup単位の復元で任意時刻復旧/PITRは提供しない。redoを無効化する設定ではない |
| deploy/release.sh | docker run側にも同じapp log上限と停止猶予。既存の承認/rollback制御は変更しない。ローカルsourceのみ |
| deploy/start-database.sh | 追加EBSモードではmountpointとNVMe serial/指定VolumeId、external volumeのdriver/type/options/deviceを照合。未mount/別媒体/誤bindならDBを起動しない |
| scripts/check-candidate.mjs | SSH tunnelのloopback HTTPだけを対象に、readiness/認証拒否/login/案件取得/logoutを確認。別の書込許可なら専用架空案件の作成/進捗25％/再取得。秘密や応答本文を出さない |
| scripts/check-deploy-config.mjs・tests/candidate-check.test.mjs・tests/deploy.test.mjs | 追加設定の解析、外部送信防止/書込許可/認証失効、未mount/VolumeId/誤bindの拒否を検証 |

健康確認は「DBプロセスがいる」だけでなく「root秘密でSQLを実行できる」を示すが、CA/SANやschema/業務権限の完了を示さない。後者は実Next側のreadiness/権限試験で別に見る。ログ上限は古い世代を自動で入れ替えるため、長期監査ログの保存策とは区別する。

### 今回の検証結果

| 検証 | 実測結果・限界 |
| --- | --- |
| 新候補ツールのunit test | 4件成功。承認なし/外部URL/非HTTPS Origin/実在形式emailを拒否、書込は別許可、redirectは追わずPOST再試行なし、ログアウトと秘密非出力 |
| Compose config | 既存5分類の検査成功。追加のlogging/停止猶予/SQL healthcheckも実Compose解析結果から確認 |
| 実MySQL Compose起動 | 6項目成功。実mysql.cnf/TLS/512MiB、認証healthcheck正常/誤秘密拒否、3306非公開、log10m×3/停止60秒、binlog0/secure_transport1、正常停止ExitCode0/OOMfalse |
| Linux配信保護 | 既存のcached deploy-check imageに今回sourceをread-only mountして48件成功。起動guard追加後は構文とDB起動だけ12件成功（うち新規EBSケース4件、残りは関係する再検証）。実EBSのmount/再起動試験ではない |
| 実Next＋TLS MySQLで新ツール使用 | readiness/未認証401、login/案件取得、新規架空案件の作成/進捗25％保存/再取得、logout/旧session401の4分類成功。cached appを再利用、架空DBを使用。AWS/browser/Nginx経路は未試験 |
| 通常チェック | npx.cmd tsc --noEmit成功、業務ルール42件成功、npm.cmd run build成功。schema変更なし。fixtureだけ片付け、通常開発DBを対象にしない |

ローカル結果はGit対象外の`work/production-mysql-config-results.json`と`work/candidate-next-check-results.json`。SQL/パスワード/Cookieは記録しない。

#### 試験で止まった点と修正

1. Windows bind mountの.cnfがworld-writableと扱われ、MySQLが無視したためbinlog1/secure_transport0になった。PC用試験だけ同じ.cnfをcontainer内mysql所有/0600へcopyして再試験成功。本番はroot所有0644のread-only bindを予定し、Linuxの実所有/権限と実SQL値を確認する。Windowsの試験用entrypointを本番設定へ入れていない。
2. 候補ツールがlogin応答にuser IDを期待して実接続試験に失敗。SiteFlowは安全のためlogin JSONを{ok:true}へ縮小する仕様なので、別のget-sessionからIDを取得するようツールを修正。unit mockも実仕様に合わせ、実Nextで再試験成功。アプリの認証応答は変更していない。

### 最短経路の保存先と残る条件

旧公開を維持するため、EC2停止を伴うroot交換より、**暗号化gp3 10GiBをDB用に追加**を今回推奨する。採用/作成は未承認。root上の秘密設定は非暗号化のままで、そのリスクと別の暗号化backupが必要。MySQLデータだけを暗号化してroot暗号化完了とは説明しない。

追加EBS用のhost設定では`SITEFLOW_MYSQL_DATA_MOUNT=/srv/siteflow-mysql`と新規`SITEFLOW_MYSQL_EBS_VOLUME_ID`を必須にし、bind volumeのdeviceを`/srv/siteflow-mysql/mysql`へ限定する。root側の未mountディレクトリにmysqlサブdirを作らず、Docker再起動時に未mountなら代わりの空dataで起動しないことも実機で確認する。fstab/起動順の本番変更は承認Bに含める。今回のmock合格でこの実機条件まで合格にしない。

rootの取得前8.5GiB（DBを別EBSに置く前提）/配置後25％、data EBSも25％、実機負荷/backup/鍵権限は未達成。旧2image整理後の実空きで判断する。月0.96ドル増は前段の単価による見積で今回料金照会は繰り返していない。

本番backup/age/秘密設定の暗号化搬出・テストaccountの安全な発行は残実装。S3自動化を候補の前提から外しても、EC2外backupと空の別DB復元は承認Cの必須項目として残す。以前のローカル復元15項目は手順の根拠で、本番復元が終わった意味ではない。

### 候補確認コマンド（将来・未実行のAWS向け例）

```sh
ssh -i ＜既存の秘密鍵ファイル＞ -N -L 127.0.0.1:17301:127.0.0.1:3001 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes ec2-user@13.237.188.172
node --env-file=＜Git対象外の候補確認用envファイル＞ scripts/check-candidate.mjs
```

SSHの-iは既存鍵、-Nはremote commandを実行しない、-LはPC17301→EC2 loopback3001の転送、ExitOnForwardFailureは転送できなければ終了、StrictHostKeyCheckingはhost鍵照合。プロセスを閉じると転送は終わる。EC2のport/SGを外へ開かずNginxも変えない。

Nodeの--env-fileは秘密設定を指定ファイルから読む。設定は明示確認許可yes、接続先http://127.0.0.1:17301、実公開HTTPS Origin、架空email/生成済み秘密/専用team ID。既定はread/login/logoutで、SITEFLOW_CANDIDATE_WRITE_APPROVED=yesのときだけ新規のテスト案件1件/進捗履歴を書き残す。失敗時も自動再POST/既存案件の削除はしない。生成した案件は試験記録として残すため、次回再実行時に重複を確認する。

この検査はSecure Cookieをメモリ内で扱うAPI試験。SSH経路の暗号化とブラウザーHTTPSの確認は別であり、公開/ブラウザーの確認を代替しない。

今回の実行：node --testはtest実行、--importは既存tsxでTypeScript fixtureを読み込む、docker run --rmは終了後の試験container回収、--pull=neverはcached imageのみ、--network noneは配信mockの外部通信なし、--mount readonlyはsourceを試験に読み取り提供。Composeは専用project/network/volumeで起動し、stop --timeout60で通常終了、down後に所有labelが一致する試験volume/networkだけ回収した。npx tsc --noEmitは型だけ検査、npm run buildはPrisma生成＋Next production buildでローカル生成物を更新する。

参考：[Compose healthcheck/stop/logging](https://docs.docker.com/reference/compose-file/services/)、[Docker JSON log上限](https://docs.docker.com/engine/logging/drivers/json-file/)、[MySQL binary log](https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html)（2026-11-16参照）。仕様参照だけで本番達成済みにはしない。

## 12. 承認A：旧2イメージの整理結果（2026-11-17）

ユーザーの「まずA」の承認に従い、11月17日05:52:36〜05:52:39 JST（11月16日20:52:36〜20:52:39 UTC）に容量整理だけを実行した。**削除は次の2imageだけ。B以降は実行していない。**

| 削除した完全image ID | 保持した再取得先（固定digest） |
| --- | --- |
| `sha256:04d3b36a25dcb25355e43d393149271847a89b605c333eca29f71eda12603389` | `ghcr.io/syucream02/siteflow@sha256:8d0f09a69c479af521b1710eebf3965d4ac7a210a11d685ada49a65daa3222eb` |
| `sha256:bf9dda4647e1b32954ea8cd834b2e4000427f43288250dd8e97681ee63e7aa1d` | `ghcr.io/syucream02/siteflow@sha256:04d46321d0c88c45c96848d81593d5beab192de668c9f5cc28b0ea930ec47652` |

### 条件照合・保存・実行方法

- 既存のroot専用復旧dir/ファイルの所有権・0700/0600・hashを検査し、対象imageの完全ID/タグ/digest/Created/Sizeが保存記録と一致することを確認。現在の全6image集合も以前の記録と一致。
- 停止済みを含め候補imageを参照するcontainerが0件。残る3containerは現公開/直前/保留の正しいID/image/statusと照合し、設定/port/StartedAt等を削除前後で比較した。
- 対象2件のGHCR manifestを照会し成功（pull/復元ではない）。Nginxhash・旧CD休止・HTTPS200を事前確認。
- 新しい作業記録をEC2側の`/var/backups/siteflow-container-cleanup/20261116T140723Z-a7201bd6/image-cleanup-20261116T205236Z-e9488733/`へroot専用で保存。事前状態・各削除結果・最終result.jsonを排他作成/読み戻し。復旧用の親dirと旧履歴/既存snapshotはそのまま残した。
- 完全ID指定の`docker image rm <ID>`を1件ずつ実行。各直前にも参照0/保持3container/タグとdigestを照合。force/prune/container削除/Volume削除はなし。

### 削除後の実測

| 確認対象 | 結果 |
| --- | --- |
| image集合 | 全6→4。対象2件だけがなくなり、現在d749/直前31b/local1.0/hello-worldを保持 |
| 公開中container | `siteflow-3002` / `3d97924314a0` / d749はrunning。ID/設定/StartedAt/port不変 |
| 直前の復旧container | `siteflow-backup-3001-1793967269` / `dee26e30f6ca` / 31bはexitedのまま保持、設定不変 |
| 保留container | `siteflow-legacy-backup` / `44838c58ec71` / local1.0はexitedのまま保持、設定不変 |
| Nginx/CD | 設定hashは既知の2c874b...595と一致、timer inactive/disabled・service inactive。編集/reload/再起動なし |
| HTTPS | EC2側200、その後PC側curl.exeも通常TLS検証付き200 |
| root空き | 7,614,701,568B（7.09GiB）→10,408,456,192B（9.69GiB） |
| 使用率/差分 | 65％→52％、df差分は2,793,754,624B（約2.60GiB）。個別imageごとの解放量ではなくfilesystem全体の測定差分 |

DBを別EBSへ置く最新計画のroot取得前8.5GiB目安は、この時点では満たす。まだimage取得/展開/DB配置をしていないため配置後25％・実機メモリ・backup/復元・起動の合格ではない。旧root一体案の10GiB条件と前提を混同しない。

復旧時は残した非公開起動設定と上の固定digestからimageを再取得し、必要なら別承認でcontainerを作成する。再取得/実起動の復元試験は未実施。現在/直前の復旧版はEC2内に残るため、今回の通常復旧方針は維持している。

### 使用コマンド・影響・失敗時の扱い

SSHは既存鍵/BatchMode=yes/StrictHostKeyChecking=yes/ConnectTimeout=10。sudo -n python3 -は管理権限で今回専用のコードを標準入力から実行し、対話待ちしない。helperはGit対象外の`work/cleanup-approved-images.py`で、既存deploy scriptを編集していない。

docker ps -aq --no-truncは全containerの完全ID、--filter ancestorは対象imageの参照確認、image inspectはID/タグ等の照合、manifest inspectはregistry metadataのみ、image rmは指定image/関連layerの除去。df -B1はバイト単位の空き。curlの--fail/--silent/--show-error/--max-time/--output/--write-outは失敗判定・表示抑制・エラー表示・時間上限・本文破棄・status表示。TLS検証は無効化しない。

条件不一致や途中失敗なら完了済みの記録を残して中止し、自動再試行/forceや対象拡大はしない。今回は2件とも成功。削除したimageの元の保持状態をそのまま戻す操作ではなく、必要時の再取得が復旧方法。

未実施：BのEBS作成/接続/format/mount、EC2停止/サイズ変更、S3/IAM、MySQL起動、Next候補配信、Git push、Nginx切替。次はBを別途承認してから進む。

## 13. B準備：EBS作成値と画面別手順（2026-11-17）

### 読み取りで確認できた値

2026-11-17 06:01:04 JST（11月16日21:01:04 UTC）、SSH/IMDSv2/lsblk/findmntのみ。作成/接続/format/mount/設定変更なし。既存SiteFlowは同じae3 image/127.0.0.1:3002、HTTPS200、旧CD inactive/disabled。

| 項目 | 確認値/根拠 |
| --- | --- |
| EC2 | `i-04201e271c824ac02`、IMDSv2のinstance-id一致 |
| region/AZ | `ap-southeast-2` / **`ap-southeast-2c`**、IMDSv2のplacementから実測 |
| 既存root EBS | `vol-042befaf03ffe5cb7`、OS serial `vol042befaf03ffe5cb7`、ディスク20GiB |
| AWS root device / OS実体 | AWS metadataは`/dev/xvda`、OSは`/dev/nvme0n1`。rootは`/dev/nvme0n1p1`のXFS、EFI用vfat partitionもある |
| 既存root属性 | gp3/非暗号化/終了時削除はい、は11月16日のユーザーconsole確認。今回OSの読み取りだけで暗号化を独立確認した意味ではない |
| 他のdisk | 今回lsblkではroot diskのみ。追加予定のEBSはまだ見えない |
| 追加用path/fstab | `/srv/siteflow-mysql`自体なし、mountなし、fstab内の同path記載なし |
| filesystemツール | `/usr/sbin/mkfs.xfs`存在。実行していない |

AWS上の詳細属性を読むEC2 roleの制限は前段で確認済みのため、同じDescribe拒否を再試験せず、今回必要なAZ/OS構成だけを取得した。未確認はconsole上で再照合する。

### EBS作成画面へ入力する設定

| UI項目 | 入力/選択値 | 目的・注意 |
| --- | --- | --- |
| region | アジアパシフィック（シドニー）`ap-southeast-2` | 別regionへ作らない |
| ボリュームのタイプ | 汎用SSD **gp3** | io2等の高価な別タイプへしない |
| サイズ | **10GiB** | DB専用。root20GiBは変更しない |
| IOPS | **3000** | 基準性能を使う案。値を増やさない |
| throughput | **125MiB/s** | 基準値の案。UI値や追加料金表示が異なる場合は作成せず確認 |
| AZ | **`ap-southeast-2c`** | EC2と一致が必須。regionだけ同じではattachできない |
| snapshot ID | 選択しない/空 | 空の新規DB disk。既存root snapshotから作らない |
| 暗号化 | **有効** | チェック/状態を明示確認。account全体の既定暗号化は変更しない |
| KMS key | **`alias/aws/ebs`**（AWS管理EBS key） | customer managed keyを新規作成しない。選択できない/権限エラーなら中止 |
| タグName | `siteflow-mysql-data` | 一覧で識別。タグ自体は暗号化/権限制限ではない |
| 追加tag | `Project=SiteFlow`、`Purpose=production-db` | 新規対象の照合用。秘密や個人情報は入れない |

見積は前回確認した単価0.096ドル/GiB月なら**10GiB＝月0.96ドル**（税/別backup/通信等を除く）。作成した後は未attachでも保存費がかかり、EC2停止中も無料にならない。今回価格/残高を再照会していない。終了時削除属性は作成画面で全部決まる項目ではなく、attach後のEC2 block mappingで新EBSだけ「いいえ」を確認する案。既存rootの属性を変更しない。

### AWSコンソール：画面ごとの案内

**画面1・EC2対象確認（読み取り）**

AWSコンソール右上をシドニー→EC2→インスタンス→`i-04201e271c824ac02`を選ぶ。「詳細」のAZがap-southeast-2c、「ストレージ」のroot volumeがvol-042befaf03ffe5cb7/20GiBであることを照合する。停止/再起動/ストレージ変更は押さない。IAM等により項目が見えなければ、その時点で止める。

**画面2・新規EBSの入力（まだ作成しない）**

EC2左メニュー→Elastic Block Store→「ボリューム」→「ボリュームを作成」で入力フォームを開く。前表のgp3/10/3000/125/ap-southeast-2c/暗号化/aws/ebs/タグを入力する。画面遷移と入力だけでは作成完了ではない。**最終の「ボリュームを作成」ボタンを押すのは、作成1件の承認後。** 表示が表と違う場合、推測で別設定を選ばない。

**画面3・作成承認後の完了確認（今は未実施）**

承認後に1回だけ作成し、一覧/詳細で新しいVolumeId、Name、10GiB/gp3、ap-southeast-2c、Encrypted=true、KMS alias、state=`available`を確認する。creating中/結果不明なら再作成せず待って確認する。availableは「空diskが準備できた」で、MySQLが保存可能/backup済みという意味ではない。**作成後も「ボリュームのアタッチ」は押さず停止**し、新VolumeIdと確認結果を伝えて次の承認へ進む。

### アタッチ以降に使う確定方針（未承認・未実行）

| 項目 | 方針 |
| --- | --- |
| AWS上のattach device名 | **`/dev/sdf`を候補**。attach直前にEC2「ストレージ」で未使用を確認。rootの`/dev/xvda`や既存名を指定しない |
| OS上のdevice名 | `/dev/nvme1n1`等になるが順序は保証されない。**新VolumeIdとNVMe serialを照合して特定**し、名前だけでformatしない |
| filesystem | 新disk全体へXFSを作る案。10GiBの新VolumeId/未mount/未format/未使用/rootではないことを照合し、formatだけを個別承認。既存の署名が見つかれば再formatしない |
| mount先 | `/srv/siteflow-mysql`。UUID（filesystemの固有ID）で自動mountし、NVMe番号をfstabへ固定しない |
| DBの実data path | mount後だけ作る`/srv/siteflow-mysql/mysql`。このdirをexternal Docker volume `siteflow-production-mysql`のdeviceへbindする |
| container内data path | 上のvolume→`/var/lib/mysql`。containerを作り直しても追加EBS上のdataを使う |

```text
MySQL /var/lib/mysql
        ↓ Dockerの外部管理volume（bind）
/srv/siteflow-mysql/mysql
        ↓ /srv/siteflow-mysql は新filesystemのmountpoint
追加EBS 10GiB・暗号化あり・ap-southeast-2c
```

Dockerの通常named volumeをrootへ作るだけでは新EBSへ保存されない。Volume.Options.device/実findmnt/VolumeId/UUIDを照合し、後日CでSQLを保存→再読込→保持を実測する。今回作成前なので、この保存経路が実機で合格したとは扱わない。

### 再起動時の自動mountとDB起動防止

`/etc/fstab`は承認後にbackupを取り、新filesystemのUUIDの1行だけを追加する案。形式は次の**未適用の例**。

```fstab
UUID=<新EBSのfilesystem UUID> /srv/siteflow-mysql xfs defaults,nofail,x-systemd.device-timeout=10s 0 0
```

UUIDは新diskの識別、xfsはfilesystem、defaultsは通常mount、nofailはDB disk不在でも旧サイト用OSのbootを妨げない、device-timeout=10sは待ち時間上限、末尾0/0はdump/起動時fsck検査を省く指定（XFS用）。誤ったfstabはbootに影響し得るので、対象のmount検証とbackup復帰を確認する。全filesystemへ一括mountし直すより、今回追加したmountpointだけを対象に検証する。

**nofailだけではMySQL誤起動を防げない。** 次の2層を本番DB初回起動の条件にする。

1. 既存start-database.shのEBS guardへmount先と新VolumeIdを必ず渡し、mount/serial/bind先を確認する。UUIDと所有/期待dataの照合も本番設定で確認。root側の未mount dirは空のままとし、そこへmysql dirや代替dataを自動作成しない。
2. **DB専用systemd unit**で`RequiresMountsFor=/srv/siteflow-mysql`とDocker起動後の順序、必要なら実mount unitへのBindsTo/停止順を設定し、起動時は必ず同guardを通す。既存Docker/Nginx全体をDB用mountへ依存させない。

現行ComposeのMySQL `restart:unless-stopped`はDockerによる自動再起動時にhostのstart-database.shを通らない。したがってDBだけを`restart:"no"`等の明示管理へ変更し、systemdのguard付き起動へ一本化する案とする。初版はDB異常終了後もguardを通した手動再開でよく、勝手な自動復旧の複雑化は避ける。**この補強はまだ未実装/未適用で、既存guardのmock合格だけで再起動安全性達成とはしない。** 専用unit/Compose差分は本番初回DB起動前にローカル実装・検証し、本番変更は別承認する。

DBがまだない段階で、mount成功/失敗時のguard拒否、未mount側へmysql dirができないことを確認する。実EC2再起動試験は旧公開へ影響するため、今回のB作成承認へ含めず別承認。再起動実証前は「設定/対象mount試験済み」と「実再起動未検証」を分ける。

### バックアップと復旧の役割

- EBS snapshot：追加EBSを対象に取得すればDB保存媒体を保管できる。既存rootのsnapshotには追加data EBSが自動で含まれない。作成は別承認、DB導入後は正常停止/整合性確保を伴う。snapshotがあるだけでSQL復元試験済みとはしない。
- SQL backup：前段で検証したTLS/専用権限/全table dump→暗号化してEC2外→別の空DBへ復元→ログイン/案件/会議確認を再利用する。本番age/運用処理は残実装、S3は未作成。root上のsecret/CA/固定auth secret等はSQLに含まれず別の暗号化backupが必要。
- 新EBSが不調：旧公開を維持してDBだけを止め、元dataを残す。復元するならsnapshotから同AZに別encrypted volumeを作り、IDを確認/承認して接続先・guard・UUID記録を更新する。元EBSを上書きformat/削除しない。XFS cloneのUUID重複を避け、元とcloneを無計画に同時mountしない。
- fstab/mount設定失敗：まだDBを起動せず、backupから今回の限定差分を戻す計画。unmount/detach/削除は各操作の影響を確認して別承認。新EBS作成だけなら既存root/旧サイトは変更されないが、不要になっても勝手に削除しない。

### 次の承認範囲

最新ユーザー指定に従い、Bは**B1作成→B2attach→B3format→B4mount/fstab**をそれぞれ個別承認する。CやMySQL起動、Docker volume/network作成、systemd本番配置、実再起動、Next配信、Git push、公開切替は含めない。今の次操作は、上記の設定で空の暗号化gp3 10GiBを1件作成する承認だけ。今回はボタン操作/資源作成をしていない。

今回の読み取りコマンド：IMDSv2は短命tokenでinstance-id/placementとroot mappingのみ取得し、tokenは出力/保存せず破棄。lsblk --bytes --outputは容量/FS/serialを列指定、findmnt --mountpointはそのpathのmountだけ、statはpathの種類/権限のみ、grep --quietはfstabの対象path有無だけ。mkfs.xfsはcommand -vで存在照会のみで実行していない。SSH/Curlの既存key・host鍵検証・timeout・HTTP失敗検知も維持した。

根拠（2026-11-17参照）：[AWS EBS作成/AZ/暗号化](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-creating-volume.html)、[attach](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-attaching-volume.html)、[NVMe番号の相違](https://docs.aws.amazon.com/ebs/latest/userguide/nvme-ebs-volumes.html)、[mount/UUID/fstab/nofail](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-using-volumes.html)、[systemd RequiresMountsFor](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html)。画面名はconsoleの言語/表示で異なる場合があり、値が違えば実行を止めて確認する。

## 14. ユーザー作成・接続後のNVMe読み取り照合（2026-11-17）

### ユーザー報告と実測を区別する

ユーザーが暗号化EBS `vol-01a737715ed956301`を作成し、EC2 `i-04201e271c824ac02`へAWS device `/dev/sdf`で接続済みと報告した。操作の実時刻は未提供。Codexが作成/attachを実行したとは記録しない。暗号化ありはユーザー報告が根拠で、KMS key/gp3性能/終了時削除等のAWS属性は今回独立照会していない。

06:26:58 JST（11月16日21:26:58 UTC）、同EC2とAZ ap-southeast-2cを確認した後、root権限の読み取り専用probeを実行。format/mount/fstab/Docker設定/DB/既存公開の変更なし。

| 項目 | 既存root・変更しない | 追加DB disk・次の承認対象 |
| --- | --- | --- |
| EBS ID | `vol-042befaf03ffe5cb7` | **`vol-01a737715ed956301`** |
| Linux device（今回の時点） | `/dev/nvme0n1` | **`/dev/nvme1n1`** |
| 容量 | 21,474,836,480B＝20GiB | 10,737,418,240B＝10GiB |
| serial | `vol042befaf03ffe5cb7` | `vol01a737715ed956301` |
| AWS device | metadataのrootは`/dev/xvda` | ebsnvme-idは`/dev/sdf` |
| filesystem | p1にXFS、p128にEFI vfat | FS/UUID/partitionなし |
| mount | p1を`/`、p128を`/boot/efi`へ使用 | なし |

`lsblk --json --bytes --paths --output ...`と`/sys/class/block/nvme1n1/device/serial`の両方で新EBSのserialが一致。`/sbin/ebsnvme-id /dev/nvme1n1`も次を返した。

```text
Volume ID: vol-01a737715ed956301
/dev/sdf
```

NVMe番号だけで対象を決めたのではなく、ユーザーが示したVolumeId＋容量＋NVMe識別情報で一意に照合した。NVMe名は再起動/接続順で変わる可能性があるので、変更操作直前に再照合する。

### 新diskの読み取り結果

| probe | 結果と意味 |
| --- | --- |
| `blkid -p -c /dev/null -o export /dev/nvme1n1` | 終了2/出力なし。低レベルprobeで認識できるFS/partition署名が見つからない。今回の調査失敗とは区別 |
| `wipefs --no-act --output DEVICE,OFFSET,TYPE,UUID,LABEL /dev/nvme1n1` | 終了0/出力なし。消去せず署名を列挙し、見つからなかった |
| `file --special-files /dev/nvme1n1` | `data`。認識できるfilesystemなし |
| `findmnt --source /dev/nvme1n1` | 終了1/出力なし。このdeviceをsourceにするmountなし |
| sysfs holders | 空。上位のdevice mapper等の利用先なし |
| lsblk | partitionなし、FSTYPE/UUIDなし、mountpointsなし |

**判断：報告された新10GiB EBSと一致し、未format/未mountの状態に整合する。** 全域の内容を消去/全バイト検査したわけではない。未知のdataが絶対に存在しないという証明ではなく、新規volumeというユーザー報告と、署名/利用なしの照合に基づく判断。既存rootを対象にしない。

### 次の手順（すべて未実行、変更ごとに承認）

**B3：formatのみ**

実行直前に新VolumeId/10GiB/serial/未mount/署名なしを再確認する。承認後の予定コマンドは以下。`mkfs`はfilesystemの構造をdiskへ書く操作で、他のdataがあれば失われる可能性がある。元の未format状態へ戻す通常操作ではない。

```sh
sudo mkfs.xfs -L SITEFLOW_DB /dev/nvme1n1
```

sudoは管理権限、mkfs.xfsはXFS作成、-Lは識別label。**-f（強制上書き）は付けない。** 新disk全体へ作り、rootのnvme0n1/p1は触らない。すでにfilesystemがある/名前が変わった/照合が不一致なら中止。成功後はblkid/lsblkでXFS/新UUID/labelと未mountを確認して一旦停止する。UUIDはformatして初めて決まるため、現時点で値を捏造しない。

**B4：mountのみ**

新UUIDを確認して別承認後、空の`/srv/siteflow-mysql`をroot管理で作り、`UUID=<新UUID>`のXFSをそこへmountする。既存pathにdataがあれば隠してしまうため、作成/利用前に空/用途/権限を確認する。mountはdiskをdirへ結び付けて使えるようにする操作で、formatの代わりではない。

成功後、findmntのsource/UUID/VolumeIdが新EBSに一致し、rootの`/`は以前のEBSのままであることを確認。`/srv/siteflow-mysql/mysql`はmount成功後だけに作る。今回はdir作成/mount/mysql subdir作成もしていない。検証用の書込や所有権設定を行う場合も、そのmount工程の対象/影響として先に示す。

**B5：自動mount/DB起動保護**

fstabをbackupして新UUIDの1行だけ追加する案は13節を参照。別承認後に対象mountの構文/再mountと、未mountならDBを拒否する条件を検証する。実EC2再起動は旧公開に影響するため別承認。

Docker volumeは`/srv/siteflow-mysql/mysql`をdeviceにした外部bindとして作成する必要がある（今回未作成）。さらに、host guardを通らないMySQLのDocker自動restartを避ける専用systemd/再起動方針は未実装。本番初回DB起動の前に補強・検証する。mountやfilesystemを作っただけでMySQLの保存先が変わったとはしない。

### 公開維持・復旧・今回の範囲

公開中siteflow-3002は同じae3 image/127.0.0.1:3002、rootの`/`はnvme0n1p1 XFS、Nginx設定SHA256は既知の2c874b...595と一致、HTTPS200。アプリ/設定を変更・再起動していない。

format失敗や署名検出時は強制上書きせず停止する。mount失敗時は新UUID/source/既存pathを調査し、rootへの代替DB初期化をしない。DB導入後のbackup/別DB復元/追加EBS snapshot計画は13節のまま。今回format前の空diskなのでDB復旧可能性を検証したわけではない。

今回未実施：format、mount、fstab編集、DB専用unit/Compose変更、MySQL起動、Next配信、Git push、既存サイト変更、EC2停止再起動、EBS削除。次の実行承認対象は**新10GiB EBSへのXFS formatだけ**。

参照：[AWSのVolumeId/NVMe対応確認](https://docs.aws.amazon.com/ebs/latest/userguide/identify-nvme-ebs-device.html)、[filesystem確認とformat/mount](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-using-volumes.html)（2026-11-17参照）。コマンドは今回は読み取りprobeだけを実行し、上のmkfs例は未実行。

## 15. B3承認後の新10GiB XFSフォーマット結果

2026-11-17 06:34:15 JST（11月16日21:34:15 UTC）、ユーザーが新VolumeId/10GiB/指定deviceのformatだけを条件付き承認した後に実行した。14節の「未実行」は承認前の記録。

| 項目 | 結果 |
| --- | --- |
| 対象EBS | **vol-01a737715ed956301** |
| 対象Linux device | **/dev/nvme1n1** |
| 容量 | **10,737,418,240B＝10GiB** |
| filesystem | **XFS** |
| UUID | **276f374a-7e33-4ff0-b6f4-b0f185280cd6** |
| label | **SITEFLOW_DB** |
| mount | **未mountのまま** |

### 実行直前の条件と書込範囲

IMDSv2で同EC2を確認。対象がblock deviceかつrootと別のdevice番号であること、lsblkの完全device名/容量/serial、blockdevの容量、sysfs serial、ebsnvme-idのVolumeIdと/dev/sdf、partitionなし/FS・UUIDなし/未mount/非swap/holdersなしを確認。blkidの低レベル署名なし、wipefs --no-actの出力なし、file:dataも一致した。書込直前に対象照合をもう一度通した。

管理権限で`/usr/sbin/mkfs.xfs -L SITEFLOW_DB /dev/nvme1n1`を1回だけ実行し終了0。-Lはlabelの指定、-f/forceは付けていない。XFS metadata/内部log等を書いたのは追加EBSだけで、root `/dev/nvme0n1`やそのpartitionをformat対象に渡していない。filesystem作成は元の未format状態へ通常復帰できる操作ではなく、今回は新disk/署名なしの確認とユーザー承認に基づく。

SSHは既存鍵/BatchMode=yes/StrictHostKeyChecking=yes/ConnectTimeout=10、sudo -n python3 -で専用guardを標準入力から実行。helperはGit対象外の`work/format-approved-ebs.py`。実機のdeploy設定を編集したり、guardのための新サービスを作ったりしていない。失敗時はphaseとformat完了フラグを報告し、自動でmkfs再試行しない設計。今回は全条件/終了後検査とも成功した。

### 実行後の確認

- `blkid -p -c /dev/null -o export`でTYPE=xfs、上のUUID、LABEL=SITEFLOW_DBを確認。
- lsblkで同じserial/10GiB/partitionなし、findmntで対象mountなし。まだ保存先dir/DB dataを作っていない。
- 既存root vol-042befaf03ffe5cb7/20GiBのserial、partition/FS/UUID/mount情報は実行前後一致。`/`は元のnvme0n1p1 XFSのまま。
- `/etc/fstab`とNginx設定のSHA256が前後一致。現公開/直前/保留3containerのID/image/status/StartedAt/portも一致。アプリやNginxを再起動していない。
- 既存SiteFlowのHTTPSは通常の証明書検証付きで200。

機密を含まない結果はローカルGit対象外の`work/ebs-format-result.json`にも保存。UUIDはfilesystem識別値で、パスワードや暗号化keyではない。

### 次の段階と未実施

次はB4として、承認後に空の`/srv/siteflow-mysql`を用意し、**UUID=276f374a-7e33-4ff0-b6f4-b0f185280cd6**を指定してXFSをmountし、source/serial/rootが正しいことを検査する。今のformat承認へmountを含めない。

fstab自動mount・DB専用起動保護/設定の本番適用はさらに別承認。未mount時にroot側のdirへMySQLを初期化することを防ぐ条件を維持する。現時点のformat成功は、実DB保存/再起動/backup復元の合格ではない。

今回未実施：mount/mount先dir作成/fstab変更/MySQL起動/Next配信/Git push/公開切替/既存site設定変更/EC2停止再起動/EBS削除。

## 16. B4承認後の手動マウント結果

2026-11-17 06:40:24 JST（11月16日21:40:24 UTC）、ユーザーが新EBSの手動mountと確認だけを承認した後に実施。

| 項目 | 実測結果 |
| --- | --- |
| EBS ID | **vol-01a737715ed956301** |
| Linux device | **/dev/nvme1n1**（この時点） |
| filesystem / label | **XFS / SITEFLOW_DB** |
| UUID | **276f374a-7e33-4ff0-b6f4-b0f185280cd6** |
| mount先 | **/srv/siteflow-mysql** |
| access | rw（読み書きmount）。アプリ権限での書込試験はしていない |
| disk / filesystem容量 | disk10GiB、dfのfilesystem10,670,309,376B |
| 空き / 使用率 | **10,561,363,968B（約9.84GiB）/2％** |
| 自動mount | **未設定**。fstabは変更していない |

### 実行前の確認と変更内容

- 同EC2、追加VolumeId/serial/NVMe情報/dev/sdf対応、10GiB、XFS/UUID/labelが指定と一致。root20GiBと別のblock deviceで、UUID重複・既存mount・partition・holdersがないことを照合。
- マウント先は未存在。親`/srv`がroot管理で他者書込不可、既存のdataや別mountを隠さないことを確認し、空の`/srv/siteflow-mysql`をroot所有/0700で作成。既存pathへ上書き/既存権限変更はしていない。
- 作成後にも空dir/未mount/対象UUIDを再確認し、`mount --types xfs --source UUID=276f374a-7e33-4ff0-b6f4-b0f185280cd6 --target /srv/siteflow-mysql`を管理権限で1回実行、終了0。

mountはfilesystemをdirから使えるようにする操作でformatではない。新しいmkfs/force/消去は行っていない。--typesはXFS指定、--sourceは確認済みUUID、--targetは今回専用の空dir。UUIDで指定し、NVMe番号の順序に依存させなかった。今回の専用guardはローカルGit対象外`work/mount-approved-ebs.py`で、EC2へ新しい常駐script/サービスを配置していない。

### 実行後の検証

1. findmnt --json --evaluate --mountpointでsource=/dev/nvme1n1、target=/srv/siteflow-mysql、fstype=xfs、指定UUID、rwを照合。--evaluateはUUID等を実deviceへ解決して読む指定。
2. lsblk --json --bytes --paths --outputで同じserial/10GiB/XFS/UUIDと、このmountpointだけであることを確認。
3. df --block-size=1 --output=source,fstype,size,used,avail,pcent,targetでsource/種類/容量/空き/mount先を確認。上の2％はfilesystem管理領域等を含み、MySQLdataを投入した結果ではない。
4. rootのserial/容量/partition/FS/UUID/mount情報は前後一致し、`/`は既存20GiBのnvme0n1p1のまま。新EBSをrootへ重ねてmountしていない。
5. fstabとNginx設定のSHA256、現公開/直前/保留3containerのID/image/status/StartedAt/port/restart policyは前後一致。Docker起動設定を変えていない。
6. 通常のTLS証明書検証付きで既存SiteFlow HTTPS200。EC2/アプリ/Nginxの停止再起動なし。

結果の非機密部分は`work/ebs-mount-result.json`にも保存。MySQL用subdir、Docker Volume/network、テストファイル、DB dataは作成していない。mount時のXFS管理処理と空mountpoint dirの作成以外に、DB準備の書込を広げていない。

### 次の段階・復旧上の注意

現状は**手動mountだけ**で、再起動後の自動mountは未設定。次は別承認でfstabの限定追記と検証を行う。DBのDocker自動restartがhost guardを迂回する点の補強/専用起動管理は、初回MySQL起動の前提として残す。今回のmount成功を再起動/自動起動の合格にしない。

mount操作を元に戻す場合は、利用プロセス/DB停止状態を確認してから対象だけをunmountする別操作になる。data/volumeを削除して戻す手順ではない。今回unmountはしていない。途中で異常があればmount済みかとdir作成状態を報告し、勝手な再試行/unmount/削除をしないguardを用いた。

今回未実施：fstab編集、Docker/Compose/systemd起動設定変更、MySQL起動、Next配信、Git push、公開切替、実EC2再起動、追加EBS削除。

## 17. 自動マウントとMySQL起動保護の設定結果

2026-11-17 06:58:02 JST（11月16日21:58:02 UTC）、ユーザーの今回の包括承認に基づき、fstab自動mountとDB専用の起動保護を設定。**Docker全体/Nginxの停止再起動、MySQL/Next起動、公開切替、Git push、EC2再起動は行っていない。** 設定の読込はsystemctl daemon-reloadのみで、既存サービスのrestartではない。

### 設定した内容と保管先

| 対象 | 内容/目的/状態 |
| --- | --- |
| /etc/fstab | 既存内容をbackupし、指定UUIDのXFSを/srv/siteflow-mysqlへ自動mountする1行だけ追加。rootの既存行は維持 |
| DB専用host設定 | /etc/siteflow/mysql-host.env、root0600。mount先/EBS ID/UUID/volume/network名のみ。パスワードは未作成 |
| mount guard | /usr/local/lib/siteflow/check-database-mount.sh。mountpoint/実source/XFS/UUID/serialを照合するだけ。Docker/mount/data作成はしない |
| DB起動script | /usr/local/lib/siteflow/start-database.sh。guardをDocker操作前に呼び、その後volume所有label/bind先/既存data・初期化許可を検証 |
| Compose定義 | /usr/local/lib/siteflow/compose.production.yaml。MySQL restartは`no`、appは従来のunless-stopped。定義配置/解析のみでup/pullはしない |
| DB専用unit | /etc/systemd/system/siteflow-mysql.service。mount/Docker依存と許可markerを設定。**loaded/inactive/disabled**。enable/startしていない |

sourceはrepoの`deploy/check-database-mount.sh`、`start-database.sh`、`compose.production.yaml`、`siteflow-mysql.service`。実行scriptは0755、Compose/unitは0644、host.envは0600、専用dirはroot0700。fstabは元のroot0644を保持した。新DB secret/CA/mysql.cnf/data dir/volume/network/imageは今回作成/取得していない。

成功時のbackup/実施記録はEC2側の**`/var/backups/siteflow-mount-protection/20261116T215801Z-b933f05a/`**。dir0700、記録0600、root管理。

- `fstab.before`：変更前内容。SHA256 `dbdaac7971306b878787060992d5205c4cd6217858abe663ffea4d5210566de3`。
- `fstab.after`：追加後内容。SHA256 `f43558ce72de8f23be897bbe9b63cabc946e8f3a13016f11ae911ef594f05533`。
- `before.json`、`unit-state.txt`、`result.json`：前後状態/依存/実際の結果。`permission-check.json`に元fstab0644と最終ファイル権限を確認記録。秘密値は含めていないが運用情報として非公開保管。

追加したfstab行：

```fstab
UUID=276f374a-7e33-4ff0-b6f4-b0f185280cd6 /srv/siteflow-mysql xfs defaults,nofail,x-systemd.device-timeout=10s 0 0
```

UUIDは保存先の識別、nofailはdata EBS不在でもOS起動を継続するため、device-timeoutはdevice待ちを10秒に制限するため。末尾0/0はdump/起動時fsckを省くXFS用指定。**実際のEBS不在bootは未試験**なので、設定どおりbootできたという実績にはしない。

### 起動順序と迂回防止

```text
OS起動
 ├─ 既存Docker/Nginx/旧Vinext：DB用EBSに依存させない
 └─ UUIDでDB用EBSを自動mount（nofail）
        ↓ DB専用unitだけがmount成功を必須にする
   mount/UUID/EBS IDのguard → DB起動script → MySQL
```

DB unitはRequires=docker.service/After=docker.service、RequiresMountsFor=/srv/siteflow-mysql、実mount unit `srv-siteflow\x2dmysql.mount`へのBindsTo/Afterを持つ。mount喪失時もDB側を停止対象にする設計で、Docker/Nginx全体にdata mount依存を追加していない。

ExecStartPreでguard、ExecStartでも同guardを通し、誤mountのままvolumeや空DBを作らせない。Composeの**MySQLだけrestart=no**として、Docker daemonからの自動再開がhost guardを迂回しない設定にした。既存3containerのrestart policyは変更していない。rootが任意にdocker start/upを手打ちすれば正規管理外なので、本番運用は専用unit経由に限定する。

DB unitはType=oneshot/RemainAfterExit=yesで、初版はguardを通した明示的な再開を基本とする。DB異常終了を常時監視し自動復旧する仕組みではない。DB起動後の健康確認/停止・再開/backupは次段階で検証する。

許可marker `/etc/siteflow/mysql-enabled`は**存在しない**。unitのConditionPathExistsとdisabled状態により、DB準備/実起動の承認前に自動開始させない。将来のruntime.env/secret/CA/migration等も未配置で、今回systemctl start/enableやCompose upは呼んでいない。

### 再起動なしで実施した確認

| 検査 | 結果と限界 |
| --- | --- |
| fstabの解析 | findmnt --verify成功。追加行のUUID/source/XFS/nofail/timeoutを照合、重複なし |
| systemd構文・依存 | systemd252でverify成功。fstabから実mount unitが生成され、SourcePath=/etc/fstab、既存mountはactive。DB unitはloaded/inactive/disabled、Restart=no、mount依存/After一致 |
| Compose解析 | 3profileをconfigとして解析しMySQL restart=no/両app unless-stoppedを確認。実imageやDB containerの作成はしていない |
| guard正例 | 実際のmounted EBS/UUIDでDATA_EBS_MOUNT_VERIFIED |
| guard誤設定 | 誤UUID→DATA_UUID_MISMATCH、誤EBS→DATA_EBS_ID_MISMATCHで非0終了 |
| mount不在 | root権限の**private mount namespace内だけ**でdata mountを見えなくし、guardがDATA_EBS_NOT_MOUNTEDで拒否。host側はmount不変。物理EBS detachやhost unmountではない |
| 既存環境 | Docker/NginxのPID/開始時刻/サービス定義、3containerのID/image/HostConfig/状態/StartedAt、全image/volume集合は前後一致。Nginx設定hashも不変 |
| HTTPS | EC2とPC双方から通常TLS証明書検証付き200 |
| ローカル | Linux shell/DB起動拒否14件、Compose設定5分類、型検査/業務42件/Next build成功。新DB/本番data操作はなし |

### 検証中の修正と復旧確認

最初はWindows引数の長さ制約でSSH送信が始まらず、標準入力転送へ変更。その後の検証ツールでは、生成済mount unitをverifyへ明示しない問題、systemctl出力の引用/escape解析、inactive profileをconfigで省く点を修正した。不一致になった各試行では、fstabを元内容へ戻し、自分が作った新規5ファイルだけを撤去してdaemon-reloadした。失敗記録/backupは保持し、Docker/DBを起動して解決していない。

ファイル作成のumaskで権限が狭くなる点も補強し、初回backupの元fstab0644を明示的に維持した。新規ファイルは必要なmodeをfchmodで設定するようhelperを修正し、最終hash/権限/DB unit無効状態を再照合した。最初のbackup群も削除していない。

### 戻す場合と未検証

戻す場合は、まず現在のfstabが上の追加後hashと一致し、他の変更が混ざっていないかを確認する。DB導入前の現段階なら、別途対象を確認してfstab.beforeの内容をroot0644へ復帰し、今回のDB専用unit/新規設定を撤去または退避してdaemon-reload、旧HTTPSを確認する。data EBSのunmount/削除を自動で行う手順ではない。将来DBが稼働した後は、その停止/整合性の承認も必要。

**未検証：実EC2再起動、実EBS不在boot、実MySQLの起動/終了・mount喪失時停止、実Docker daemon再起動時のDB動作、DB用bind volume/data/backup復元。** 静的設定/guard拒否の成功だけでこれらを達成済みにしない。既存Dockerサービスの停止再起動、MySQL/Next起動、本番切替、Git pushは未実施。

使用コマンド：findmnt --verifyはfstabの構文/参照検査、systemctl daemon-reloadはsystemd定義の再読込、systemd-analyze verifyはunit検査で起動しない。Compose config --no-env-resolutionは秘密envを展開せず解析し、dummy digestは解析用だけ。unshare --mount --propagation privateは子のmount空間を独立させ、そこでだけumountしてguard拒否を確認する。親のmountを変更しないことを前後照合した。npx tsc --noEmitは型だけ、node --testは検証、npm run buildはローカルPrisma生成/Next build。

根拠：[systemdのmount依存](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html)、[fstab/nofail](https://www.freedesktop.org/software/systemd/man/latest/systemd.mount.html)、[Docker restart=no](https://docs.docker.com/engine/containers/start-containers-automatically/)（2026-11-17参照）。

## 18. AWS MySQL初回起動と永続化検証

2026-11-17 18:41 JST（09:41 UTC）完了。ユーザーの条件付き承認に従い、**MySQLのみ初回起動し、検証用データで正常停止・コンテナ再作成後の保持を確認した。** Next.jsの配信、公開切替、EC2再起動、Git pushはしていない。過去の「DB未起動」はその時点の記録で、現在はhealthy。AWS上の暗号化属性はユーザーのコンソール確認を引き継ぎ、今回Linux上のUUID・NVMe serial・保存先を再確認した。

### 保存経路と秘密情報の保護

追加10GiB EBS vol-01a737715ed956301、UUID 276f374a-7e33-4ff0-b6f4-b0f185280cd6、XFS、/srv/siteflow-mysqlが一致。external volume（Compose管理外に残す保存領域）siteflow-production-mysqlは、同EBSのmysqlディレクトリをbindし、コンテナの/var/lib/mysqlへ接続する。Docker表示の/var/lib/docker/volumes/.../_dataという名前だけで判定せず、実マウントとUUIDも照合した。

| 設定・保存先 | 目的と実際の確認 |
| --- | --- |
| EBS上secrets/mysql-root-password、root-client.cnf | root用秘密ファイル。root所有0600/0400。環境変数には値でなく_FILEによるファイル名を渡す |
| EBS上tls/server/server-key.pem | DB用秘密鍵。mysql UID999所有0600。ホストへ平文転送せず、swap禁止の使い捨てコンテナ内で生成 |
| EBS上logs/mysql-error.log | エラーログのみを追加EBSへ保存。SQL一般ログ・slowログ・binlogはOFF。パスワード文字列が設定・エラーログへ漏れていないことをコンテナ内で検査 |
| read_only、tmpfs | コンテナ本体を読取専用にし、一時ファイルはメモリ上のtmpfsへ。書込可能領域をEBSとtmpfsへ限定 |
| logging driver none、core上限0 | DockerのルートEBSログとcore dumpを防止。実MySQL core_fileも0 |
| memory512m / memswap512m | DBの上限512MiB。両値を同じにしてDBのswapを禁止。cgroupのmemory.swap.max/currentとも0 |
| MYSQL_ROOT_HOST=localhost | 公式イメージの既定値に依存せず、rootのTCP接続を作らない。SQLでroot@localhostのみ確認 |
| portsなし、専用network | ホストへ3306を公開しない。DockerのPortBindingsとホストの待受なしを確認 |

ホストのswapfileは非暗号化root上にあるため、秘密生成・秘密を読む処理はswap禁止のコンテナ内で実施し、ホスト側の変数・引数・ログには平文を取り込まなかった。Dockerイメージは公開MySQLをdigest固定で取得し、秘密を含むイメージのbuild/commitはしていない。CA（証明書へ署名する認証局）の秘密鍵はEC2に置かず、PCのGit無視かつDocker除外されたwork配下に暗号化・所有者限定で保管した。実際の秘密値は文書に含めない。

### 変更ファイルと起動の仕組み

- deploy/compose.production.yamlとdeploy/mysql.cnf：上表の読取専用・ログ・swap・core・root権限・認証付きhealthcheckを設定。ヘルスチェックは設定ファイルを使ったSELECT 1で、単にプロセスがいるだけで健康と判定しない。
- deploy/start-secure-mysql.sh：mount guardに加えて秘密ファイルのEBS上配置・所有者・権限、ローカルDocker、cgroup v2、Composeの保護設定を確認してから既存のstart-database.shを呼ぶ。後者のデータ領域確認用コンテナもread-only/logなし/swapなし/core0にした。
- deploy/siteflow-mysql.service：環境ファイルを/srv/siteflow-mysql/config/mysql-runtime.envへ移し、secure wrapper経由に変更。/etc/siteflow/mysql-host.envは識別子だけ。今回の許可markerは作成したが、**unitはdisabledのまま**。active(exited)は起動処理が完了した意味で、MySQL本体のhealthとは別に確認する。

最初の空DBに限る初期化許可は/runの一時systemd drop-inで設定し、初回成功後に撤去した。再作成後は既存データ用の起動モードで成功。常設の初期化許可は残していない。変更前の非秘密設定と結果は/srv/siteflow-mysql/config/first-start-20261117T094034Z/に保存。この設定控えはSQLバックアップではない。

### 実測結果

| 確認 | 結果 |
| --- | --- |
| MySQL | healthy。mysql@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902 |
| 永続化 | siteflow_validation_ebs.persistence_probeへ架空の1行を保存。正常停止ExitCode0/OOMなし→今回作ったDBコンテナだけ再作成→server UUIDと1行が一致。既存データの削除なし |
| メモリ | 初回234.5MiB、再作成後188MiB / 上限512MiB。再作成後host available 982,491,136B（約937MiB）。初回peak約284MiB。swap使用0/OOM kill0 |
| ディスク | root空き9,525,223,424B（約8.87GiB）/使用56%。DB EBS空き10,345,189,376B（約9.63GiB）/使用4%。起動前DB使用約104MiB→約310MiB |
| 起動保護 | 実mount正例と、secure wrapperの誤UUID拒否に成功。前回の隔離namespaceのmount不在拒否も参照。稼働DBのEBSを実際に外す試験はしていない |
| 旧公開維持 | 旧3コンテナのID/設定/状態、Docker/Nginx PIDと開始時刻、Nginx/fstab hash不変。HTTPS200。Docker全体の再起動なし |

188MiBはアイドル時の観測で、Next.js併走・負荷・同時接続の運用保証ではない。次の候補版投入前には両者の合計使用量と余裕を確認する。

### ローカルでの事前確認と修正

使い捨てMySQLで保護設定・認証healthcheckの正誤secret・3306非公開・TLS必須/binlog OFF・正常停止の6分類に成功。Compose検査5分類成功。MySQLのcore_file=OFF/skip-core-file指定は利用中イメージで不適切なため、ローカルで撤去してOS ulimitと実変数0で確認した。Windowsのworld-writable bind設定がMySQLから無視される問題は、テストだけLinux0600へコピーする補助で回避し、本番Linuxの権限とは区別した。EC2での初回起動前にこれらを解決した。

### 未検証・次の承認範囲

**AWS上のSQLを別保存先へバックアップして戻す試験、非rootアプリ用ユーザーとネットワークTLS接続、Prisma migration、Next.js統合/配信、実EC2再起動・EBS不在boot・稼働中mount喪失は未検証。** ローカルの過去の復元成功を本番復元の成功へ読み替えない。S3作成や新料金リソースも未実施。unit自動起動は無効なので、EC2再起動時のDB自動復帰も未完成。

停止・復旧が必要ならDB専用unitだけを正常停止し、追加EBS・volume・データは保持する。旧公開/Nginxを戻す操作は不要。原因調査後、UUID/secret配置をguardで照合し、専用unitから既存データのまま再開する。volume削除・datadir消去・初期化許可の再付与で解決しない。これらの追加変更は範囲を説明して承認を得る。

### 使用した操作の意味

lsblk/blkid/findmntはデバイス・FS識別子・実保存先を読むだけ。docker inspect/stats --no-streamは設定と一時点の使用量を読むだけ。compose --profile databaseはDB定義を選び、up -d mysqlはMySQLだけをバックグラウンド起動。systemctl startはDB専用unit経由の保護付き起動、daemon-reloadは定義の再読込でDocker全体のrestartではない。stop --timeout 60 mysqlは最大60秒の正常終了待ち。今回作成したDBコンテナのrmは停止済みの入れ物だけを除去し、external volumeや既存の旧公開コンテナには触れない。SELECTは読取、CREATE/INSERTは検証専用DBの架空データ作成だけ。秘密の値を引数や標準出力へ出さない。

追加確認（2026-11-17 19:17 JST）：同一DBコンテナがhealthyを維持、188MiB/512MiB、restart=no/read-only/logなし/PortBindings空、自動起動disabled。旧SiteFlowの3002公開を維持、DB専用unit/Docker/Nginxはactive、正しい既存URL https://13.237.188.172 の証明書検証付きHTTPS200。補助読取ツールで誤ったnip.io名を一度指定したためホスト名不一致となったが、正しい既存URLでは成功し、証明書設定は変更していない。

ビルド追加結果：直接Next.js buildはsandboxが所有者限定CAディレクトリを走査できず失敗。秘密フォルダーの権限は広げず、既存.dockerignoreでworkと環境ファイルを除外したローカルDocker builder内のnpm run buildは成功した。builderイメージにwork/.env/.env.mysql.local/.env.schema-check.localが存在しないことも内容を表示せず確認。型検査/業務42件成功。アプリ・Dockerfileの変更やAWSへのNext配信は行っていない。

## 19. AWSでの検証DBバックアップ・復元・アプリ用TLS接続

2026-11-17 19:40 JST（10:40 UTC）成功、19:42 JST最終health/HTTPS確認。ユーザー承認範囲で、架空1行だけのDBをSQLへ保存し、新しい空DBへ復元した。**アプリ用ユーザーと実際のNext.js接続設定・PrismaアダプターによるTLSを検証済み。ただしNext.js HTTPサーバー/候補サイトの起動、Prisma migration、ログインは未実施。** 旧公開の切替、EC2再起動、Git push、S3/IAM作成、既存データの削除はしていない。

### 何を保存・復元したか

| 対象 | 実際の状態 |
| --- | --- |
| 元DB | siteflow_validation_ebs、persistence_probe 1テーブル・架空1行。実ユーザーなし。前後不変 |
| 最初の復元先 | siteflow_public_preview。存在しないことを確認して新規作成し復元。アプリ用ユーザーの権限検証にも使用 |
| 元バックアップ | /srv/siteflow-mysql/backups/validation-20261117T103431Z/source.sql、2,008B |
| 計測用の追加バックアップ | /srv/siteflow-mysql/backups/tls-resume-20261117T103937Z/source.sql、2,008B、SHA256 85cf5cf58f9c8c611e2f03b94dcf16e956a1e674e36764c2038991ff18be4a08 |
| 計測用の追加復元先 | siteflow_restore_check_20261117104006。別の新しい空DB。元DB・最初の復元先を消さず保持 |
| 証拠 | /srv/siteflow-mysql/backups/tls-resume-20261117T103937Z/result.json、tls-result.json、measurement-*.json。秘密値なし、root0600 |

SQLファイルはroot0600、親directoryはroot0700、指定UUID/EBS IDの暗号化EBS内。今回のSQLには暗号化EBSの保護があるが、ファイル自体のage暗号化はまだない。SQLにはDBユーザー・パスワード・MySQLシステムDBを含めない。**同じEBS内の控えなので、EBS削除・EC2外の障害・権限侵害から独立したバックアップにはならない。** EC2外保管は後述の承認待ち。

復元前に新DB不存在を確認し、dumpが元DBへのUSE/CREATE DATABASEを含まないことを確認した。元DBと復元先について、全テーブル名（今回は1個）、SHOW CREATE TABLEのSHA256、主キー順の全行SHA256、行数1、CHECK TABLEのOKを一致確認。アプリ用のCRUD試験は1つのトランザクション（まとめて成功/取り消す単位）で行い、ROLLBACKで検証行を残さなかった。source/preview両DBは最後にも一致した。

これは**現在存在する架空テーブルの検証**。Prismaのユーザー/案件/会議/外部キーはAWSにまだ作っていないため、その整合性や認証セッションの復元を成功済みにしない。

### アプリ用ユーザーと秘密の扱い

- siteflow_app@172.18.0.0/255.255.0.0：専用Docker networkの実サブネットからだけ接続。siteflow_public_preview.*へのSELECT/INSERT/UPDATE/DELETEのみ。REQUIRE SSL、global権限はUSAGEだけ、GRANT OPTIONなし。networkのsubnet変更時はこの接続元制限も見直す。
- 実接続で自DBの読み書き成功、mysql.userと元DBの参照を拒否、CREATE TABLEを拒否。テーブル作成・schema変更は別のmigration用ユーザーへ分ける。rootは従来どおりlocalhostだけ。
- 新しい64桁乱数の秘密は、既存のswap禁止MySQLコンテナ内で生成してSQLへ標準入力で渡し、ホストの変数・引数へ平文を出さなかった。保存先は/srv/siteflow-mysql/secrets/app-password、root0600。Git/イメージ/ログへ値を記録しない。Docker環境変数にも値を渡していない。
- 検証クライアントはread-only、メモリ128MiB/swap追加0/core0、logging none、publishなし。秘密ファイルと公開CAだけをread-only mountし、失敗/成功時とも生の接続例外を出さず、判定分類だけ出した。サーバー秘密鍵/CA秘密鍵をクライアントへ渡していない。

### TLSの合格条件と結果

TLSは通信の暗号化と、正しい相手かの確認を行う仕組み。CAは証明書を発行した相手を信頼するための公開証明書。**暗号化できるだけでは、相手の名前まで正しいとは限らない。**

| 試験 | 結果 |
| --- | --- |
| 正しいCA＋mysql.siteflow.test | 実SQL成功、Ssl_cipherが空でない。復元した架空1行を取得 |
| 不正CA | 実SELECT 1が証明書エラーで拒否 |
| 正しいCA＋誤った接続名 | 同じDB IPへ到達する別名を指定し、証明書の名前不一致で拒否。DNS不達だけを拒否成功にはしなかった |
| ssl:falseのTCP | TLS必須のサーバー/アカウントにより拒否 |
| 最小権限 | 自DB CRUD成功、他DB/システムDB/DDL拒否 |

実アプリと同じexamples/mysql/public-database.tsのpublicDatabaseOptionsをTypeScriptからJSへ変換し、同じ@prisma/adapter-mariadb 7.10.1・mariadb 3.5.4で実行した。接続コードのsource SHA256は848cc7e2190c0b522ce2a93e9867d91dc2ffc3c5126f4f9321b9f246335059c4で、ローカル現行ソースとも一致。オプションはrejectUnauthorized:true、TLS1.2以上、checkServerIdentityで管理者設定の接続先名を確認する。**接続層の試験であり、Next.jsのHTTP経由readiness/Better Authログイン/Prisma業務モデルは次の候補版試験に残る。**

### 資源実測と旧公開

| 時点 | MySQLメモリ / 上限512MiB |
| --- | --- |
| TLS前 | 199.8MiB |
| TLS後 | 200.1MiB |
| backup後 | 204.6MiB |
| restore後 | 204.7MiB |
| 最終19:42確認 | 204.9MiB |

TLSクライアントの観測最大約26.2MiB/上限128MiB。host available最少934,043,648B（約891MiB）、backup段階最少約923MiB、restore段階最少約898MiB。200ms間隔の標本と区切りのdocker statsであり、瞬間ピークの完全保証ではない。MySQLのswap0、OOM/oom_kill0を確認。

最終root空き9,353,465,856B（約8.71GiB）、DB EBS空き10,344,792,064B（約9.63GiB）。TLS/追加backup/restoreの計測区間でDB空きは約116KiB減。今回の小さなデータだけの結果で、本番サイズ・同時利用の性能保証ではない。検証用の公開client imageは再利用用に保持。転送アーカイブ81,986,560Bと今回作った停止済みclientだけはID/label/読取専用mount/書込層0を照合して整理した。DB volume・SQL控え・旧公開/復旧コンテナは削除していない。

旧3コンテナの設定/状態、Docker/Nginx PIDと開始時刻、Nginx hashは前後不変。MySQLも同じcontainer IDのままhealthy、3306はpublishなし（docker psの3306/tcpという表示はホスト公開を意味しない）。証明書検証付きhttps://13.237.188.172 は200。DB unitはdisabledのまま。

### 途中停止と修正を完了と混同しない

1. SHOW GRANTSにREQUIRE SSLの表示を期待した検証側の条件が誤っており停止。実権限は正しく、秘密/認証hashを表示しないmysql.user.ssl_type=ANYの読み取りと権限表で確認方法を修正した。ユーザー/秘密を作り直していない。
2. Prismaアダプターのconnectは機能調査の失敗を内部で受け止めてオブジェクトを返す場合がある。誤証明書の判定を「オブジェクト作成」から「実SQL拒否」へ修正して合格した。接続先の安全設定を緩めていない。
3. 最初の停止時に資源記録が保存されなかったため、計測目的の追加dumpと別空DBへの復元を1回だけ実施し、段階ごとに記録を残した。既存の一般テストや過去15項目を再実行して成功扱いにはしていない。

### 使用操作の目的・影響

- mysqldumpの--defaults-extra-fileはroot認証を値でなく保護ファイルから読む。--single-transactionはInnoDBの一貫した読み取り、--quickは行を順次出力、--skip-lock-tablesは通常table lockを省略、--no-tablespacesはtablespace管理情報を除外、--set-gtid-purged=OFFは複製用GTID変更を除外、--column-statistics=0は不要な列統計を出力しない。DB名を1つ指定し、--databasesを使わず元DBを上書きするUSEを持ち込まない。sourceは読み取りのみ、SQLファイルはEBS上に新規作成。
- mysql --batch --skip-column-namesは機械比較しやすい行出力。CREATE DATABASEは新しい入れ物作成、復元SQLは不存在を確認した新DBにだけ実行。CHECK TABLEとSELECT/SHOWは確認。CREATE USER/GRANTは今回の専用ユーザーだけを作成/権限付与。既存ユーザーの変更なし。
- Docker create/startは一時的なTLSクライアントだけ。--networkは専用DB network、--add-hostは誤名を同じIPへ向ける試験、--read-onlyとreadonly mountは書込禁止、--memoryと同値の--memory-swapはswap禁止、--ulimit core=0はcore禁止、--log-driver noneはroot EBS上のDockerログを作らない。TLS時の秘密はコンテナ内メモリだけで読む。
- docker inspect/stats、findmnt/lsblk、df相当のstatvfs、curlの--fail/--silent/--show-error/--max-time/--output /dev/null/--write-outは設定・容量・健康の確認。curlはHTTP失敗を失敗扱い、通常進捗を省略しエラーは表示、時間上限、本文破棄、ステータスだけ出力する。-kは使わない。

### S3等のEC2外保存：未作成、次の承認対象

既存[9.4のS3設計](#94-s3実際に承認できる設定単位)を再利用する。**今回S3/IAMの実設定は変更/作成しておらず、EC2外バックアップ済みとは言わない。** 現在のaccount/bucket/roleの権限を推測して操作しない。

| 項目 | 承認後に実施する案 |
| --- | --- |
| 保存先 | ap-southeast-2の専用S3 bucket1個。名前はsiteflow-db-backups-ACCOUNT_ID-ap-southeast-2を候補とし、実account ID/一意性を確定してから作成。daily/・protected/・config/の3prefix |
| 暗号化/非公開 | gzip→ageで事前暗号化＋SSE-S3 AES256、HTTPS必須、Block Public Access全ON、BucketOwnerEnforced、Versioning ON。age復号鍵はEC2へ常設せず、本人の保護領域へ二重保管 |
| 権限 | 既存9.4の対象prefix限定IAM。日常backupはList/Put/Get（照合）とdailyだけの整理、protected/config削除禁止・DeleteObjectVersion禁止。復元用のGetObjectVersion/ListBucketVersionsは運用者の別セッションだけ。長期アクセスキーを作らずinstance roleの短期認証。既存の広いpolicyがないか適用前に確認 |
| 保存期間 | dailyは成功後だけ最新7セットへ整理、dailyの非現行版は30日。休止/公開/migration前はprotectedへ保存し2027年1〜4月の再公開確認まで自動失効させない。configも自動失効なし。保護世代の増加と費用を月次確認 |
| 復元方法 | manifestのVersionIdを固定して取得→SHA256/サイズ一致→ageの認証付き復号→gzip検査→元DBと違う空DBへTLS import→全table/行/制約/アプリ確認。失敗したら元DBと公開先は維持。秘密configは別の暗号化控えが必要 |
| 費用 | 過去11月16日取得のSydney料金見積もりを再利用：40個相当×100〜256MiBなら保存約0.10〜0.25 USD/月、PUT/GET各1000件でも約0.00594 USD/月、概算合計0.11〜0.26 USD/月＋通信/世代増加/税等。請求実績ではない。SSE-S3の暗号化自体に追加費用なし。SSE-KMS新key/NAT/RDS/別EC2は作らない |

承認単位は「専用bucket1個＋対象限定IAM/保存期間＋暗号化した架空データ1件の送信/取得/別空DB復元試験」。作成前に実bucket名・role・policyと追加費用を提示して承認を得る。現時点では作らない。予定のRPO24時間（失ってよい更新の期間）/RTO60分（復旧までの目標）は、EC2外からの復旧未測定なので未達成。

### AWS Next.js候補版までの残作業

1. **ローカル実装/検証**：DB password・Better Auth secret等を_FILEから起動後のプロセス内だけで読む仕組み、node UIDが読めるEBS上の限定権限、read-only/swap禁止/core禁止/ログ保護を整える。現行Composeのenv_fileで秘密値を渡すとDocker metadataが非暗号化rootへ保存され得るため、そのまま配信しない。
2. **本番変更の承認後**：今回の復元DBは検証用のためPrisma本番スキーマを混ぜない。新しい空の正式アプリDBと専用migrationユーザーを用意し、承認したmigrationだけ適用、appユーザーは正式DBのCRUDだけへ切り替える。復元用probeや元DBを消してdriftを解消しない。migrationのDDL権限は実行後失効させる。
3. **EC2外backupの承認/検証**：上記S3の暗号化・取得・復号・別DB復元を一巡し、休止/本番公開前の控えを確保する。現段階では同一EBS内SQLしかない。
4. **候補起動の承認後**：署名/証明書期限と容量・合算メモリのゲートを確認し、候補Next.jsを空いている127.0.0.1:3001だけへ起動（現公開3002は維持）。SSH tunnelからreadiness・架空アカウントのログイン/案件作成更新/チーム境界/再取得を確認する。HTTPサーバーの実接続・移行履歴・schema hashをここで合格させる。
5. 公開切替、EC2再起動/停止再開、自動起動有効化、Git pushはそれぞれ範囲を示して別承認。未完成の決定事項・招待・進捗差分表示は未完成のまま扱う。

失敗時は候補/検証クライアントだけを止め、旧公開を維持し、EBS/DB/backupを保持する。今回作成した検証DB・専用ユーザーの将来整理は、対象を列挙して承認後。元DBへdumpを上書きしたり、volumeを削除して初期化し直したりしない。

追加の秘密検査も成功：新しいapp-passwordのroot0600/乱数形式の長さを確認し、MySQL error logと今回のSQL控えにその値がないことを、read-only/swap禁止/core0/logなしの一時コンテナ内で検査した。ホストへ秘密の値は読み出していない。

参考（2026-11-17参照）：[MySQL SHOW GRANTSとアカウント属性の区別](https://dev.mysql.com/doc/refman/8.4/en/show-grants.html)、[SSE-S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingServerSideEncryption.html)、[S3公開防止](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)、[S3料金](https://aws.amazon.com/s3/pricing/)。region単価の取得日は9.5記載の11月16日で、今回は料金JSONの再取得成功とは扱わない。

## 20. AWS Next.js候補版の起動・正式DB移行・ログイン保存検証

2026-11-17 **20:08 JST（11:08 UTC）成功、20:10 JST追加確認**。ユーザーが承認した秘密ファイル対応・新規正式DBへのmigration・別ポート候補起動・架空アカウントの操作を完了。**既存Vinext/Nginx/公開先は変更していない。** S3/IAM作成、Git push、公開切替、EC2再起動/停止、自動起動の有効化は実施していない。候補は現在起動中で、一般公開サイトのURLはまだ旧版。

### 構成と秘密ファイル

~~~text
インターネット → HTTPS:443 / Nginx → 旧Vinext:3002（維持）
本人のSSH認証 → EC2内127.0.0.1:3001 → Next.js候補版
                                      ↓ 証明書を検証するTLS
                                  MySQL / 正式DB
秘密・DB・架空アカウント控え・SQL控え → 追加の暗号化EBS
~~~

| 対象 | 現在の実装/状態 |
| --- | --- |
| Next候補 | siteflow-next-candidate、127.0.0.1:3001→3000。restart=no、read-only、384MiB/swap追加0/core0、Docker logなし、node UID1000 |
| MySQL | 従来の同一コンテナ・512MiB、外部publishなし。追加EBS UUID/EBS IDを起動前後に照合 |
| 正式DB | 新規siteflow_public_app。元の検証/復元DBを流用・削除せず作成 |
| appユーザー | siteflow_runtime@172.18.0.0/255.255.0.0、REQUIRE SSL。業務15tableのSELECT/INSERT/UPDATE/DELETEだけ。DDL・他DB・_prisma_migrationsへの権限なし |
| migrationユーザー | sf_migrate_candidate、同subnet/REQUIRE SSL、正式DBだけのCREATE/ALTER/INDEX/REFERENCES/CRUD。移行後ACCOUNT LOCK=Y。DROP/global/GRANT OPTIONは付与していない |
| 秘密 | /srv/siteflow-mysql/secrets/candidate/ のdb-password・migration-password・auth-secret。UID1000所有0400、ホスト親dir root0700。個別ファイルをread-only bind |
| 架空テストアカウント | EBS上/srv/siteflow-mysql/config/candidate-20261117T110748Z/test-account/account.json、UID1000/0600。実値は文書・Git・ログへ出さない |
| 非秘密運用設定 | /srv/siteflow-mysql/config/candidate-20261117T110748Z/candidate-runtime.env。秘密の値でなく_FILEのコンテナ内パスとDB名等のみ |

DBパスワードと認証secretはswap禁止のMySQLコンテナ内で乱数生成し、ホストの変数やコマンドへ平文を出さず、EBS内だけでファイル移動/権限設定した。Docker Config.EnvにはSITEFLOW_DB_PASSWORD_FILE/SITEFLOW_AUTH_SECRET_FILEのパスだけを渡し、値はアプリ起動後にreadSecretSettingが読む。プロセス環境変数へ値を書き戻さない。migrationのURLはそのコンテナ内のCLI子プロセスだけへ渡す。秘密を含むimage build/commitは行っていない。

### 変更したソースと理由

| ファイル/関数 | 変更と役割 |
| --- | --- |
| examples/mysql/secret-files.ts / readSecretSetting | 新規。秘密の_FILE指定を読む。絶対パス、O_NOFOLLOWでsymlinkを拒否、fdのfstatで通常ファイル/1〜4096B/Unixのgroup・other権限なしを確認。複数行・NUL・値とFILEの二重指定を拒否。元の例外や値は出さない |
| examples/mysql/public-api-settings.ts / readPublicApiSettings | DB passwordとAuth secretを上の関数で解決し、既存の形式検査へ渡す。従来の直接指定はローカル互換用に維持。FILE失敗はSECRET_FILEとして安全なエラーへまとめる |
| deploy/migrate.mjs / migrationSettings | migration-passwordも_FILEで読む。app用password-fileとの二重指定を避けて、専用ユーザーの設定でTLS検証→migrate deploy→schema diff→履歴確認 |
| Dockerfile / migration stage | 新しいsecret-files.tsを移行用イメージへCOPY。秘密の実ファイルをCOPYする設定ではない。CI/CD workflowやNginx/既存Compose/systemdは今回変更していない |
| tests/secret-files.test.mjs | 値を書き戻さないこと、二重指定・不存在・複数行・Unixの広い権限を拒否する検証 |

TypeScriptの関数はenvという読取専用の設定集合とkeyを受け取り、stringまたはundefinedを返す。fdは開いたファイルの番号で、finallyで必ず閉じる。try/catchで詳細なOSエラーを外へ出さず、秘密の値やパスを含む元エラーを返さない。O_NOFOLLOWとfstatは、確認したファイルと読み込むファイルを入れ替えられる事故を避けるため。

### SQL確認と正式DBへの適用

ローカルのSQLと移行用image内ファイルのSHA256が一致した。適用直前に正式DB不存在、作成後にtable件数0を確認。元データがあるDBへは適用していない。

| 履歴 | 内容 | SQL SHA256 |
| --- | --- | --- |
| 20261114_integrated_schema_check | CREATE TABLE 12、外部キー追加19 | 07d0924e37b7f835b402a3a43e45b9986227e1bf64447f8566f668db1cd21eb1 |
| 20261115_meeting_round | CREATE TABLE 3、外部キー追加8 | 271578423ce8c43e8c88058768b793f5402ed6fea5637539bba13975fa2e028f |

対象はテーブル15個と外部キー27個の追加のみ。ALTERは新しいテーブルへのADD CONSTRAINT FOREIGN KEYだけ。DROP/TRUNCATE/列の変更/既存行の更新はない。外部キーのON DELETE定義は将来の関連データ操作のルールで、今回の既存データを削除するSQLではない。migrate reset/db pushは使用していない。

Prisma migrate deploy後、schema diffで差分なし、_prisma_migrationsの成功履歴2件、全16table（管理table含む）、会議tableの読取を確認。schemaHashは80b4eb7a951cd8da6f6a7ef4a68c9f63d52dbc624db2476f3cf93e5901959e07。移行用ユーザーをロックし、以後のseedとHTTP操作はDDLを持たないappユーザーで行った。履歴tableへのCRUDすらappへ与えていない。

### AWS上で実際に確認した動作

1. /api/readyが200、未認証の案件APIが401。
2. 架空ユーザー1人・チーム1個を正式DBに準備し、実Next.js HTTP APIでログイン成功。Secure/HttpOnlyのセッションCookieを確認。
3. 案件を作成→進捗25へ更新→APIで再取得。DB直接の読取でもprogress25/version2が一致。検証案件は削除せず保持。
4. ログアウト→同じCookieで401。正式DBのsession件数0を確認。
5. appユーザーによるCREATE TABLEとmysql.user参照が拒否。MySQLは停止/再作成していない。
6. 旧3コンテナのID/Config/HostConfig/State/Mounts、Docker/Nginx PID/開始時刻、Nginx hashは前後不変。証明書検証付き旧HTTPS200。
7. EC2内のloopback bindを検査。PCから13.237.188.172:3001へのTCP接続は到達できず、一般公開していない。

今回の操作は本人の鍵で認証したSSHを通じてEC2内の一時クライアントから実行した。HTTP区間はEC2のloopback内のみ。**ブラウザーでSSHトンネルを張り、HTTPSと画面を操作する試験はまだしていない。** Nodeの検証クライアントはSecure Cookieを手動送信するため、通常ブラウザーのCookie挙動まで成功扱いにしない。

テストアカウントのパスワードhashは、既存Better Authの@better-auth/utilsに含まれるNode用hashPasswordと同じ公開ソースを実行して作成した。独自の平文認証や本番サインアップ経路を追加していない。seed/操作用の一時コンテナは成功後に削除し、アカウント秘密はEBSにだけ保存。

### リソース実測

| 時点 | Next.js | MySQL | EC2 available |
| --- | --- | --- | --- |
| 候補起動直後 | 163.8MiB / 384MiB | 226.1MiB / 512MiB | 約909MiB |
| ログイン・保存・ログアウト後 | 188.1MiB / 384MiB | 226.2MiB / 512MiB | 約865MiB |
| SQL控え作成後20:10確認 | 180.6MiB / 384MiB | 231.1MiB / 512MiB | 873MiB |

旧Vinextは最終93.95MiB/192MiB。EC2全体はRAM1909MiB・used852MiB（OS表示）、available873MiB。作業中available最少866,304,000B（約826MiB）、Nextのcgroup peak208,670,720B（約199MiB）、Next swap current/max0・OOM/oom_kill0。EC2ホスト全体のswapは最終1MiB使用で、全ホストがswap0という意味ではない。秘密を扱う新コンテナはそれぞれswapを禁止した。

最終root空き8,823,709,696B（約8.22GiB）、DB EBS空き10,342,215,680B（約9.63GiB）。移行用imageは約992MB、候補imageは約391MBで、共有層があるためdf差分と単純合算しない。ローカルでビルドして転送し、EC2上ではNext buildをしていない。今回作った秘密なし転送archive287,116,288Bだけを後片付けし、旧image/復旧版は保持。

1ユーザー・1案件の短い機能確認と200ms標本の実測であり、長時間稼働/多数同時利用の保証ではない。

### 検証結果と現在残っているもの

- ローカル型検査成功、業務42件＋設定9件＋秘密ファイル1件＋release record1件の計53件成功。Windowsでshell用53件はskip。Linuxで設定/秘密ファイルの10件成功。新しいmigration/NextのDocker build成功。skipや以前の15項目を今回の追加成功件数へ含めない。
- 現在の実行結果/移行証拠/各段階使用量/非秘密設定は/srv/siteflow-mysql/config/candidate-20261117T110748Z/。機密値は記録しない。app image ID sha256:44b74c75c1829b97311362138c730c0a8034ecbab6d275ea799b5667b184dbcf、migration image ID sha256:5df22d1577679977c3b155deefa0fc9e890fcc0ed0a37d2071ff6d1c7b6f8d26。
- 新正式DBのSQL控えは/srv/siteflow-mysql/backups/candidate-20261117T111053Z/siteflow_public_app.sql、28351B、root0600、同じ暗号化EBS内。dump時も秘密を含み得るSQLをホストの標準出力/メモリへ取り込まず、DBコンテナ内でEBSへ直接保存。**この正式DB控えの復元は未検証**。前回の1table復元を15table/認証/会議の復旧成功へ流用しない。
- DB/password/Auth secretの所有者と権限、DB error logへの秘密混入なしをコンテナ内で確認。DockerのEnvへ秘密値なし、log driver none、read-only。アプリ障害ログを安全に残す恒常運用は公開前の整備事項。

### 失敗時の止め方・再開・切り戻し

候補の問題では、**候補コンテナだけを正常停止し、旧公開とMySQL/正式DBを保持**する。今回の実行helperも異常なら一時job/候補だけを停止し、reset/再初期化/元DBの上書きはしない設計。公開先は旧版なのでNginxを切り戻す必要はない。

復旧のための確認操作：findmnt/lsblkで指定UUID・EBS ID・XFSを照合し、秘密の0400/UID1000、既存container ID/image/127.0.0.1 bindをinspectで確認する。候補再開はそのguardの後に既存containerだけをstartしreadiness/HTTPSを確認する。正式DBが存在する現在、初回用のDB/ユーザー作成scriptをもう一度実行しない。SQL控えの復元は元DBと違う空DBへ行う。

候補はrestart=no、DB専用unitもdisabledのまま。EC2が再起動すれば自動で元通りに戻る構成ではない。自動起動/停止再開試験は別承認。旧Vinextへ公開を戻す必要が生じるのは将来の切替後で、今は旧版が公開され続けている。

### 公開前に残る条件

1. S3等への暗号化backupと、新正式DBの全table/外部キー/認証/案件/会議を別DBへ戻す復元試験。現在は同一EBSのSQL控えだけ。S3/IAM作成は[19節の案](#19-awsでの検証dbバックアップ復元アプリ用tls接続)に別承認が必要。
2. 本人のSSH認証を使ったブラウザー用の安全なHTTPS確認経路を整え、画面操作・Cookie・モバイル幅を検証する。HTTPのlocalhost直アクセスをブラウザーHTTPS試験の代わりにしない。
3. 既存HTTPS証明書を読み取り確認：notBefore 2026-11-14 14:26:23 UTC、**notAfter 2026-11-21 06:26:22 UTC（11月21日15:26:22 JST）**。今回は更新していない。継続公開前に更新と更新後HTTPSを確認する。証明書/Nginx変更は承認範囲を示す。
4. 承認付き配信・schema証拠・秘密_FILE/ログ保護・mount guardを、恒常的な起動/公開切替の設定へ組み込む。今回の候補は保護条件を照合した明示起動で、既存blue/greenのCompose/自動配信を本番設定へ変更したわけではない。候補が3001を使うため、従来blue起動処理を無断で走らせない。
5. 必要な小規模負荷/監視とリソース余裕、マウント/秘密保護を迂回しない自動起動、実停止/再開/復旧の承認と検証。Git push/公開切替/EC2再起動は今回の承認に含めない。
6. 決定事項・招待・進捗差分は未完成。schemaにinvitation tableがあることを招待機能完成としない。アーカイブ/復元権限は確定要件の「チーム管理者と主担当」を優先する。

### 使用コマンドの意味と影響

npx tsc --noEmitは型だけを検査しJSを出力しない。node --experimental-strip-types --testはTSの型を取り除いて指定テストを実行。Docker build --target migrationは移行用段階、targetなしはNext runnerを作り、.dockerignoreでwork/環境/秘密ファイルを除外する。save/loadは秘密なしのビルド済みimageの受渡しで、既存containerを置き換えない。

Prisma migrate deployは確認済み履歴を空の正式DBへ適用、migrate diff --exit-codeはschemaとの差があれば失敗扱いにする。create/alter権限は移行用だけで、ACCOUNT LOCKは以後のログインを禁止する。GRANTは業務tableごとのCRUDだけ。db push/resetや既存データ消去は行わない。

docker createの--publish 127.0.0.1:3001:3000はEC2 loopbackだけで待受。--memory/同値の--memory-swapは上限とswap禁止、--read-onlyはコンテナ本体への書込禁止、--tmpfsは一時領域をメモリへ、--ulimit core=0はcore禁止、--log-driver noneはDockerログのroot EBS保存を避ける。--mount readonlyは既存秘密の読取だけ。restart=noはmount確認なしの自動再開を避ける。startは今回の候補/一時jobだけで、旧公開を再起動しない。

HTTP確認はtest-accountをEBS内だけで読み込み、EC2内からlogin→create→update→GET→logout→401を実行。dumpの各指定と別DB復元の注意は19節に記載。最後のSQL控えは同じ非破壊dump指定で取得しただけで、復元や公開切替はしていない。

## 21. 公開前準備：証明書・非公開ブラウザー・復旧・CD

2026-11-17、ユーザーの優先順位に沿って実施。**既存Vinextの公開を維持**。S3/IAMリソース作成・GitHub環境作成・Git push・公開切替・EC2再起動は未実施。完了と承認待ちを以下で区別する。

| 作業 | 状態と証拠 |
| --- | --- |
| HTTPSの更新経路 | 20:39 JSTにdry-runとdeploy hook成功、通常renew正常。timer有効。期限延長は起きていない |
| S3/IAMと料金 | 対象bucket/role/JSON案と公式料金確認。[承認案](S3_BACKUP_APPROVAL.md)。作成とS3往復/正式DB復元は承認待ち |
| PCブラウザーHTTPS | 20:52 JST、実Chromeでログイン・案件作成/進捗保存/再取得/ログアウト成功。警告回避なし |
| 候補の再開 | 21:15 JST、保護確認→Next候補だけ停止再開→readiness200/保存35％維持。MySQL/旧版/EC2は再起動していない |
| 承認付きCD | ローカル実装・模擬Linux62件成功。GitHub productionは20:36確認で0件/404、実GitHub承認・EC2常設反映・有効化は未実施 |
| 最終21:21確認 | 旧HTTPS200・Nginx設定hash不変。候補/DB稼働、架空user1・案件2・session0。新しいSQL控えを暗号化EBSへ保存 |

### 21.1 HTTPS：有効期限と自動更新

certbot-renew.timerはenabled/active、直近service Result=success。03/15時UTC＋最大30分遅延・Persistentの既存構成。実行はCertbot 5.8の既存venv、webroot /var/www/letsencrypt、shortlived profile。deploy hookの内容を読んで **systemctl reload nginxだけ**と確認した。

本番設定を複製した暗号化EBS上でstaging dry-runし、テスト用のaccount/鍵/ログを同EBSへ保存。--run-deploy-hooksで実際のNginx再読込hookを検証した。staging証明書を本番へ配置していない。続く通常renewは期限判定を尊重し、--force-renewalは使っていない。certbot処理は一時systemd unitのmemory256MiB/swap0/core0内で実行した。

結果：本番serial/期限は変更なし、**notAfter=2026-11-21 06:26:22 UTC＝15:26:22 JST**。通常renewが0で終わるだけでは期限延長の証拠にならない。更新経路の予行成功と、後日の実自動更新による期限延長は別。次のtimerは観測時点で11月18日00:25 JST予定。公開直前にもlive証明書と実配信証明書の新しい期限を確認する。

最初の試験はCertbot自身のランダム294秒待機があり、監視側の220秒上限に達した。認証失敗ではなかった。読み取りで理由を確認し、旧試験unitは停止依頼時点ですでに終了していた。手動試験だけ--no-random-sleep-on-renewを追加し、unit自体にも180秒上限を設定して成功。通常timerの設定は変えていない。記録は/srv/siteflow-mysql/config/cert-check-20261117T113943Z/result.json。Nginxのreloadは実施、停止・ルーティング設定の書換えはしていない。

### 21.2 非公開HTTPSをPCの本物のブラウザーで確認

~~~text
PC専用Chrome: https://13.237.188.172/workspace
   ↓ この専用プロファイルだけのCONNECT proxy（TLSを復号しない）
127.0.0.1:31289 → SSH鍵認証のトンネル → EC2内127.0.0.1:3443
   ↓ 有効な既存IP証明書をread-only使用する私設TLS proxy
EC2内127.0.0.1:3001 → Next.js候補 → TLS → MySQL

通常Chrome/インターネット → 既存Nginx:443 → 旧Vinext:3002（維持）
~~~

SSHは本人の登録済み鍵とknown_hostsで認証。PCとEC2のproxyはloopbackだけ、外部ポート/SG変更なし。CONNECT先を13.237.188.172:443だけに限定し、ブラウザーのOriginを実アプリ設定と一致させた。TLSの秘密鍵はEC2既存ファイルのread-only bindで、PCへコピーしていない。証明書警告を無視せず、PCのルートCA/hosts/OS全体のproxyを変更していない。

ブラウザー専用ツールとWindows画面ツールは接続不能で、再試行/初期化後も復旧せず。既存プロジェクトの実Chrome/CDPテスト方式を再利用した。**headless APIのCookie手動送信ではなく、実ブラウザーがHTTPSで受け取るSecure/HttpOnly Cookieを使用**。専用incognitoと所有者限定profileを使い、通常の個人用Chromeを操作していない。

架空アカウントはEBSから出す前にswap禁止helper内で一時公開鍵へRSA-OAEP暗号化し、PCテストのメモリ内でのみ復号。秘密鍵も一時メモリのみ。Base64は文字表現で暗号化ではなく、RSA暗号化後のデータをBase64で運んだ。パスワードをコマンド引数・ファイル・ログへ書かず、ブラウザー保存もしていない。

合格：ログイン→案件を新規作成→進捗35/版2を保存→ページ全体をreload→同じ案件を開き直して再取得→ログアウト→保護API401。localStorageにpasswordなし。1440/390幅を撮影し、390幅で横overflowなし。検証用user1・案件2は保持。画像は[PC](images/aws-candidate-https-desktop.png)と[スマホ幅](images/aws-candidate-https-mobile.png)。個人情報や実パスワードは写っていない。

保存した公開コード：deploy/private-preview-https.mjs（EC2のTLS終端）、scripts/private-preview-proxy.mjs（PCの限定CONNECT転送）、scripts/check-private-preview-browser.mjs（明示許可と新しい専用profileを要求する再現用検証）。実施原本はwork内、保存版は同じ検証ロジック＋opt-in guardで構文確認済み。検証後は専用Chrome、PCのSSH/proxy、一時EC2 TLS proxyを終了/停止した。Next候補とMySQLは稼働継続。

再確認時は新しいowner限定profile、SSH/private proxyを準備し、既存証明書の期限とmountしているarchive世代を照合する。証明書更新後に古いbindを再利用しない。安全でないページ警告が出たら止めて証明書を直す。通常Chromeで同じURLを開くと、引き続き旧公開へ行く。

### 21.3 再起動・復旧の範囲

deploy/recover-candidate.shはstatus/restart-candidate/restart-db/stop-candidateを分ける。変更操作にはSITEFLOW_RECOVERY_APPROVED=yesを要求。root保護のhost設定→実EBS/UUID→recordのcontainer/image/label→秘密のEBS/UID1000/0400を検査する。DB復旧時は候補だけを止め、専用MySQL unitのguard経由で再開しhealthy後に元の候補を再開。元DBの削除・reset・volume操作はしない。候補readinessが戻らなければ候補を止め、旧公開は維持する。

今回、コピーしたpublic scriptをEBSの/srv/siteflow-mysql/config/recovery-check-20261117T121545Z/へ置き、現在の3001候補だけで正例を実施した。保存したブラウザー案件35/版2が残り、旧Vinext State/HostConfig不変、MySQL StartedAt不変、旧HTTPS200。常設CD unitは未インストール。**MySQLを今回もう一度再起動したわけではなく、既存の保存/再作成成功を再利用。EC2実再起動・EBS不在bootは未検証。**

候補はrestart=no、DB専用unitはdisabledのまま。EC2再開時に自動復旧したとみなさない。起動時の順序はEIP維持確認→fstab mount/UUID/EBS照合→MySQL guard起動/healthy→候補guard起動/readiness→保存データ→HTTPS。EC2停止/起動/再起動は別承認。候補用復旧スクリプトは将来の3101/3102公開枠の自動復旧器ではない。

### 21.4 承認付きCD・初回切替のローカル完成範囲

| ファイル | 変更と目的 |
| --- | --- |
| deploy/check-app-secrets.sh | 値を読まずmount/UUID/secret mode400:UID1000を照合。runtime envを許可した非秘密キーだけに制限し、_FILE参照必須・平文secret/未知キーを拒否 |
| deploy/release.sh | 上記guardをimage取得前/候補起動直前に通す。read-only/swap0/core0/logなし/個別秘密bind/restart=noに統一。既存のschema証跡/digest/排他/失敗時rollbackを維持 |
| deploy/cd-check.sh | tokenを暗号化EBS内・root専用mode・swap0/core0でだけ読む。main限定policy、本人reviewer設定、**実runのproduction承認履歴の本人approved**、成功job、最新main、artifact/run/attemptを照合。記録なし/他人承認は拒否 |
| deploy/compose.production.yaml | appも同じ秘密FILEと保護へ統一。DB serviceの実稼働設定は今回変更していない。新しいapp枠は3101/3102 |
| deploy/siteflow-release.service/timer | mount依存・memory256MiB/swap0/core0・5分確認の常設案。未インストール/未有効化 |
| deploy/github-production-*.example.json | production本人reviewer、prevent_self_review=false、mainブランチ1件、初期RELEASE_ENABLED=falseのREST入力例。未適用 |
| .github/workflows/ci.yml | この段階ではdeploy-check実行に512MiB/swap0/core0を追加。以前準備したproduction job/2image送信は引き継ぐ。GitHubへは未送信 |
| deploy/nginx-siteflow-bootstrap.example.conf / nginx-upstream.legacy.example.inc | 現行HTTP challenge/証明書/Host等を維持して専用include化する案。初期向き先は旧3002のまま。ローカル実Nginxのnginx -t成功、本番未適用 |

ポートを分離：**旧Vinext3002、今回の確認候補3001、新配信用blue3101/green3102**。旧番号のままblue/greenを再利用すると旧版/確認候補と競合するため変更した。初回stateはlegacy3002だけ許可し、承認後にblue3101へ。以後3101/3102だけ交替し、legacy3002は再利用/停止しない。失敗時は旧includeへ戻し、nginx -t/reload/HTTPSの確認を行い、DBは戻さない。

GitHub実状態：public repo、production未作成（GET 200/0件、個別GET404）。公開repoで本人reviewを使える一般仕様は公式確認、本人の実承認とplan名は未確認。RESTの公開schemaにないcan_admins_bypassを勝手な自動判定に使わず、**UIで「Allow administrators to bypass…」を外して確認**する。CD側はjob名だけでなくGitHubに残る本人のproduction承認記録を必須にする。確認/権限/履歴が取れない場合は配信せず、固定digestを本人が承認する手動運用へ戻す。

合格：Linuxの模擬CD/拒否/rollback/初回legacy移行62件、型検査、業務42件、実Compose解析5分類、Docker内Next build、実Nginxの構文検査。GitHubや本番Nginxへの実切替試験ではない。新しいソースへの変更があるたびに関係する検証だけ再実行し、以前の成功を足して件数を増やしていない。

CDのswap確認は、Dockerのnamespace内とhost上のsystemdで参照先が異なるため、/proc/self/cgroupから自分のgroupを求めて/sys/fs/cgroup配下を読むよう補正した。EC2の一時unitでも/system.slice/run-*.serviceになることを読み取り確認し、補正後のLinux62件も成功。CDそのものやGitHub API取得を実サーバーで動かしたわけではない。

### 21.5 最終状態と公開できる条件

21:21 JST：Next142.3MiB/384MiB、MySQL233.5MiB/512MiB、旧版94.19MiB/192MiB、EC2 available893MiB（host swap1MiB）。root空き約8.22GiB、DB EBS約9.63GiB。短い機能試験とアイドル時の値で、本格負荷測定ではない。新SQL控え29355Bは/srv/siteflow-mysql/backups/prepublic-20261117T122152Z/siteflow_public_app.sql。SHA256 968bcabd95f4b499708b87b3c96dd703dd6847e0a9697ac82a0f82ddef61eb49。秘密を含み得るSQLはDBコンテナ内で直接EBSへ出力し、ホストへ本文を取り込んでいない。当該正式DB控えの全table復元/EC2外保存は未検証。

公開前ゲート：

1. [S3承認案](S3_BACKUP_APPROVAL.md)を承認→既存IAMの総合確認→非公開/暗号化/Versioning/限定権限を適用→暗号文保存取得・別の空DBへ正式schema/全データ/認証/案件/会議を復元。元DBを上書きしない。
2. 公開直前の実証明書の期限/配信一致を確認。今回の予行成功を、将来の実期限延長や休止後の復活成功へ読み替えない。
3. GitHub productionの本人review/main限定/管理者bypass禁止と、読み取り専用取得認証を設定。明示承認されたsourceだけをreviewしてcommit/pushし、CIで固定digestを得る。**pushはまだ禁止**。
4. 別承認でEC2へ新script/settings/unitを常設し、paused/許可変数falseのままnginx include/stateを旧3002へ一致させる。既存Nginxをbackup→nginx -t→reload→旧HTTPS200。これも本番設定変更として先に承認する。
5. GHCRの承認済み固定digestで新3101を確認し、追加分も含むRAM/ディスク余裕、schema証跡、最新backup、rollback先を照合。最後に**本番切替の個別承認**を得て初めてNginxを3101へ切替える。失敗時は旧3002へ戻しDBを消さない。legacyの停止/削除は別承認。

現段階は「候補/ブラウザー/復旧の正例とCDのローカル準備が完了」であり、一般公開切替可能の全条件が満たされた状態ではない。S3の承認待ちは勝手に承認済みとしない。決定事項・招待・進捗差分など未完成機能は引き続き未完成。

参照：[Certbot renewとdeploy hook](https://github.com/certbot/certbot/blob/main/certbot/docs/using.rst)、[GitHub環境の設定](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)、[実runの承認履歴API](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run)。2026-11-17確認。S3単価/保存条件は専用承認書の公式参照と取得日時を参照。

## 2026-11-18：正式DBのS3保存成功・本人復号待ち

ユーザーがCloudShellでS3/IAM作成と設定読み戻し成功を報告。CodexはEC2ロールの実効List/Put/Getを確認した。EC2ロールに管理設定の読取権限やGetObjectVersionは追加していない。S3/IAM全設定の確認はユーザー実行のCloudShell結果に基づく。

- 保存確認：2026-11-18 19:55 JST（10:55 UTC）。正式DB siteflow_public_app、InnoDBの全16テーブル。ユーザー1、案件2、session0。
- バケット：siteflow-db-backups-173291123374-ap-southeast-2（ap-southeast-2）。オブジェクト：protected/20261118T105451Z-ca777913/siteflow_public_app.sql.gz.age
- VersionId：jdfp5GyziCeQ8GI3j9Ork9GO4ECB4Y0v。暗号文 4289 bytes。SHA-256：ba364bb8846b384c0d9c37be5730ce99ba887a25247283263e8fdd1a1f3da984
- 目録：protected/20261118T105451Z-ca777913/manifest.json。VersionId：cmEVaTlCUoh18SYhelDfHaPyeX.XWEEv。SHA-256：ffe3ad05cf6bdeec8d9722f0033b166e21f7b8d83c4635ef1caddffd603dd915
- SSE-S3 AES256。single PUTのIf-None-Match:*で同名上書きを防止。S3から取得したVersionId・サイズ・暗号化方式・SHA256 checksumが一致。目録も再取得して版とハッシュ一致。
- MySQL専用ユーザー sf_s3_backup：正式DBのSELECT/SHOW VIEWのみ、REQUIRE SSL。接続設定は暗号化EBSのsecrets/s3-backup-client.cnf、root0600。認証値は出力・記録しない。
- dump --single-transaction --quick --skip-lock-tables --no-tablespaces --set-gtid-purged=OFF --column-statistics=0 --skip-triggers --skip-events --skip-add-drop-table --hex-blob --order-by-primary。16テーブルがInnoDB、trigger/routine/eventなしと確認。整合した読取専用snapshotを使い、復元先を強制するCREATE DATABASE/USEを含めない。DDLが並行実行されないことも運用条件。
- gzip -nはgzip圧縮時のファイル名・時刻を付けない指定。age --recipients-fileは公開鍵の宛先を読み、復号鍵なしで暗号化する。公式age v1.3.2 Linux archive SHA256 cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10 と照合。
- 一時backupコンテナ：192MiB上限、memory-swapも192MiBでswap禁止、core=0、log-driver=none、read-only、cap-drop ALL。SQL平文ファイルを新規作成せずdump→gzip→ageをパイプ接続した。
- 全16テーブルの行数・データハッシュ・DDLハッシュが前後で一致。比較用の行データはDBコンテナ内だけでハッシュ化。旧公開/候補/MySQLのID・開始時刻・Nginx設定は不変、旧HTTPS200。
- 処理中の最低MemAvailableは824307712 bytes（約786MiB）。終了時MySQL243.1MiB、Next146MiB、旧Vinext97.49MiB。暗号化EBS空き約9.63GiB。小さな架空DBの観測であり、将来負荷の保証ではない。
- EC2記録：/srv/siteflow-mysql/backups/s3-20261118T105451Z-ca777913/result.json。ローカル確認控え：work/s3-backup-result.json。暗号文と目録を保持し、古いデータやbackup用停止コンテナは削除していない。

### 次の本人操作：VersionId指定の取得とPC上の非表示入力

CloudShellで以下を実行する（S3読み取りのみ）。--bucketは対象bucket、--keyは保存パス、--version-idは今回の固定版、--expected-bucket-ownerは所有者の取り違え防止、--regionはSydney、--checksum-mode ENABLEDはS3 checksumの取得、最後の引数は暗号文のローカル保存名。

~~~bash
aws s3api get-object --bucket siteflow-db-backups-173291123374-ap-southeast-2 --key protected/20261118T105451Z-ca777913/siteflow_public_app.sql.gz.age --version-id jdfp5GyziCeQ8GI3j9Ork9GO4ECB4Y0v --expected-bucket-owner 173291123374 --region ap-southeast-2 --checksum-mode ENABLED siteflow-db-20261118T105451Z-ca777913.sql.gz.age
~~~

CloudShellのアクション→ファイルのダウンロードで末尾のファイル名を指定し、WindowsのDownloadsへ保存する。既存同名があれば上書きせず別名とし、補助スクリプトへ引用符付きの第1引数で実パスを渡す。ファイルは暗号文なのでCloudShell/PCにも秘密鍵は送らない。

~~~powershell
node "C:\Users\syucream\Projects\siteflow\work\decrypt-siteflow-s3-backup.mjs"
~~~

nodeはローカル補助スクリプトの実行。既定でDownloadsの上記暗号文を読み、サイズ/ハッシュと暗号化済みidentityの指紋を照合。YESは固定版取得済みの本人確認であり、パスフレーズではない。パスフレーズはageの非表示プロンプトにだけ入力する。平文backupをPCへ保存せず、復号したgzipをSSHの匿名パイプ経由で暗号化EBSのrestore-input.sql.gzへ送信し、gzip破損検査後に確定する。age失敗時は確定しない。秘密鍵はEC2へ送らない。

SSHは既存鍵、BatchMode=yesで対話SSH認証を使わず、StrictHostKeyChecking=yesで登録済みhost鍵を照合、ConnectTimeout=10で接続上限10秒、ServerAliveInterval=15/ServerAliveCountMax=2で切断を検出する。受信コンテナはnetwork none、64MiB/swap禁止、core=0、ログなし。

### 未検証・中止条件・元へ戻す考え方

**今回の正式DB backupの本人復号、固定VersionId指定での運用者取得、別DBへのTLS復元、復元した16テーブルと外部キーの照合、復元側ログイン/案件操作は未実施。** 補助スクリプトは構文と非対話時の停止だけ確認した。復元成功とは扱わない。日次自動実行・7世代整理・30日Lifecycle実経過・protected/configの復旧も未検証。

失敗時は再実行/削除/権限拡張をせず停止する。元DB/既存公開は今回変えていないため切り戻し操作は不要。今回のバックアップ用ユーザーは読み取り権限のみで、不要なら別途承認を受けロックする。鍵/パスフレーズ紛失時は過去暗号文を新しい鍵では復元できない。

費用：新規EC2/KMS等なし。protectedの暗号文とJSON目録、PUT/GETがS3使用量へ加算され、protectedは自動削除されない。今回の数KBだけの保存・少数要求の計算上は月0.01USD未満だが請求実績は未照会。従来の100〜256MiB×40個の試算（月約0.11〜0.26USD等）と区別する。

公開前には正式DB復元合格、最新HTTPS証明書の期限/更新確認、承認付きCDの実設定・動作確認、切替承認が残る。2026-11-18のコンソール表示は残額78.78USD/無料プラン期限2027-04-08だったため、以前報告のcredit有効期限2027-10-07とは別条件として再確認が必要。アップグレードや契約変更はしていない。

## 2026-11-18 20:12 JST：本人復号成功後、復元前のSQL確認で停止

本人の非表示入力によるage復号・SSH転送・gzip整合性検査は成功。入力は暗号化EBSの `/srv/siteflow-mysql/backups/s3-20261118T105451Z-ca777913/restore-input.sql.gz`（4,089 bytes）。秘密鍵/パスフレーズはEC2へ送っていない。根拠は work/s3-personal-decryption-result.json と同EBSのpersonal-decryption-receipt.json。

新しい空DB siteflow_restore_s3_20261118t105451 への復元処理を開始したが、dump-safety-review段階の専用コンテナがexit1で停止した。入力はroot所有0600なのにコンテナ実行ユーザーはnode、cap-drop ALLで読み取り権限がないという設定不一致を確認。OOMではない。生のstderrや秘密情報を表示していない。**正式DBへの書き込み・復元DB作成・復元用ユーザー作成・SQL取込・アプリ起動は未実施。**

読み取り確認で復元DB存在数0、復元ユーザー存在数0。旧Vinext/Next候補/MySQLのIDと開始時刻は維持、MySQL healthy、HTTPS200。停止したSQL確認コンテナと復号済み入力は保持。記録は `/srv/siteflow-mysql/backups/restore-check-20261118T111216Z/failure.json`、work/s3-restore-failure-check-result.json。

work/s3-restore.py に、SQL確認だけ network none / read-only bind / cap-drop ALL / no-new-privileges / 128MiB・swap禁止を維持してuser0:0とする修正を用意した。他のアプリ確認コンテナのユーザーや入力ファイル0600は変更しない。**修正後の再実行はしていないため、修正で解消したとは未判定。** 承認後は入力と空DBのガードから再確認し、16テーブル・外部キー・ログイン/案件操作を続ける。誤ったDBへの変更を伴う切り戻し操作は不要。

## 2026-11-18：読取権限修正の検証成功・別DB取込後の定義比較で停止

今回のユーザー承認はファイル保護を維持する最小修正と復元検証の再開。修正範囲超過または再エラー時は停止・報告する条件に従った。

### 権限修正と事前検証（成功）

SQL確認用コンテナだけuser0:0に変更。network none、read-only rootfs、cap-drop ALL、no-new-privileges、128MiB/swap禁止、core=0、log-driver noneは維持。入力restore-input.sql.gzはroot:root0600のまま。唯一のホストbindは同ファイルを/run/input.gzへreadonlyで渡すもの。読取可・書込不可、無関係のホスト秘密ファイルが見えないことを実確認した。chmod777、広い権限緩和、公開ディレクトリへの秘密コピーはなし。アプリ確認用もcheck-candidate.mjs/account.jsonの単一ファイルbindへ絞った。根拠：work/s3-restore-access-result.json。

### TLS取込と停止地点

復元先siteflow_restore_s3_20261118t105451が正式DBと異なり未存在であることを確認し、新規作成後にテーブル数0を再確認した。dump内のCREATE DATABASE/USE/DROP等・正式DBへの修飾参照がないこととCREATE TABLE16件を確認。専用loaderに対象DBだけSELECT/INSERT/CREATE/ALTER/INDEX/REFERENCES/LOCK TABLESを付与し、VERIFY_IDENTITY付きTLSでgzipをストリーム取込した。LOCK TABLESはdumpが出力する取込時ロックのため。DROP/DELETE/UPDATE/global/grant権限は付けない。取込成功後loaderをACCOUNT LOCKし、再接続不可にした。

整合性比較でRESTORED_DATA_OR_SCHEMA_DIFFERS_FROM_S3_BACKUPとなったためfull-integrity段階で停止。失敗記録：/srv/siteflow-mysql/backups/restore-check-20261118T113549Z/failure.json。復元DBやデータの削除・再取込はせず、復元アプリは起動していない。runtimeユーザーは作成済みだがCRUD権限付与前、接続REQUIRE SSL。認証ファイルは暗号化EBS上の/srv/siteflow-mysql/secrets/s3-restore-restore-check-20261118T113549Z/に本人限定で保持し値は記録しない。

### 追加の読み取り調査（実測）

- 正式DBの16テーブルの行数・データハッシュ・DDLハッシュはS3バックアップの目録と完全一致。正式DB不変を確認。
- 復元16テーブルの行数・データハッシュはすべて一致。raw SHOW CREATE TABLEの文字列ハッシュだけ全16件で不一致。
- information_schemaの列134行（型/NULL/default/charset/collation等）、インデックス90行、テーブル16行（engine/collation/row format/create options）の定義は一致。
- 外部キー27個の定義が一致し、複合キーとNULLを考慮した参照先不存在行は0。
- 全16件のSHOW CREATE TABLEから冗長な「 CHARACTER SET utf8mb4」明示部分を除いて比較すると一致。実定義が異なる根拠は今回の比較では見つからず、同じ設定の明示/省略をraw文字列比較が不一致としたもの。データ破損と扱わない。
- 旧Vinext/Next候補/MySQLのIDと開始時刻を維持、Nginx設定不変、MySQL healthy、HTTPS200。秘密鍵/パスフレーズ送信、公開切替、EC2再起動、Git pushなし。

根拠：work/s3-restore-integrity-check-result.json、work/s3-restore-metadata-result.json。追加調査は読み取りのみ。比較処理をEC2で変更したり復元処理を再実行したりしていない。

### 未完了と再開案

ログイン・案件作成/保存/再取得・ログアウト、復元側CHECK TABLE16件の一括検査、アプリ試験完了後のruntimeロックとリソース集計は未実施。復元試験全体を合格とは扱わない。

次の承認対象案：データハッシュの完全一致は維持し、DDLは列・インデックス・外部キー・テーブル実定義の一致と、条件を限定した冗長なcharset明示の扱いで検証する比較処理へ修正する。文字列を無条件に削って済ませず、charset/collationの実定義一致も必須にする。既存の復元DBを削除/上書き/再取込せず、読み取り確認から続け、復元DBだけにCRUD権限を付与して非公開アプリ試験を行う。これは今回の「ファイル読取権限修正に限る」を超えるため未実施。

## 2026-11-18：比較修正の合格後、復元アプリのDB命名チェックで停止

承認された比較修正をwork/s3_schema_compare.pyへ実装。実効定義を比較して一致を必須とした後だけ、引用符で囲まれた値/名前を保護し、COLLATEに続く冗長なCHARACTER SET utf8mb4明示を限定的に正規化する。データハッシュは無変更で比較。型/NULL/default/collation/index/FK/引用文字列の差と実効確認前の拒否を含む9テスト成功。列コメント、table comment、TABLE_CONSTRAINTS/ENFORCED、REFERENTIAL_CONSTRAINTS/UPDATE_RULE/DELETE_RULEも照合対象に追加した。

既存復元DB siteflow_restore_s3_20261118t105451 を再利用し、再取込はしていない。実効定義・全16テーブルデータ比較、27外部キーの定義比較と孤立行0、CHECK TABLE16件は実行順序上すべて通過し、integrity-before-app.jsonを保存した。記録：/srv/siteflow-mysql/backups/restore-resume-20261118T115655Z/。

その後、復元DBの15業務テーブルだけに専用ユーザーsf_restore_runtime_1118のCRUDを付与。正式DB、_prisma_migrations、global、DDLの権限は付けない。独立auth secret・専用DB passwordは暗号化EBSの400:1000ファイルをreadonlyで渡し、環境変数にはファイルパスだけ。検証用Next.jsを公開portなし、384MiB/swap禁止、core0/logなしで起動し、同じnetwork namespaceからHTTP確認を実行したがexit1となり停止した。

examples/mysql/public-api-settings.tsのreadPublicApiSettingsはDB名に ^siteflow_public_[a-z0-9_]+$ を要求する。今回の復元DB名siteflow_restore_s3_20261118t105451は合致しないことを確認。これは設定取り違えを防ぐ既存の安全チェックであり、比較コードの問題とは別。検証DB名を決める際に事前照合できていなかった。安全チェックを緩和していない。生のログや認証情報を表示していない。

### 停止後の読み取り確認

- 正式DBの16テーブル/行数/データ/DDLはS3目録と一致。復元DBの行数/データもS3目録と一致。案件2件、session0件。
- 新検証アプリとHTTP checkerは停止、OOMなし、公開portなし、ログなし。元のVinext/Next候補/MySQLはID・開始時刻を維持、MySQL healthy、Nginx設定不変、HTTPS200。
- loaderは前段階でlocked。runtimeには復元DB内の15テーブルだけSELECT/INSERT/UPDATE/DELETEがあり、今回は停止時点で追加のロック/権限変更をしていない。認証情報・backupファイルは暗号化EBS上に保護したまま保持。
- 秘密鍵/パスフレーズ送信、DB再取込、正式DB変更、公開切替、EC2再起動、Git pushなし。

根拠：work/s3-compare-test-result.json、work/s3-resume-failure-check-result.json、同EBSのfailure.jsonとintegrity-before-app.json。9テストと実定義比較は合格だが、復元側ログイン・案件操作・ログアウトと復元試験全体は未合格。

### 次の承認対象案（未実施）

アプリの安全チェックを維持し、命名規則に適合する新しい専用DB siteflow_public_restore_s3_20261118 を空で作り、同じ復号済みbackupを1回だけ取込む。既存の復元DBを削除/上書きしない。専用ユーザーを新DBだけへ限定し、比較修正済みの方法と非公開アプリで再検証する。名前のpublicは内部の命名規則で、DBの外部公開は行わない。新しいAWSリソースや契約は不要。今回の既存復元DB再利用条件を変更するため、承認前に実行しない。

公開前には復元側のアプリ試験合格、最新証明書/更新確認、承認付きCDの実設定/実動作、公開切替承認が引き続き必要。決定事項・招待・進捗差分等の未完成機能を完成済みに扱わない。

## 2026-11-18：適合名の新DBへ1回取込成功・確認用HTTPのHost送信不備で停止

明示承認後、siteflow_public_restore_s3_20261118 の未存在を確認して新規作成し、テーブル数0を再確認。既存のsiteflow_restore_s3_20261118t105451と正式siteflow_public_appには書き込まない。S3 VersionId jdfp5GyziCeQ8GI3j9Ork9GO4ECB4Y0vから本人復号済みの同一gzipを1回だけVERIFY_IDENTITY付きTLSで取込。DB名ポリシーは変更しない。

新loader sf_public_restore_loader_1118 は新DBだけSELECT/INSERT/CREATE/ALTER/INDEX/REFERENCES/LOCK TABLES、取込後ロック。新runtime sf_public_restore_runtime_1118 は新DBの15業務テーブルだけSELECT/INSERT/UPDATE/DELETE、DDL/global/_prisma_migrationsの操作権限なし。秘密値は暗号化EBSのs3-restore-restore-check-20261118T121749Zディレクトリに保管し、アプリ用ファイルはuid1000/0400を維持。

全16テーブルの行数/データ、実効の列/型/NULL/default/charset/collation/インデックス/制約の一致、外部キー27個と孤立参照0、CHECK TABLE16件を通過し、/srv/siteflow-mysql/backups/restore-check-20261118T121749Z/integrity-before-app.jsonへ記録。比較修正は実効一致後だけ冗長charset表記を扱い、データや定義の差を無条件に無視しない。

非公開検証アプリを新DB用設定で起動したが、restore-app-readinessで確認コマンドが失敗し停止した。DBの再取込やアプリの再試験はしていない。MySQL側の実接続DB証明へ進む前であり、設定上の新DB接続先確認と実接続確認は区別する。ログイン/案件操作/ログアウトは未実施。

### 原因を切り分けた読み取り・独立診断

同じアプリイメージのNode v22.23.5で、network none・秘密mountなし・read-only・64MiB/swap禁止・logなしの独立コンテナを使用し、ループバック内のHTTPサーバーに送るHostを比較した。fetchは指定hostを送らず127.0.0.1:一時portとなり、http.request/http.getは指定した13.237.188.172となった。アプリのreadinessは想定外Hostを503で拒否する仕様のため、確認用コードのfetchが不適切だった。これはHost検証を外して直す問題ではない。

- 新DB・正式DB・以前の復元DBの16テーブルのデータはS3目録と一致。正式DBはDDLも目録と完全一致。新DBの案件2・session0。
- 検証アプリは停止、公開portなし、OOMなし。既存Vinext/Next候補/MySQLのIDと開始時刻は不変、Nginx設定不変、HTTPS200。
- 新アプリ設定：mysql.siteflow.test:3306 / siteflow_public_restore_s3_20261118 / sf_public_restore_runtime_1118 / TLS required。新DB以外にruntime書込権限なし。実接続DBの証明は未完了。
- 秘密鍵/パスフレーズ送信、公開切替、EC2再起動、Git push、正式DB変更、既存DB削除なし。

根拠：work/s3-public-failure-check-result.json、同EBSディレクトリのfailure.jsonとintegrity-before-app.json。

### 次の最小修正案（実行していない）

確認用readiness通信だけをfetchからhttp.requestへ変更し、既に検証済みのscripts/check-candidate.mjsと同じHost指定方式にする。アプリ本体・Hostチェック・DB名チェック・TLSチェックは変更しない。今回作成済みの新DBと専用ユーザーを再利用し、追加DB作成/再取込なしで接続先証明→ログイン/案件操作/ログアウト→検証アプリ停止/専用ユーザーロック→元DB/既存サービス比較を行う。予期しないエラー時は停止・報告というユーザー条件に従い、今回は再開しない。

復元試験全体は未合格。公開前にはこのアプリ試験完了、証明書の最新期限/更新確認、承認付きCDの実設定と動作確認、公開切替承認が残る。

## 2026-11-19 継続確認：HTTP修正は成功・無効な監視機能を使った接続確認で停止

確認用コードだけをhttp.requestへ修正。work/restore-ready-http.mjs と模擬サーバーのwork/test-restore-ready-http.mjsで正しいHostの送信と不正Host拒否を確認。アプリ本体のHost/認証/CSRF/DB名/TLSチェックは無変更。

既存DB siteflow_public_restore_s3_20261118 と既存専用ユーザーを再利用し、追加DB/ユーザー作成・権限付与・再取込はなし。runtimeの既存権限が15業務テーブル×CRUDの60件だけで、新DB外・migration表・global・schema-wide・継承roleの権限がないことを確認した。秘密ファイルuid1000/0400もガード。

実環境では正しいHostの/api/readyが200/ok:true、不正Host invalid.siteflow.testが503/ok:falseとなる確認を通過した。その後、APP_ACTUAL_DATABASE_MISMATCHで停止した。失敗記録は /srv/siteflow-mysql/backups/restore-resume-20261118T122959Z/failure.json。このエラー名だけで誤接続と断定しない。検証アプリは停止し、ログイン/案件作成は未実施。

読み取り調査で@@performance_schema=0を確認。performance_schema.threadsは0件で、接続確認コードが無効な監視表を前提にしていたことが判明。information_schema.PROCESSLISTには現行接続4件が見えている。MySQL設定を変更/再起動して監視機能を有効化していない。根拠：work/s3-connection-proof-diagnosis-result.json。

正式DBは全16テーブルの行数/データ/DDLがS3目録と一致。復元DBの行数/データも一致、案件2・session0。検証アプリ停止、OOMなし。既存Vinext/Next候補/MySQLはIDと開始時刻を維持、MySQL healthy、Nginx設定不変、HTTPS200。秘密情報出力・Git push・公開切替・EC2再起動・DB再取込なし。

### 次の限定修正案（未実施）

接続先確認SQLだけをinformation_schema.PROCESSLISTのUSER/DB列による検査へ変更する。正しいHostでreadiness成功直後に、復元用runtimeユーザーの接続がsiteflow_public_restore_s3_20261118を使用し、他DBへの接続がないことを確認。監視設定/アプリ本体/認証/CSRF/TLS/権限は変更しない。作成済みDBと保護済みcredentialsを再利用し、追加作成/再取込なしでログイン→案件作成/保存/再取得→ログアウトと旧session拒否→検証アプリ停止/専用ユーザーロック→元DB/既存サービスの最終照合へ進む。

ユーザーの「エラーが発生した場合は原因調査・修正案提示して停止」に従い、今回はクエリ修正とアプリ試験再実行はしていない。S3復元のDB整合性検証と正/不正Host確認は成功だが、実接続先証明・業務操作・総合復元合格は未完了。公開前の残りは業務操作合格、証明書最新確認、承認付きCDの実設定/実動作、公開切替承認。

## 2026-11-19 04:52 JST：S3復元後のAPI業務操作まで合格

最新の結論：**検証済みS3バックアップから本人復号・別DBへのTLS復元・DB整合性確認・復元側API操作まで成功**。前節までの「停止/未完了」は過去時点の記録。公開切替や既存EC2再起動の成功を意味しない。

### 今回の変更と接続証明

接続先確認SQLだけをperformance_schema.threadsからinformation_schema.PROCESSLISTへ変更。監視設定、MySQL、アプリ本体、Host/認証/CSRF/TLSチェック、DB名チェックは変更しない。既存の復元DBと既存の権限を再利用し、DB作成/再取込/権限拡大なし。

- 正式DB：mysql.siteflow.test:3306 / siteflow_public_app。既存候補のユーザーは変更しない。
- 復元DB：mysql.siteflow.test:3306 / siteflow_public_restore_s3_20261118。専用ユーザーsf_public_restore_runtime_1118。
- 実接続：information_schema.PROCESSLISTで専用ユーザー→復元DBが2件、他DBが0件。確認できた後だけ書込試験へ進んだ。
- 権限：15業務テーブルのSELECT/INSERT/UPDATE/DELETEだけ、60件。新DB外・_prisma_migrations・global・schema-wide・継承roleの権限なし。正式DBへの拒否を試すための書込SQLは実行しない。
- 正しいHostでreadiness200、不正Hostで503/ok:false。未認証の案件APIは401。Host拒否は/api/readyで実測したもので、全APIの全Host条件を網羅したとは扱わない。

### バックアップとDB整合性

- 保存先：siteflow-db-backups-173291123374-ap-southeast-2 / protected/20261118T105451Z-ca777913/siteflow_public_app.sql.gz.age。SSE-S3 AES256、age事前暗号化。
- VersionId：jdfp5GyziCeQ8GI3j9Ork9GO4ECB4Y0v。暗号文4,289 bytes、SHA256 ba364bb8846b384c0d9c37be5730ce99ba887a25247283263e8fdd1a1f3da984。S3再取得時の版/ハッシュ/サイズ一致は前段階で確認済み。
- 本人がVersionId指定で取得し、PCの暗号化済みage identityとBitwarden保管のパスフレーズで復号。秘密鍵/パスフレーズはEC2へ送信せず、PCへ平文backupを保存せずSSHで暗号化EBSへ転送。gzip検査成功。
- 新DBが未存在→新規作成→テーブル0件を確認して、同じbackupを1回だけVERIFY_IDENTITY付きTLSで取込済み。今回は作成済みDBを再利用しただけ。以前の復元DBも削除/上書きしない。
- API試験前に16テーブルの行数・データハッシュがS3目録と一致。134列の型/NULL/default/実効charset/collation等、90行のインデックス情報、54テーブル制約、27外部キー制約情報と削除/更新規則が一致。
- SHOW CREATE TABLEは、実定義一致後だけ冗長なCHARACTER SET utf8mb4表記を正規化して一致確認。実際の定義差や引用値を削らない9テスト成功。
- CHECK TABLE16件成功、外部キー27個、孤立参照0件。空のMeeting等のテーブルは構造/0件一致の確認であり、会議データが入った場合の完全復元試験とは区別する。

### 復元アプリの業務操作（実施済み）

1. 正Hostreadiness200・未認証401、実接続先と権限を確認。
2. 復元済みの架空アカウントでログイン。Secure/HttpOnly session Cookieと案件取得を確認。
3. 復元DB内に検証案件1件を作成。ID 013eda8f-17c2-4637-929c-0e05b23dbf53。進捗25%に保存し、再取得でも25%を確認。
4. ログアウト成功、同じ旧sessionで401、DB内session0件を確認。
5. 外部公開portのない検証アプリだけを停止。今回の新loader/runtimeユーザーは両方ACCOUNT LOCKで、再接続できない状態にした。復元DB/検証案件/停止コンテナ/保護ファイルは記録として保持。

実行経路はDockerの検証アプリと同じnetwork namespace内のHTTP。既存checkerの返却scopeは汎用のSSH説明だが、今回はPCブラウザーやNginxの経路切替では試験していない。既存テストを成功後に再実行していない。

### 安全性・資源の測定結果

正式DBの16テーブル/行数/データ/DDLは前後で完全一致。以前の復元DBも完全一致。既存Vinext/Next候補/MySQLのID・開始時刻、Nginx設定は不変、MySQL healthy、HTTPS200。秘密情報は出力せず、公開切替・EC2再起動・Git push・CD反映なし。

最低MemAvailable 732192768 bytes（約698MiB）。試験中MySQL253.9MiB/512MiB、既存Next146.1MiB/384MiB、旧Vinext95.64MiB/192MiB、検証Next159.5MiB/384MiB。暗号化EBS空き約9.62GiB。小さな架空データでの観測であり同時利用・負荷の保証ではない。

根拠：work/s3-processlist-validation-result.json、EC2の /srv/siteflow-mysql/backups/restore-resume-20261118T195130Z/result.json、同directoryのhost-checks.json/app-connection-proof.json/integrity-before-app.json。結果のutcは2026-11-18T19:52:09.594351+00:00。

### 未検証事項と本番公開までの残作業

- 復元側のPCブラウザーUI/公開Nginx経由HTTPS操作は今回未検証。既存候補の過去のブラウザー確認とは区別する。
- 日次自動バックアップ/7世代整理の常設と連続実行、Versioning/Lifecycleの実日数経過、非空会議データや大量データ、障害中の復元・所要時間の目標は未検証。S3に1件保存/復元成功したことと区別する。
- 検証DBと同一MySQL/EC2が稼働する条件での復元試験。別EC2・EBS全損からの再構築、秘密設定/TLS構成の復旧、実EC2停止/再開は未検証。age鍵/パスフレーズを失うと旧backupは復号できない。
- 公開前の優先順：HTTPS証明書の最新期限と自動更新の確認→公開用設定と復旧手順の最終照合→承認付きCDのGitHub/EC2への適用と承認動作確認（または承認付き手動配信）→公開切替の個別承認→公開HTTPSで最終操作確認。
- Git push/CD本番反映・公開経路/本番設定変更・再起動等は未承認のまま行わない。2027年公開/休止は費用・無料プラン期限と復旧条件を確認して別途承認する。決定事項・招待・進捗差分等の未完成機能は完成扱いにしない。

### 2026-11-19に更新した承認ルール

原因/影響範囲が明確で本番へ影響しない、承認済み検証内の軽微なコード・読取SQL・HTTP修正、テスト、ログ/読取調査、安全な再試験は都度承認なしで続ける。正式DB操作、DB作成/削除/再取込、権限拡大、EC2停止/再起動、本番設定/公開切替、Git push/CD、秘密情報の保存先/扱い変更は事前承認。接続先不明・誤接続/誤書込疑い・秘密漏洩疑い・想定外のデータ変更・影響不明・本番異常は必ず停止。AGENTS.mdにも記録し、過去の細かい停止記録と現在の運用ルールを区別する。

## 2026-11-19：HTTPS証明書の実配信・自動更新を読み取り確認

**結論：証明書は自動更新済みで、現在の期限は 2026-11-25 03:18:43 JST。今すぐ手動更新する必要はない。** 証明書更新、dry-run、Nginx設定変更、reload/restart、AWS設定変更、Git pushはこの調査では実行していない。11月17日記録の11月21日期限は過去の証明書の情報。

### 1. 実配信証明書とCertbot証明書の一致

- PCから https://13.237.188.172/ へ通常の証明書検証付きでGET。2026-11-19 05:09:07 JST確認、HTTPS200、TLS1.3、証明書検証成功。-kやrejectUnauthorized:falseは使わない。
- 現在のnotBefore：2026-11-18 11:18:44 JST（UTC 2026-11-18T02:18:44.000Z）。notAfter：2026-11-25 03:18:43 JST（UTC 2026-11-24T18:18:43.000Z）。確認時点の残りは約142時間。notBeforeは有効開始で、実際の更新処理完了時刻とは区別する。
- 発行元：Let’s Encrypt YE2。SANにIP Address:13.237.188.172。serial：06A9B482C31AD2F406EF035009FD1574A32C。SHA256指紋：5e5a9e165b6b1a2a4c2e8c20f2a3742e0396eb4e7a117426c7798096d1009a0f。
- EC2の/etc/letsencrypt/live/13.237.188.172/fullchain.pemの葉証明書と、PCで取得した実配信証明書のSHA256/serial/期限が一致。Nginxのssl_certificateもこのliveパスを参照。現在の実体は/etc/letsencrypt/archive/13.237.188.172/fullchain12.pem。秘密鍵ファイルは読んでいない。

### 2. 自動更新の設定・タイマー・直近ログ

- Certbot 5.8.0（既存venv）。renewal設定はwebroot、/var/www/letsencrypt、Let’s Encrypt本番ACME endpoint、preferred_profile=shortlived、ECDSA。今回は約6日16時間の短期証明書であり、90日有効という前提を置かない。
- certbot-renew.timer：enabled/active/waiting。OnCalendar=*-*-* 03,15:00:00、RandomizedDelaySec=30m、Persistent=true。EC2のタイムゾーンUTCで毎日03/15時が基準（JST12/00時）、最大30分のタイマー遅延あり。Persistentは停止中のタイミングを再開時に補う設定で、EC2停止中に更新できる意味ではない。
- 最終timer起動：2026-11-19 00:00:31 JST。service終了00:00:33 JST、Result=success/ExecMainStatus=0。oneshot serviceがinactive/deadなのは実行完了後の正常な待機状態。ExecMainCode=1は終了形式であり、終了ステータス1と混同しない。
- 観測時点の次回timer予定：2026-11-19 12:03:33 JST。更新処理の完了時刻はタイマー起動予定と同じとは限らない。
- 通常実行：/home/ec2-user/certbot-venv/bin/certbot renew --quiet。更新時期でなければ見送る。
- 実更新成功：2026-11-18 12:17:17 JST。Certbotログにrenewal successと既存deploy hookの実行があり、Nginx journalにも同時刻のreload開始/完了がある。既存hookはsystemctl reload nginxのみ。pre/post hookなし。
- 直近の2026-11-19 00:00:33 JSTはnot due / no renewals attempted / no renewal failures。失敗ではない。初回の広い分類がNo renewal failuresもrenewalFailedに数えたため、読み取り抽出だけ修正し正確な文で確認した。ログ全文、ACME token、鍵は表示していない。
- タイマー有効という設定だけでなく、期限が延長された実配信証明書と自動更新・reloadの実績を確認した。ただし将来の失敗が起きない保証ではない。

### 3. 既存サービスの正常性・未変更

Vinext/Next候補/MySQLのID・開始時刻を調査前後で比較し不変。MySQL healthy、候補の/api/readyは正Hostで200/ok:true（DB読取確認）、公開HTTPS200。Nginx設定SHA256は2c874b818a1e865283f62cec2e61478d3c4d104beb523bb700e58815bd64d595で不変。DBへの書込やログイン試験は実行していない。

### 4. 今すぐ必要な対応

手動renew/force-renewalやNginx変更は不要。現行の更新経路を維持し、本番公開直前にも外部証明書とEC2 live証明書の指紋・期限・HTTPSを再照合する。短期証明書なので今回の確認を2027年まで有効なものとして扱わない。

EC2を休止すれば更新処理は動かない。2027年の再公開時はEIP、時刻同期、HTTP-01の到達性、タイマー、証明書の実期限を確認し、必要な更新・reloadは事前承認後に実施する。期限切れ証明書をブラウザーの警告回避や検証無効化で通さない。

### 5. 将来、更新が必要になった場合の承認用手順（未実施）

1. 外部/EC2指紋・期限、Certbot実行中の有無、Nginx設定/コンテナID/開始時刻、HTTPS200/候補ready200/MySQL healthyを記録。HTTP-01で使う80番と/.well-known/acme-challenge/の既存webroot経路を確認する。ルーティングを変えない。
2. 対象lineageとrenewal設定を、対応する4つのliveリンクとarchiveの証明書/鍵の組が分かる形で保護バックアップする案を提示する。保存先は既存暗号化EBSのroot0700領域、ファイル0600、Git/チャット/ログへ秘密を出さない。秘密情報の保存先を追加する行為なので、バックアップも実更新・成功後hook reload・結果検証・必要な切り戻しとまとめて事前承認を得る。この調査ではコピーしない。
3. nginx -tで現設定を確認し、承認済みの対象だけCertbot renewを実行。通常の時期判定を尊重し、--force-renewalは既定で使わない。更新不要でexit0なら、新しい期限になったとは扱わない。
4. 下記は将来の承認後の実行案で、今回は未実行。過去の手動予行で用いた一時unitと同じ制限を想定する。実行中のtimer処理と衝突する場合は停止/強制解除せず待って照合する。

~~~bash
sudo systemd-run --quiet --wait --pipe --collect --property=MemoryMax=256M --property=MemorySwapMax=0 --property=LimitCORE=0 --property=RuntimeMaxSec=180 /home/ec2-user/certbot-venv/bin/certbot renew --cert-name 13.237.188.172 --non-interactive --no-random-sleep-on-renew
~~~

sudoは対象の管理操作、systemd-runは一時unit、--quietは管理メッセージ抑制、--waitは終了待ち、--pipeは出力受取、--collectは完了した一時unitの管理情報回収。MemoryMaxは256MiB上限、MemorySwapMax=0はswap禁止、LimitCORE=0はcore抑止、RuntimeMaxSecは180秒上限。renewは既存更新設定を使い、--cert-nameはこのIPのlineageだけを対象、--non-interactiveは質問待ちをしない、--no-random-sleep-on-renewは手動実行時だけCertbot側のランダム待ちを省く。ログは内容を分類して記録し、秘密を含みうる生の例外/ACMEログを表示しない。期限判定で見送られる可能性と失敗の可能性があり、タイマー設定を変更するコマンドではない。

5. 成功時は既存deploy hookによりNginxがreloadされる。Nginx停止やDocker全体の再起動、候補/DB再起動は不要。新証明書を配信していることは次の指紋照合で確認する。

### 6. 更新後の合格条件と失敗時の切り戻し

- PCから通常のTLS検証付きHTTPS200。SANが同じIP、期限が将来で更新前より延び、外部leaf指紋/serialとEC2 liveの指紋/serialが一致。Nginxが新証明書を配信していることを確認する。
- certbot service正常/更新成功ログ、deploy hookとNginx reload成功、timerがenabled/activeのまま。Nginx設定hashが不変。候補ready200、MySQL healthy、旧Vinext/Next候補/MySQLのIDと開始時刻が不変、OOMなし。
- 発行が失敗してliveが変わっていなければ、既存の有効証明書と公開を維持して停止・調査する。鍵やarchiveを削除しない。
- EC2のliveは新しいのに外部が古い場合は反映不一致。nginx -t、現行worker状態、reloadログを調査し、承認範囲内のreload以外を追加しない。
- 切り戻しは、更新前に記録した一致する証明書/中間chain/秘密鍵の組とlive4リンクを、旧証明書が有効かつ失効していない場合だけ復元し、nginx -t→承認済みreload→外部指紋/HTTPS/既存サービスを確認する。期限切れ・失効済みの旧版に戻すことを復旧成功としない。Certbot管理履歴も再照合し、復元を通常運用として放置しない。今回は切り戻し操作も未検証。

### 7. 読み取りコマンドの役割・根拠

openssl x509 -in /etc/letsencrypt/live/13.237.188.172/fullchain.pem -noout -dates -serial -fingerprint -sha256 は公開証明書だけを読み、-inが入力、-nooutはPEM本体表示なし、-datesが有効期間、-serialが識別番号、-fingerprint/-sha256が内容の指紋。秘密鍵を読むコマンドではない。

curl --fail --silent --show-error --max-time 15 --output /dev/null --write-out "%{http_code}" https://13.237.188.172 は通常のTLS検証付きHTTP取得。--failはHTTPエラーを失敗、--silentは進捗抑止、--show-errorは失敗表示、--max-timeは15秒上限、--outputは本文を保存せず破棄、--write-outは状態コードだけを出す。

systemctl showは状態の読み取り、--propertyは出す項目の限定。journalctl -u certbot-renew.service --since "7 days ago" --no-pager -o json は当該unit/直近7日/ページャーなし/JSONで取得する意味。取得した本文はそのまま出さず、時刻と分類だけを出した。今回certbot renewやdry-runを呼んでいない。

根拠ファイル：work/https-public-20261119.json、work/s3-https-audit-20261119-result.json、work/s3-https-log-clarify-20261119-result.json（初回分類の否定文誤拾いを精査した結果）、work/s3-https-readiness-20261119-result.json、work/https-certificate-check-20261119.json。直近ログだけの観測で、将来失敗通知や長期間の更新連続性は未検証。

実環境はCertbot5.8。参考：[Certbot公式renew/deploy-hook説明](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates)、[Let’s Encrypt公式の証明書chain（YE2）](https://letsencrypt.org/certificates/)。公式stableページは閲覧時5.10表示のため、実環境バージョンとは区別する。実更新方法は今回実行したものではなく、承認後の手順案。

補足：通常のcertbot-renew.serviceはMemoryMax/MemorySwapMax/LimitCOREがinfinityであり、過去の手動予行unitの256MiB/swap0/core0とは別設定。今回変更していない。リソース制限や更新失敗通知の常設は、必要性と影響を検討し別途承認する改善候補。

## 2026-11-19：承認付きCD・公開切替の最終監査

旧公開と正式DB接続は正常。GitHubのproduction未作成、新CD未導入、公開image証跡/配信補強/復帰整備と再検証が不足し、現状の自動公開切替はNO-GO。実際のGitHub CIとローカル差分、pushの影響、当日の手順、Vinextへの具体的な経路rollback、証明書再確認は [PUBLIC_RELEASE_AUDIT.md](PUBLIC_RELEASE_AUDIT.md) を参照。

今回、read-onlyとローカルの構文6件/承認record純粋テスト/Compose5項目だけを実施。Docker engine停止でLinux統合は未再実行。Git push/Actions実行/本番反映/DB変更なし。
