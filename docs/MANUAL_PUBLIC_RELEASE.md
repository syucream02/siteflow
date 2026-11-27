# Next.js初回公開：手動切り替えの準備記録

> 公開版の資料：AWSアカウント番号・環境固有の識別子・個人PCパスは伏せています。公開は手動で、自動デプロイは未導入です。以下の計測値・成功/失敗は実際の履歴ですが、仮値を含むコマンドはそのまま実行しないでください。完全な復旧用識別子は本人管理の環境記録を参照します。保留中の新CDに関するソース・設計の一部はローカルにのみあり、今回のGitHub反映対象外です。

公開用の`deploy/manual-public.py`は`UUID`と`VOLUME`を仮値にしており、そのままではEBS照合に失敗して停止します。稼働中の設定済みコピーを置換したものではありません。

2026-11-21 11:58 JST。**Next.js初回公開と公開HTTPS経由のログイン・Cookie・テスト案件操作・ログアウトに成功し、公開状態を維持。** 旧Vinextは復旧用に稼働を継続。OIDC・新CD・DynamoDB・高度な機能は今回の公開条件に含めない。既存実装と186件の過去テストを保持し、今回再実行したものと区別する。

## 最新結果：2026-11-21 11:58 JST 初回公開成功

### 変更・確認したこと（最大3項目）

1. 検証枠をアカウントの正当な所有者UID/GID1000:1000へ合わせた。秘密ファイルのmode0600は維持。検証コードを標準入力から渡し、root所有コードファイルの読取権限問題も解消した。cap-drop ALL、no-new-privileges、read-only、swap/core/log禁止を維持し、sudo/IAM権限の拡大や秘密値のコマンド引数化は行っていない。
2. 公開変更前、network noneの枠で必要なアカウント情報を読めることを確認。次に既存候補・MySQL・証明書・約38分前のS3バックアップを照合し、構文検査→3001へのreload→新worker確認→新規TLS接続で最大30秒・readiness200/ok:trueの3回連続成功を確認。公開トップの静的ファイル参照も候補と一致。
3. 公開URL経由で既存テストアカウントのログイン、Secure/HttpOnly/SameSite=Lax/Path=/api/siteflowのCookie、専用テスト案件作成、進捗37%保存・再取得、ログアウトと旧セッションの401拒否を確認。全件成功したためNext.jsの公開を維持し、切り戻しはしていない。

### 実測結果

| 項目 | 結果 |
| --- | --- |
| 公開URL | https://REQUIRES_APPROVED_PUBLIC_IP （ワークスペースは /workspace） |
| 公開先 | Nginx → REQUIRES_APPROVED_PUBLIC_IPV4:3001 → 固定済みNext.js候補 → 正式MySQL |
| readiness | 新worker PID989284/989285を確認後、200/ok:trueが3回連続成功 |
| 外部PC | Windowsから通常のTLS検証付きcurlで公開readyのok:trueを確認。証明書検証の無効化なし |
| 認証・案件操作 | 公開HTTPS経由のHTTP検証処理で全件成功。今回の実ブラウザークリック操作試験ではない |
| 既存案件 | 今回の新案件を除くProject全行の指紋が前後一致。既存案件への変更・削除なし |
| コンテナ | Next/MySQL/VinextのID・イメージ・開始時刻が準備時と一致。停止/再作成/イメージ更新なし |
| MySQL | healthy・OOMなし。DB構造変更なし |
| Nginxログ | 試験中のerror/crit/alert/emergが0件 |
| メモリ | available約819MiB。Next161.4MiB/384MiB、MySQL258.8MiB/512MiB、Vinext100MiB/192MiB |
| 空き容量 | root8.2GiB、DB用EBS9.7GiB |
| 公開後Nginx SHA-256 | 64f4a6f28a7948f3cb465bf35ab20fa6b129547bca9f778601e7da4d43abeaf5 |

テスト案件名：`PUBLIC-SMOKE-20261121T025843862Z`、ID：`REQUIRES_APPROVED_RECORDED_ID`。進捗37%。識別可能な架空データとして残した。削除していない。認証に必要なセッション作成/失効も行った。パスワード・Cookie値・既存案件の内容は結果に含めていない。

記録：EC2 `/srv/siteflow-mysql/config/manual-public-v1/switch-20261121T025840Z/result.json`、ローカル `work/manual-public-owner-result.json`。S3の直前確認はVersionId `<BACKUP_VERSION_ID>` とサイズ/checksum/SSE一致。バックアップは今回のテスト案件の作成より前であり、新しいテスト案件は含まれない。

### 残る制約

- 今回の認証試験は公開HTTPSの実APIとCookieを扱うプログラムによるもの。実Chromeでのクリック・表示・スマホ幅の公開後試験は未実施。過去の非公開ブラウザー試験と区別する。
- 初回版は11月17日の検証済みイメージ固定。最新mainとの同一性を新たに証明したものではない。
- 実EC2再起動・EBS欠損からの起動・長期ログローテーション・日次自動バックアップ常設・今回取得したバックアップの再復元は未検証。従来の別DB復元成功記録は保持する。
- 証明書は短期IP証明書。直前確認では2026-11-25 03:18:43 JSTまで有効。自動更新を維持し、休止中の更新停止や将来の更新失敗に注意する。
- 新規登録・招待、会議の差分/決定事項などは未完成。公開成功を要件全体の完成と扱わない。
- 過去の404が旧worker由来だった可能性は高いが、今回の成功で原因を確定扱いにしない。
- 今回の公開成功後は追加の切り替えをしていない。EC2再起動、Dockerイメージ更新、アプリコード/DB構造/AWS基盤/CD設計変更、Git commit/push、Actions実行なし。

検証枠の要点：`docker run --rm -i --pull=never --user 1000:1000 --read-only --memory 128m --memory-swap 128m --ulimit core=0 --log-driver none --restart no --cap-drop ALL --security-opt no-new-privileges ... --entrypoint node <固定イメージID> --input-type=module`。`-i`は非秘密コードを標準入力から渡すため、`--user`は秘密ファイルの所有者に合わせるため、`--input-type=module`はそのコードをES Modulesとして読むための指定。準備確認は`--network none`、実公開HTTPS試験だけ`--network host`を使う。秘密値は引数や環境変数へ展開せず、指定ファイルのread-only mountから検証枠のメモリ内だけで扱う。`--rm`で削除するのはこの一時枠だけであり、既存コンテナではない。その他のオプションの目的とリスクは後述の補足を参照。

## 過去の結果：2026-11-21 11:50 JSTの1回限りの再試行

### 今回変更したこと（検証処理のみ）

1. reload後、新workerのPIDを確認し、TLS接続を毎回新規作成・明示closeして最大30秒以内にreadiness200/ok:trueを3回連続で確認するよう修正。
2. 旧・新画面の静的ファイル参照一覧を比較し、成功側はNext.js、切り戻し側はVinextへ到達したことを確認。HTTPS200だけを版の識別に使わない。
3. 途中の404・連続成功・期限切れ・新worker未出現・TLS失敗・新規接続・旧版識別など10件のモック試験をメモリ内で実行し全件成功。アプリコード・Dockerイメージ・DB構造は変更していない。

### 実際の結果

- 既存イメージ・候補ready・MySQL healthy、S3保存版のVersionId/サイズ/checksum/SSEと経過6時間未満、証明書の外部/live一致と残り24時間以上、メモリ600MiB超・ディスク余力・Nginx退避一致の確認を通過。
- 3002→3001変更、構文検査成功後reload、新worker確認を実施。
- **公開 `/api/ready` は02:50:53/54/55 UTCに200で3回連続成功。検証コードでもok:trueを確認。公開トップの静的ファイル参照も候補と一致。** 以前の404の原因が旧workerだったと確定したわけではない。
- その後、一時検証枠は`phase=account`で停止。ログイン・Cookie・テスト案件作成/保存/再取得/ログアウトには進んでいない。新しいテスト案件・セッション・業務書き込みなし。
- アカウントファイルはUID/GID1000:1000・mode0600。一時検証枠はuser0:0・cap-drop ALLで、所有者限定ファイルを読めない構成だった。秘密値を読んだり、権限を緩めたりしていない。元の例外詳細は秘密保護のため抑制されているが、このアクセス不能な組み合わせを読み取りで確認した。
- 退避設定へ戻し、構文検査→reload→新worker確認後、**旧画面の静的ファイル参照一致とHTTPS200を3回連続確認**。切り戻し成功。
- 切り戻し後も3コンテナのID/開始時刻不変、MySQL healthy、直接ready200、Nginx内容は退避設定と一致。試行時刻のNginx error以上0件、available約890MiB、root空き8.2GiB/DB用EBS9.7GiB。

記録：EC2 `/srv/siteflow-mysql/config/manual-public-v1/switch-20261121T025053Z/failure.json`。ローカル `work/manual-public-retry-result.json`、`work/manual-public-retry-postcheck.json`、`work/test-switch-verifier.py`。実処理は今回1回だけで、追加公開試行は行っていない。

### 次の最小修正案（未実施・別承認）

検証枠の実行ユーザーを1000:1000へ合わせ、検証コードもそのユーザーが読める形で渡す。アカウントファイルの所有者/mode600、read-only mount、cap-drop ALL、swap/core/log禁止は維持する。現在の検証コードはroot所有0500であるため、ユーザー指定だけを変えて済ませず、非秘密のコードの渡し方も合わせる必要がある。新しいアカウントやDB権限は不要。

まず公開経路を変えずに、検証枠が必要な入力を読めることだけを確認する案。次の公開再試行は本人承認後に1回だけ行う。今回の公開結果は**未完了・現在の公開はVinext**。

## 過去の結果：2026-11-21 11:33 JSTの公開試行と切り戻し

1. 直前確認は合格。候補ready200/MySQL healthy、既存3コンテナのID・開始時刻一致、空きメモリ約879MiB、root空き8.2GiB/DB用EBS9.7GiB、退避Nginx内容一致。約10分前のS3バックアップをhead-objectで確認しVersionId/4,290 bytes/SHA-256/SSE-S3一致。
2. 外部証明書とEC2 liveの指紋一致。期限2026-11-25 03:18:43 JST、certbot-renew.timer active/enabled。更新操作は不要として実施していない。
3. Nginxの転送先1か所を3002→3001へ原子的に置換。nginx -t成功後、reloadを実施した。
4. 直後の公開HTTPS `/api/ready` が404となり、検証を中断。自動で退避済み設定を復元し、nginx -t→reload→旧HTTPS200を確認した。新たな修正や再切り替えは行っていない。
5. 切り戻し後も候補の直接readinessは200、MySQL healthy、3コンテナのID/開始時刻不変、Nginxの内容は退避設定と完全一致。コンテナの削除・停止・再作成なし。

**今回のログイン・認証Cookie・テスト案件作成/保存/再取得/ログアウトは未実施。** readinessの段階で中断したため、新しいテスト案件・ログインセッションは作っていない。正式DBの業務データへの書き込み・構造変更は行っていない。

原因は未確定。公開経路では404、同じ候補への直接通信は200という事実を確認した。reload直後に旧workerへ到達した可能性などはあるが、検証せず原因と断定しない。Nginx・アプリを無断で修正していない。次は公開経路とreload完了確認を読み取りで絞り込み、必要な検証処理変更と再試行を本人承認後に行う。

記録：EC2 `/srv/siteflow-mysql/config/manual-public-v1/switch-20261121T023348Z/failure.json`、ローカル `work/manual-public-switch-result.json` / `work/manual-public-rollback-verification.json`。これらは秘密情報を含まない結果のみ。準備時のバックアップ・起動保護・状態記録は維持する。

切り戻し後のメモリ：available約886MiB、ディスク空きはroot8.2GiB/DB用EBS9.7GiB。公開URLは引き続き https://REQUIRES_APPROVED_PUBLIC_IP （Vinext）。本番Next.js公開の判定はNO-GO。

試行時刻02:33〜02:34 UTCについて、Nginx error.logの末尾128KiBを確認しerror/crit/alert/emergは0件。アクセスログには公開readinessの404を確認した。生ログや個人情報は文書へ保存していない。状態記録timerはactiveを維持。

## 固定した初回公開版

| 項目 | 値 |
| --- | --- |
| EC2 / region | i-<INSTANCE_ID> / ap-southeast-2 |
| 公開URL | https://REQUIRES_APPROVED_PUBLIC_IP |
| 候補 | siteflow-next-candidate / REQUIRES_APPROVED_PUBLIC_IPV4:3001 |
| コンテナID | 73f46217da34222bc4ed6ccf5f5273b036f33f152531b8c5fe2448d31fb340b5 |
| イメージID | sha256:REQUIRES_APPROVED_CERTIFICATE_FINGERPRINT |
| 作成日時 | 2026-11-17 11:00:46 UTC |
| Git SHA | OCI revisionなし。最新mainとの同一性は未証明。検証済みの既存候補を初回版として本人採用 |
| 正式DB | mysql.siteflow.test:3306 / REQUIRES_APPROVED_DATABASE_NAME / REQUIRES_APPROVED_DATABASE_USER |
| DB保護 | TLS必須・CAによる検証、外部3306公開なし。パスワード・認証secretは暗号化EBSからread-only mount |
| データEBS | vol-<VOLUME_ID> / UUID <DATA_EBS_UUID> / XFS / /srv/siteflow-mysql |
| 旧公開 | siteflow-3002 / REQUIRES_APPROVED_PUBLIC_IPV4:3002。Nginxの転送先はまだこちら |

秘密値・Docker inspect全文・接続パスワードは文書へ保存しない。選択した非秘密設定とコンテナIDはEC2の`/srv/siteflow-mysql/config/manual-public-v1/release.json`へroot所有0600、親0700で保存した。

## 公開準備で実施した変更（履歴・最大3項目）

1. 現候補と正式DBを固定し、既存MySQLサービスのdrop-inとNext.js起動unitを登録・enableした。現在のコンテナを停止・再作成せず、次回起動時も同一IDだけを起動する。EBS UUID・Volume ID・データ存在・秘密ファイル権限・設定一致を確認し、相違時は拒否する。
2. 5分間隔の状態記録timerを開始した。暗号化EBS上の`health.jsonl`へ時刻・稼働/health/OOM・readiness・メモリ/空き容量だけを記録。1MiBを超えると3世代へローテーションし最大約4MiB。Cookie・本文・秘密値・SQL結果は記録しない。
3. Nginx設定を同ディレクトリの`nginx.before.conf`へroot0600で退避し、正式DBを圧縮・age公開鍵暗号化して既存S3へ保存・再取得照合した。

## 起動設定の役割

| ファイル | 役割 |
| --- | --- |
| deploy/manual-public.py | 記録されたID・設定・EBSの照合、既存コンテナだけの起動、readiness確認、上限付き状態記録 |
| deploy/siteflow-next-public.service | MySQL healthy確認後に候補を起動。Requires/Afterで順序、RequiresMountsFor/BindsToでEBS依存を維持 |
| deploy/siteflow-mysql-manual-public.conf | 既存MySQL unitの条件・EBS保護・ExecStartPreを維持し、ExecStartだけを同一ID起動へ変更。Compose upによる意図しない再作成を避ける |
| deploy/siteflow-public-health.service / .timer | 読み取り監視を5分ごとに実行。自動再起動・公開切り替えは行わない |
| tests/manual-public.test.py | 設定差・EBS差・DB不調・不正モード・マウント順序の拒否条件など9件。Docker操作と通信は代用品 |

EC2ではスクリプトを`/usr/local/lib/siteflow/`、unitを`/etc/systemd/system/`へ配置した。MySQL drop-inは`siteflow-mysql.service.d/manual-public.conf`。Dockerのrestart=no、メモリ上限、swap禁止、core dump禁止、log-driver noneは維持した。

登録後の状態：MySQL active/enabled、Next起動unit inactive/enabled、状態記録timer active/enabled、旧CD timer inactive/disabled。**Nextのunitがinactiveでも既存候補コンテナは稼働中**。今回は次回起動の登録までで、新unit経由のアプリ開始・停止は試験していない。

## 最新バックアップ

- S3：`s3://siteflow-db-backups-<AWS_ACCOUNT_ID>-ap-southeast-2/protected/prepublic-20261121T022007Z-5599fec0/REQUIRES_APPROVED_DATABASE_NAME.sql.gz.age`
- VersionId：`<BACKUP_VERSION_ID>`
- サイズ：4,290 bytes
- SHA-256：`10668a95244548bf2092a0f79dbc255d38342ea4c0e25c52a811c87b289d8c47`
- 正式DBの16テーブルがInnoDBであることを確認。既存のSELECT/SHOW VIEW専用ユーザーとTLSを再利用。
- single-transactionで一貫した読み取り、gzip圧縮、age v1.3.2公開鍵暗号化、S3 SSE-S3(AES256)。S3から暗号文を再取得しVersionId・サイズ・SHA-256・S3 checksum一致を確認。
- 平文SQLをホストに保存せず、復号鍵・BitwardenパスフレーズをEC2へ渡していない。補助コンテナだけを一時作成・終了後削除し、既存3コンテナのID/開始時刻は不変。
- 今回の新バックアップを復号・別DBへ復元する試験はしていない。11月19日までに成功した16テーブル・27外部キー・復元側業務操作の試験を再利用する。バックアップ取得後に書き込まれたデータは含まれない。
- 暗号化EBS内の結果：`/srv/siteflow-mysql/config/manual-public-v1/result.json`。manifestは`/srv/siteflow-mysql/backups/prepublic-20261121T022007Z-5599fec0/manifest.json`。

## 確認・復旧の操作（将来用、再起動/停止は別承認）

以下はEC2上で実行するコマンド。`sudo`はroot権限、`python3`はPython実行環境、スクリプトパスは今回配置した固定ツール、最後の引数は操作モード。

```sh
sudo python3 /usr/local/lib/siteflow/manual-public.py check
sudo systemctl status siteflow-mysql.service siteflow-next-public.service siteflow-public-health.timer --no-pager
sudo tail -n 5 /srv/siteflow-mysql/config/manual-public-v1/health.jsonl
```

`check`はEBS・コンテナ設定・秘密ファイル権限・readinessを検査し、正常なら固定のOKを表示する。変更なし。`status`は各unitの状態表示、3つの引数は対象、`--no-pager`はページ送り禁止。`tail -n 5`は状態記録の最後5行だけを読む。ログの値には秘密を入れないが、環境情報なので公開チャットへ無差別に貼らない。

起動復旧が必要な場合は接続先を再確認し、本人承認後に以下の順で行う。

```sh
sudo python3 /usr/local/lib/siteflow/manual-public.py start-mysql
sudo python3 /usr/local/lib/siteflow/manual-public.py start-app
sudo python3 /usr/local/lib/siteflow/manual-public.py check
```

`start-mysql`は同じDBコンテナが停止中の場合だけ起動し、healthyを待つ。`start-app`は同じ候補コンテナだけを起動し、readinessを待つ。すでに正常稼働中なら再起動しない。イメージやコンテナが失われていたら拒否し、再作成・DB初期化・migrationはしない。異常時はコンテナを推測で削除せず停止して調査する。既存の再起動用スクリプトは停止を含むため、今回実行していない。

## 公開切り替え当日（別承認が必要）

1. 今回の固定ID・イメージ・正式DB・EBS・旧経路との一致、空き容量、MySQL healthy、候補readinessを確認する。新しい版への更新を混ぜない。旧CDは無効を維持。
2. 外部証明書とCertbot live証明書の指紋・期限・更新timerを確認する。短期IP証明書なので過去の期限を使い回さない。期限切れを検証無効化で通さない。更新が必要なら別途承認。
3. バックアップ以後の変更有無と経過時間を確認し、必要なら改めて取得する。新しい復元試験を形式的に繰り返さない。
4. 公開操作・正式DBへの架空テスト案件書き込み・異常時の旧経路復帰を一括で本人承認後、Nginxの`proxy_pass http://REQUIRES_APPROVED_PUBLIC_IPV4:3002;`の1か所だけを3001へ変更する。Host/HTTPS転送・証明書・ACME経路は維持。
5. `sudo nginx -t`で構文を検査してから`sudo systemctl reload nginx`。`-t`は設定の検査、`reload nginx`は接続を引き継いで設定を読み直す操作。ここで初めて公開先が変わる。今回未実行。
6. 公開HTTPS・readiness、ブラウザーのログイン→案件作成/保存→再取得→ログアウト、CookieのSecure/HttpOnly/SameSite、メモリ/OOM・状態記録・Nginxエラーを確認する。生のCookieやDBパスワードは記録しない。

## 切り戻し（当日の承認範囲に含める）

公開経路だけを旧Vinext3002へ戻す。正式DBを過去へ復元したり、Nextで受け付けた案件を削除したりしない。旧VinextではNext/MySQL版の案件を操作できない。

```sh
sudo cp -- /srv/siteflow-mysql/config/manual-public-v1/nginx.before.conf /etc/nginx/conf.d/siteflow.conf.rollback
sudo mv -- /etc/nginx/conf.d/siteflow.conf.rollback /etc/nginx/conf.d/siteflow.conf
sudo nginx -t
sudo systemctl reload nginx
```

`cp`は退避設定を一時名へコピー、`mv`は同じディレクトリ内で本来の設定へ置換、`--`は以降をオプション扱いしない区切り。成功後、旧画面とHTTPS200を確認する。検査失敗時はreloadせず報告する。経路復旧も失敗した場合は両コンテナとDBを保持し、追加操作を止める。退避後にNginx設定が変わっていたら古い設定を無条件で戻さず、当日のバックアップを使う。

## 実際の結果・残る限界

- 新規の起動・拒否条件テスト9件成功。LinuxのPythonでコードをメモリ内に読み、Docker/通信をモックした試験。WindowsにはPythonがなくローカル実行できなかった。実アプリ再起動の成功ではない。
- 型検査・lint成功、既存業務ルール42件成功。既存OIDC関連の186件は保持し、今回の再実行結果として扱わない。
- ローカルbuildは失敗。Turbopackが既存の保護領域`work/private-mysql-ca-84a0c73f07c0`を探索しOS権限拒否となった。権限変更・秘密領域へのアクセス・アプリ修正で回避していない。公開する既存イメージはビルド済みのまま不変。このローカル環境課題を、今回の実EC2起動設定検査成功や候補の稼働結果と混同しない。
- 2026-11-21 02:21:50 UTC時点：旧HTTPS200、候補ready、MySQL healthy。3コンテナのID/イメージ/開始時刻、Nginx設定が準備前と一致。
- 最終状態記録：使用可能メモリ約868MiB、root空き約8.19GiB、DB用EBS空き約9.62GiB。負荷試験の結果ではない。
- 途中の照合誤判定はDockerのマウント配列の順序差。順序だけ正規化し、保存先・read/write・重複の検査を維持。3件の再発防止を追加した。
- systemd-analyze初回失敗はfstab生成mount unitの検索先不足。生成先を検査コマンドの環境変数SYSTEMD_UNIT_PATHに明示して成功。fstab・EBS・安全依存は変更していない。既存acpid.socketのlegacyパス警告は無関係として保持。
- EC2の再起動、実コンテナの停止からの新unit復帰、EBS欠損での実起動、実ログの長期ローテーション、公開経路の切り替えと切り戻しは未試験。
- 監視は状態記録だけで通知・自動復旧はしない。Dockerのアプリ生ログを新たに有効化していないため、詳しい例外の追跡には限界がある。必要なら別途承認して整備する。
- ホスト側の非暗号化root EBS・swapの既存課題は残る。Next/MySQLと今回の準備・監視プロセスにはswap/core禁止を維持したが、OS全体の安全性が保証されたわけではない。
- 正式DBのテスト書き込み、EC2再起動、Nginx変更/reload、既存コンテナ停止/再作成、Git操作、Actions、新CD/AWS基盤構築は今回未実施。

## コマンドの補足

- SSH：`-T`はTTYなし、`-i`は既存鍵、`BatchMode=yes`は対話認証なし、`StrictHostKeyChecking=yes`は登録済みホスト鍵を厳守、`ConnectTimeout=10`は接続上限、`ServerAliveInterval=15`/`ServerAliveCountMax=2`は切断検知。コードだけを標準入力で送り、秘密値や秘密鍵本体は送信・表示しない。
- 準備の`systemd-run --quiet --wait --pipe --collect --unit=名前 -p MemoryMax=384M -p MemorySwapMax=0 -p LimitCORE=0 /usr/bin/python3 -`：一時的な実行枠を作り、終了を待ち、標準入出力を接続し、枠の終了後に解放する。`-p`はメモリ上限・swap禁止・core禁止。最後の`-`はコードを標準入力から読む指定。設定ファイルやS3保存が残る点は一時枠の解放とは別。
- `systemd-analyze verify`はunit検査、`systemctl daemon-reload`はsystemdの定義再読込でNginx reloadとは別。`enable`は次回起動の登録で`--now`を付けていない。`start`したのは読み取り監視timerだけ。
- dump：`--defaults-extra-file`は保護された既存接続設定、`--single-transaction`はInnoDBの一貫した読取、`--quick`は逐次読取、`--skip-lock-tables`は表ロックなし、`--no-tablespaces`/`--set-gtid-purged=OFF`は不要な管理情報を除外、`--column-statistics=0`は統計出力なし、`--skip-triggers`/`--skip-events`は既存検証と同じ対象制限、`--skip-add-drop-table`はDROP文なし、`--hex-blob`はバイナリ値の安全な表現、`--order-by-primary`は主キー順。末尾は正式DB名。事前に16個のInnoDBテーブルを確認し、DDLは実行していない。
- `gzip -n`はファイル名/時刻を付けず圧縮。`age --recipients-file`は公開鍵ファイルで暗号化。平文はパイプ内だけで、出力は暗号文。補助Dockerは`--pull=never`で取得禁止、`--rm`で補助枠のみ自動削除、`--network`は既存DB網、`--read-only`はrootを読取専用、`--memory`と同値`--memory-swap`でswap禁止、`--ulimit core=0`、`--log-driver none`、`--restart no`、`--cap-drop ALL`、`--security-opt no-new-privileges`で権限と露出を限定。`--mount`は指定ファイルだけ、`--entrypoint bash -c`は固定のバックアップ処理。既存コンテナには作用しない。
- S3：`put-object`は新規キーへ送信、`--if-none-match '*'`は同名の上書き禁止、`--body`は暗号文、`--server-side-encryption AES256`はSSE-S3、`--checksum-algorithm SHA256`/`--checksum-sha256`は整合性検査。`get-object --checksum-mode ENABLED`で戻し、VersionId・サイズ・hashを比較。`--bucket`/`--key`は固定保存先、`--expected-bucket-owner`は別所有者への誤送信防止、`--region`はシドニー、`--output json`は結果形式、`--no-cli-pager`はページ送りなし。既存IAMを再利用し、権限変更はない。

## 公開Originの明示設定（2026-11-27）

`deploy/manual-public.py`は、公開先をソースに固定しません。アプリ起動・ヘルス確認では`SITEFLOW_PUBLIC_ORIGIN`を必須入力として読み、HTTPSのOrigin形式（ホストのみ、パス・query・fragment・明示ポートなし）と、公開ホストとして不適切な値でないことを確認します。空・`REQUIRES_APPROVED_*`・不正値は、状態読込、Docker操作、HTTP通信の前に拒否します。既存値へのフォールバックはありません。

将来のLinux配置先は`/etc/siteflow/manual-public.env`です。含める変数は`SITEFLOW_PUBLIC_ORIGIN=https://REQUIRES_APPROVED_PUBLIC_HOST`の1項目だけです。この値は説明用の未設定例で、そのまま使用できません。親ディレクトリ`/etc/siteflow`は`root:root`所有・`0700`、ファイルは`root:root`所有・`0600`とし、Git・Docker build contextへ置かないでください。

`siteflow-next-public.service`と`siteflow-public-health.service`は、このファイルを任意読み込みします。ファイルがない場合もsystemdはプロセスを起動しますが、`start-app`・`monitor`・`check`はスクリプト内で失敗停止します。`stop-app`は公開Originなしでも、永続記録とコンテナ設定が一致する場合に限り停止できるようにし、停止経路を維持します。MySQL用の補助unitはOriginを必要としないため変更しません。

反映時は、承認済みの情報源から実設定を確認し、root所有・`0600`・値の形式を検証して環境ファイルを先に配置します。その後にスクリプトとunitを切り替えます。未設定のまま切り替えると自動起動・ヘルス確認は失敗するため、設定の先行配置が必須です。この手順は設計記録であり、今回EC2へ配置・反映したものではありません。