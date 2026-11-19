# 公開APIの設定検査（2026-11-15）

## どこまでできたか

examples/mysql/public-api-settings.tsのreadPublicApiSettingsが環境変数を検査する。public-api.tsのstartPublicApiServerは、検査後にDBクライアントを作り、api-server.tsの共通起動へ渡す。**公開用入口は関数として実装済みだが、公開環境で起動していない**。CLI・自動起動・配信設定は追加していない。ローカルAPIは従来の専用DB設定を使う。

設定検査ファイルはサーバー用。ブラウザーからimportしない。検査関数自体はDB接続・listenをしない。public-api.tsは検査に通った場合のみDB作成と共通起動へ進む。不正な設定でDB作成/起動の依存が呼ばれないことを確認した。起動後の画面・中継の公開対応は別途必要。

## 項目の意味

いずれもSITEFLOW_で始まる専用変数。NEXT_PUBLIC_を付けない。既存MYSQL_やBETTER_AUTH_SECRETへの暗黙のフォールバックはない。実際の値・環境ファイルは今回作成していない。

| 変数名 | 役割と条件 |
| --- | --- |
| SITEFLOW_PUBLIC_ORIGIN | ブラウザーから利用する公開元URL。HTTPS、DNSホスト名、ルートのみ。ユーザー名/パスワード・検索条件・フラグメント・localhost/ローカル向けホスト・IP指定は拒否。ホスト大文字とルート末尾の/は正規化する |
| SITEFLOW_AUTH_SECRET | 認証の署名等に使う固定秘密値の元。32バイトを16進数にした64文字、同一文字の繰返しは拒否。実際は暗号学的乱数から生成する。形式検査だけで乱数の品質や安全な保管は保証しない |
| SITEFLOW_DB_HOST | DBサーバーのホスト名またはIP。接続URL・パス・資格情報・ポートを混ぜない。内部ネットワークやloopbackも許可。DBをインターネットへ公開する指定ではない |
| SITEFLOW_DB_PORT | DBのポート。1〜65535の10進整数のみ。指数・小数・先頭0・空白などは拒否。暗黙の既定値はない |
| SITEFLOW_DB_NAME | 公開専用DB名。siteflow_public_に英小文字/数字/下線を続け、全体64文字以下。このプロジェクトの取り違え防止方針であり、DB存在や権限の確認ではない |
| SITEFLOW_DB_USER | 実行用DBユーザー。英数字/下線1〜32文字、rootは拒否。名前だけで最小権限を保証できないので、実際の権限は接続時に別途確認する |
| SITEFLOW_DB_PASSWORD | DBパスワード。16文字以上、空白だけやNULを拒否。値の前後の空白を勝手に除去しない。実際の強度・接続成否は未検証 |
| SITEFLOW_DB_TLS | requiredのみ。public-api.tsでssl: { rejectUnauthorized: true }を指定する。設定受け渡しは検証済みだが実際の公開DBとのTLS接続は未検証。個別CA証明書の追加設定も未実装 |

成功結果にはauthSecretとdatabase.passwordが含まれる。結果全体や環境変数をログへ出さない。エラーは固定の項目名だけを持ち、元のURL/パスワード/例外のcauseを含めない。実行者が対話で設定値を入力するUIや、公開設定の閲覧APIは追加していない。

## なぜこの形か

引数を省略するとprocess.envを読み、テストでは架空の文字列だけを渡す。実際のサーバー環境やDBを触らず、不足・境界値・秘密値の混入を確認できる。PublicApiSettings型で、文字列のポートを数値へ変換した結果などを明示する。

examples/mysql/tsconfig.jsonのfilesへ新しいモジュールを追加した。まだ起動処理から参照されないファイルでも、API側の型検査対象にするため。新規依存や通常の起動コマンドは増やしていない。

## 再現する確認

次のnodeコマンドの--experimental-strip-typesはTypeScriptの型を読み飛ばし、--testは指定テストを実行する。架空値だけで、DB・ネット・環境ファイルの変更はない。

```sh
node --experimental-strip-types --test tests/public-api-settings.test.mjs
```

9件成功。必須項目、URL、secret、DBのホスト/ポート/名前/ユーザー、パスワード/TLS、値を変えないこと、エラーの文字列/JSON/スタックに秘密値を含めないことを確認。69件の合算と型検査/ビルド結果はVERIFICATION.md。

## 設定から起動までの流れ

1. startPublicApiServerがreadPublicApiSettingsで全項目を検査。不正ならDB作成やlistenより先に例外で止まる。
2. 公開用DBへhost/port/name/user/passwordとsslの証明書検証を指定する。通常DBや検証DBへの切替はない。
3. startApiServerへDBクライアント・固定secret・公開Origin・Secure Cookie指定を渡す。
4. 共通起動がDB接続→loopbackのlisten→Better Auth→HTTP受付を準備する。公開用はHTTPS Originを認証と受付に使う。内部listenは127.0.0.1:5175のままで、外部公開はしていない。
5. 接続/起動失敗時はDBを切断し、値や元のcauseを含めないエラーにする。closeは同じPromiseを返して重複停止を避け、サーバー停止後にDBを切断する。

auth-check.tsも共通起動へ接続した。startAuthCheckServerは従来の呼出方法を保ち、省略時は起動ごとにsecretを生成する。テスト専用の任意引数で同じsecretを渡し、ローカル実DBで再起動後のセッション維持・secret変更時の旧Cookie拒否を確認した。ローカルHTTP検証なのでSecure Cookieはfalse、公開用入口はtrue固定。公開設定からTLSを無効にする経路はない。

100件のAPI関連テストは、既存96件と新規4件。新規のうち設定不備/設定受渡し/失敗処理には代替依存を使用する。公開用のTLS指定を受け取ったことを確認したもので、暗号化通信の実測ではない。再起動の1件は専用DBとHTTPを使い、一時セッションを終了時に削除した。

型は導入済みPrismaMariaDb 7.10.1のPoolConfigとBetter Auth 1.7.23で確認。TLS方針は[MariaDB公式の接続オプション](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/node-js-connection-options)、Secure Cookieは[Better Auth公式のCookie説明](https://better-auth.com/docs/concepts/cookies)を参照した。新しい依存は追加していない。

公開用中継の部品とCookieの検査は追加済み。PUBLIC_API_PROXY.mdを参照。api-server.tsから受付へ公開Originと内部Hostを別々に渡し、内部Hostは実際のlisten先と照合する。次は実HTTPSブラウザー/公開DB接続と明示設定でのルート接続を確認する。実配信先・CA・最小権限・ネットワーク境界は未確認。公開画面は案内、中継ルートは開発限定で、ガード解除やNODE_ENV偽装はしていない。
