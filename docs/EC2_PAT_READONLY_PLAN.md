# EC2用PATの安全な受け渡しとGET専用試験の準備

> 2026-11-24 中断整理：本書は過去のPAT案の監査記録であり、転送・保存・利用の許可ではない。現在の候補はGitHub App＋EC2 polling。AWS/OIDC方式は保留で、再開条件は[承認付きCDの導入準備](APPROVED_CD_SETUP.md)を優先する。環境識別子は公開用のプレースホルダーへ置換し、過去の確認結果は保持した。再開時もApp認証・実API・秘密情報の保管は個別承認とし、本番CDはNO-GO。

> 2026-11-20 方針変更：新CDはPATをEC2へ転送・保存・使用しない。[OIDC＋SSM＋署名付き指示のローカル実装記録](AWS_CD_STAGE1.md)を優先する。本書は過去の監査・計画として保持し、記載手順を実行する許可にはしない。既に本人管理のPATを失効する操作も今回は行っていない。

確認日：2026-11-20 JST。**ローカル準備のみ。EC2への接続・転送・配置・起動・設定変更は未実施。**

## 現在地と承認範囲

- 本人報告：Windowsの専用PAT試験8件がHTTP 200。release=false、production保護、main/CI、承認待ち、artifact 0件を確認。秘密値は受領していない。AIによる実トークンの再試験ではない。
- 作成条件は対象siteflowのみ、Contents/Actions/Environments read、初回約7日。**実際の期限日時は未確認**。GitHub画面・Bitwardenのメモで本人が確認する。期限情報だけを記録し、PAT自体を記録しない。
- 今回は過去の接続記録・公式仕様の調査とローカル補助コードの準備だけ。トークン転送、EC2ファイル作成、CD配置/起動、Actions承認、DB変更、公開は別承認。

## 接続方法の比較

| 方法 | 通信と利点 | 記録・露出リスクと前提 | 今回の方針 |
| --- | --- | --- | --- |
| 既存SSH | Windows→既存EC2へSSH暗号化。既存鍵・登録済みhost鍵・過去の匿名パイプ転送実績を再利用 | SSH認証ログ、sudo/監査/セッション記録は別。現在のSG、sshd、known_hosts、sudo I/O設定は未再確認 | **第一候補**。既存設定を変更せず使える場合に限る |
| SSH over SSM | AWS認証されたTLSトンネルの中をSSH暗号化。新規受信ポート不要 | SSM Agent/plugin/IAM/SSH鍵/sshdが必要。SSM本文ログは利用不可でもCloudTrail等の操作メタデータとOS側記録は残る。既存利用可否は未確認 | 既存SSHが利用できない場合の候補。設定追加は別承認 |
| 通常のSSM対話シェル | SSH鍵不要で管理接続 | 設定によりセッション内容・コマンド・出力をS3/CloudWatch/ローカルへ記録。非表示入力だけで全記録方式の安全性を断定しない | 読取調査に利用可能。PAT入力経路には未採用 |
| SSM Run Command | 非対話の管理操作 | コマンド本文・パラメータ・実行結果が履歴やログに残り得る | **PATを本文・引数・パラメータに埋め込まない** |

既存資料：AWS_DEPLOY_RUNBOOK.mdの本人復号/SSH転送手順。既存鍵によるSSH、BatchMode=yes、StrictHostKeyChecking=yes、既存host鍵照合の実績あり。今回、鍵本体・PAT・Bitwarden・個人のSSH設定は読んでいない。

## 転送前の読み取り確認（まだ実行しない）

1. EC2 ID EC2_INSTANCE_ID、接続先、host鍵の指紋、既存ユーザーと鍵経路を照合。鍵の中身は表示しない。新しいhost鍵を無条件登録したり、host鍵確認を無効化しない。
2. sshdの実効設定、ForceCommand/Match/セッション録画、sudoのlog_input/log_output/log_stdin/use_ptyとI/O plugin、audit/tlog等を確認。ポリシー変更やログ無効化はしない。秘密を入力する前に不明点を解消する。
3. SSMを使う場合は対象リージョンのSession Manager設定/文書、S3/CloudWatch/ローカル記録、CloudTrail操作履歴の範囲を確認。接続認証とトークン入力経路を区別する。
4. EBS UUID EBS_UUID、EBS_VOLUME_ID、XFS、/srv/siteflow-mysqlを照合。暗号化属性はAWSの既存構成記録と照合し、LinuxのUUIDだけで暗号化を証明したとは扱わない。
5. CD旧/new timerはdisabled/inactive、新serviceは未導入またはinactive。release状態ディレクトリがある場合pausedあり・enabledなしを確認。読み取りのために状態を変更しない。
6. プロキシ環境・証明書検証・EC2からapi.github.comへの経路、利用ツールを確認。TLS検証を無効化しない。

**記録経路を確認できない場合、転送はNO-GO。監査記録を消したり保護を弱めて進めない。**

## 承認後に採用する転送・保管手順

接続とログの事前確認に合格した後、具体的な受信コードをレビューし、配置と転送をまとめた承認を得る。

1. root専用受信処理とGETチェッカーだけを配置。CDファイル・Nginx・DBには触れない。受信処理は既存tokenを上書きしない。
2. WindowsでRead-Host -AsSecureStringに本人が入力。Bitwarden以外の平文ファイルを作らない。トークンをPowerShellコマンド、環境変数、Start-Process引数、SSM本文へ展開しない。
3. SSHはTTYなし（-T）、agent forwardingなし、BatchMode=yes、StrictHostKeyChecking=yes、接続上限付き。固定された受信コマンドにだけ接続し、PATをProcess.StandardInputへ渡す。PowerShellの通常パイプ/画面への出力は使わない。
4. 受信処理はmount/UUID/Volume ID・親ディレクトリ・権限を確認してから入力を読む。root専用cgroupでswapなし/coreなしを確認。管理されたPATHと不要な環境変数を除いた環境で実行。
5. 保存先は **/srv/siteflow-mysql/secrets/github-read-token**。親はroot/0700、ファイルはroot/0600、通常ファイル、symlink禁止、hardlink数1。既存secretsディレクトリが条件と違う場合は勝手にchmodせず停止し、既存サービスへの影響を確認。
6. 受信は最大512 bytes、PAT形式を検査し、暗号化EBS上だけにO_EXCL/O_NOFOLLOW相当で新規作成。必要な一時ファイルも同EBSのroot専用ディレクトリ内だけ。成功時fsync・上書きしない確定方法を使う。パス以外の値やPATハッシュは出力しない。
7. 出力は受信成功・権限・保存先等の非秘密情報のみ。途中失敗は部分ファイルの有無だけ報告し、無断削除/再転送/上書きはしない。
8. Windows側のクリップボード・履歴を本人が整理し、入力用PowerShellを閉じる。Bitwardenの元の保管は維持する。

SSHの暗号化は通信中の保護。EC2のrootは保存後のPATを読める。EBS暗号化は主に保存媒体の保護であり、root侵害・メモリ取得・OS側のI/O記録を防ぐものではない。標準入力転送の受信コードとWindows送信コードは**まだ未実装・未承認**。

## 独立したEC2 GETチェッカー（ローカル準備済み）

ファイル：`work/ec2-pat-get-only.sh`。Git/Docker対象外のworkに置く検証用コード。実トークン・EC2を使って実行していない。

- root・暗号化用EBSの対象照合・親の所有権・token root/0600・swap/core抑止・CD停止状態を、PAT読み取り前に確認。
- releaseディレクトリ未作成＝未導入を許容。存在する場合はpausedあり・enabledなしを要求する。timerを起動/有効化したり、マーカーを作らない。
- tokenは非export変数からcurlのstdin設定へ渡す。引数・Env・設定ファイルへ値を渡さない。curlの既定設定を無視（--disableを先頭）、HTTPS GET固定、リダイレクト非追従、TLS通常検証。
- APIの固定8ルートのみ。応答はメモリ内でjq判定。出力はPASS番号と固定STOP/SUCCESSのみ。curlの生エラー・ヘッダー・JSON本文・秘密値を表示しない。
- DB、Docker、CD、公開経路は操作しない。API artifact一覧は読むがdownloadはしない。PATが過剰な書込権限を持っていないことは、このGET成功だけでは証明できない。
- 実行にはbash/curl/jq等が必要。後日、承認した一時systemd unitでMemoryMax、MemorySwapMax=0、LimitCORE=0、実行時間上限を指定し、環境を限定して実行する。一時unit作成も今回は行わない。
- main SHA e0cc78f258bbe4f6b2446eec1025e0e3820e6093/run 44531879015/production waiting/artifact 0を固定期待値にする。状態が変わっていたら、保護を緩めず再レビュー。

検証範囲：Git Bashのbash -n（構文解析のみ）とネットワーク呼出し・副作用の静的点検を行う。**EC2実行・Linux実権限/ログ・jqの実応答判定・期限切れ実トークン試験は未検証**。Windows8件成功は本人報告として別記する。

## 有効期限と安全な停止

実際の期限日時はGitHub画面/Bitwardenの非秘密メモで確認する。PAT文字列から期限を推測しない。今回、期限確認のためのトークンAPI呼出しは行わない。

期限切れ/失効すると認証不可。checkerは非200/通信失敗で停止し、匿名アクセスや過去の成功値へ戻らない。CDのcheck-release-permission.shも厳密なtrueとHTTP200以外を拒否し、更新時刻/承認期限を配信前の複数地点で再照会する。既に開始した処理の瞬時停止・完全な原子性は保証しない。

PATの期限切れはアプリ/DBの起動資格情報とは別なので、公開中アプリを止めず、新規配信だけを停止する。更新時はpausedのまま新PATを別承認で検証して置換し、旧PATを失効。既存PATの上書きや自動権限拡大はしない。

## 次の承認単位

1. **EC2/SSM/SSH/ログ設定の読み取り調査のみ**。秘密入力なし、設定変更なし。
2. 調査に合格した方式で、**受信/GET専用補助ファイルの配置＋PAT新規保管＋独立GET試験**を具体化し、別途承認。CDは未導入/停止状態のまま。
3. GET合格後にCD停止配置の承認へ進む。production承認・CD起動・DB変更・公開切替はこの承認と分離。

## 公式根拠（2026-11-20参照）

- [SSMセッション記録とSSH/port forwardingの制限](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-logging.html)
- [SSH over SSMの条件と通信経路](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html)
- [GitHub tokenの期限と失効](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)
