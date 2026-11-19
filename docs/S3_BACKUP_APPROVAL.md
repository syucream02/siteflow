> 最新状態（2026-11-19 04:52 JST）：S3保存・本人復号・別DBのTLS復元・16テーブル整合性・復元DBのログイン/案件作成/保存/再取得/ログアウトまで成功。今回追加DB/再取込なし。正式DB/既存サービス不変。日次自動化・別EC2復旧・公開切替の合格ではない。詳細はPREDEPLOY_VALIDATION.mdの最終結果。

> 最新追記（2026-11-19）：検証用HTTPを修正し、正Host200/不正Host503を確認。無効なperformance_schemaを使った接続確認で停止。取得可能なinformation_schema.PROCESSLISTへの確認SQL変更案を提示中。業務操作/総合復元検証は未完了。

> 最新追記（2026-11-18）：適合名siteflow_public_restore_s3_20261118へ1回TLS取込と全DB整合性検査が成功。アプリ確認のfetchがHostを送らないためreadinessで停止。同じイメージで原因再現済み。アプリ操作・総合復元判定は未完了。

> 最新追記（2026-11-18）：表記差比較の修正・9テスト・実定義/16テーブル/FK/CHECK TABLEの比較は成功。復元側アプリは既存のDB命名規則と復元DB名の不適合で停止。既存サービスは正常。再取込や命名チェック緩和は未実施。

> 最新追記（2026-11-18）：読取権限の限定修正は検証成功。別空DBへのTLS取込は成功したが、定義文字列のcharset明示/省略差で比較が停止。16テーブルのデータ・実定義と27外部キーは読取照合で一致。復元側アプリ操作は未実施。

> 最新追記（2026-11-18 20:12 JST）：本人復号/転送/gzip検査成功。別DB復元はSQL確認コンテナのユーザーとファイル権限不一致で停止。復元DB/ユーザー未作成。ローカル修正のみで再実行していない。

> 最新状態（2026-11-18）：S3/IAM作成・設定読み戻しはユーザーのCloudShell実行で成功。Codexによる正式DBのage暗号化・S3保存・取得照合も成功。本人復号と別DB復元は未実施。以下の「未作成」は承認前の過去記録。詳細はPREDEPLOY_VALIDATION.mdの2026-11-18記録。

# S3バックアップの承認対象（2026-11-17）

この文書と `deploy/backup/*.json` はレビュー用。**S3/IAMは未作成・未適用**。新しいAWSリソースは承認後に作成する。

## 対象と費用

- シドニーの専用bucket **siteflow-db-backups-173291123374-ap-southeast-2** を1個。名前の一意性は作成時に確認し、取得済みなら別名で無断作成しない。
- 既存EC2ロール **SiteFlow-EC2-SSM-Role** に対象bucket限定のinline policy **SiteFlowS3Backup** を追加する。新IAMユーザー/アクセスキー/別EC2/RDS/NAT/KMS keyは作らない。
- 11月17日20:36 JST取得のAWS公式料金（publicationDate 2026-11-16T21:17:45Z）：S3 Standard 0.025 USD/GB月、PUT/LIST等1000回0.0055 USD、GET等1000回0.00044 USD。保存40個相当×100〜256MiBの例なら月約0.11〜0.26 USD＋通信/増加/税。現在の正式DB SQLは約28KBで、将来サイズの保証ではない。
- S3停止料金という区分はなく、EC2休止中も保存量と要求に応じて課金。保護版の増加は月次確認する。SSE-S3自体の暗号化追加料金はない。

## 設定と権限

`deploy/backup/bucket-settings.json`：Block Public Access全ON、ACL無効/BucketOwnerEnforced、SSE-S3 AES256、Versioning有効。`bucket-policy.json`：HTTP拒否、PUT時AES256明示を必須、backup roleによるprotected/config削除と全旧version削除を拒否。

`role-policy.json`：daily/protected/configへのList/Put/Getだけ、日次整理のDeleteObjectはdailyだけ。bucket管理/他bucket/旧version物理削除は許可しない。`restore-policy.json`は復元時の運用者セッション用の最小権限例で、EC2日常ロールへ追加しない。

EC2から既存ロールの付与policy/inline policy一覧を読もうとしたが両方AccessDenied。**最小権限の総合確認は未完了**。承認後の適用前に、本人のAWSコンソールでIAM→ロール→SiteFlow-EC2-SSM-Roleの既存許可を確認する。既存の別機能のpolicyを削除・置換しない。広いS3許可があれば、それも含めて評価してから進める。権限不足を理由にAdministratorAccessを追加しない。

保存期間は従来案を維持：dailyは新しい成功後だけ最新7セットへ整理し、削除はversioningの削除マーカーになる。dailyの非現行版は30日、期限切れ削除マーカーの掃除は `lifecycle.json` に限定。protected/configは自動期限削除なし。2027年1〜4月の再公開・復旧確認が済むまで保持し、後日対象を列挙して整理承認を得る。

## 保存と復元の合格条件

1. 固定版age等の認証付き暗号化をローカルで検証。EC2は公開recipientだけを持ち、復号用秘密鍵は本人の保護領域へ二重保管する。鍵紛失時は復元できないため、保管と復号確認を先に行う。
2. MySQLの専用backupユーザーで正式DBを一貫性のあるdumpへ出し、gzip→暗号化。平文の作業領域は暗号化EBSだけ、秘密を扱う処理はswap/core/logを抑止する。既存DBと検証用アカウントは維持する。
3. 暗号文とmanifestを一意の日時/run-idキーへsingle PUT（上限256MiB）。AES256・SHA256・サイズ・VersionIdを記録し、取得して一致した場合だけ成功とする。上限超過は無断multipart化せず中止する。
4. 運用者が記録したVersionIdを固定して取得し、認証付き復号→gzip検査→新しい空の別DBへTLS復元。元DBへ上書きしない。全16table・外部キー・ユーザー/案件/会議の整合性を比較し、復元側アカウント/案件操作とsession失効を確認する。
5. 拒否条件は別prefix/権限/不正暗号文/不正versionで安全に検証。旧versionやprotectedの実データは削除試験に使わない。S3は現時点で未作成なので、上のS3往復・正式DB復元を成功済みにしない。

## 実行を承認する単位・元に戻す方法

承認単位は **上記bucket1個・既存ロールへの限定policy・非公開/暗号化/Versioning/lifecycle設定・暗号化した架空データの送信取得・別空DB復元試験**。公開経路、既存サイト、Git push、EC2再起動は含めない。

失敗した場合はbackup処理を止め、今回のpolicy付与を外せばアクセス追加を取り消せる。元DB/既存公開は変更しない。bucketとbackupを保持すると料金は残る。versionやbucketの削除は復旧データを失う操作なので、別途確認してから行う。設定変更だけでSQLデータは自動でS3へ退避されない。

JSONはAWS APIの入力例。bucket-settings.jsonは複数APIの設定をまとめたレビュー用で、1回のAPIへそのまま渡すファイルではない。実行前に各APIの対象と結果を照合する。

根拠：[AWS公式Sydney料金JSON](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-southeast-2/index.json)、[SSE-S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingServerSideEncryption.html)、[S3公開防止](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)。
