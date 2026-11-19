# PC内のHTTPSでCookieを確認する（2026-11-15）

## 検証の目的と範囲

公開用中継と実際のChromeをPC内のHTTPSでつなぎ、Cookieの保存・自動送信・削除を確認する。専用の簡単な検証ページを使う。Next.jsの公開ルートや案件画面を有効にしたものではなく、公開サーバー/公開DBの接続試験でもない。

追加ファイルはexamples/mysql/check-https-cookies.mjs。package.jsonのtest:https-cookiesから起動する。既存の設定検査・中継・Cookie処理・共通API起動をそのまま使い、新しいライブラリは入れない。

## 実行と影響

以下の--prefix examples/mysqlは検証パッケージの指定。run test:https-cookiesはnode --import tsxでTypeScriptを読み込めるようにして検証を実行する。専用DB設定を読み、一時的な架空ユーザー・2チーム・21案件を保存する。終了時にそのデータとセッションを削除する。普段の準備用アカウントは使わない。

```sh
npm --prefix examples/mysql run test:https-cookies
```

- Windows上の既存ChromeとGit同梱OpenSSLを使う。スクリプト内で実行ファイルのパスを指定しており、他環境ではその指定を調整する必要がある。今回ソフトウェアの追加インストールはしない。
- API、HTTPS検証サーバー、HTTP確認サーバーは127.0.0.1の空きポートで待ち受ける。通常の5173/5175番サーバーを停止・変更しない。
- 作成した証明書・秘密鍵・専用ChromeプロファイルはOSの専用一時ディレクトリに置き、終了時に削除。削除対象は一時ディレクトリ直下の自分が作った接頭辞付きの場所だけに限定する。証明書ストアやhostsファイルは編集しない。
- Git除外のwork/https-cookie-previewへ、Cookie値や資格情報を含まない結果JSONと検証ページの画像だけを保存する。ログイン入力は成功後に消去し、画像は消去後に撮る。秘密鍵・証明書・ブラウザープロファイルは出力先へコピーしない。

## 証明書を作る引数

OpenSSLのreqは証明書の作成処理。-x509は自己署名証明書、-newkey rsa:2048は新しいRSA鍵、-nodesは一時秘密鍵を暗号化しない指定。-keyout/-outは鍵/証明書の保存先、-days 1は有効期間1日、-subjは検証用の名前、-addextはsiteflow.testとother.siteflow.testのSANを指定する。実行結果の鍵や認証情報は出力しない。

自己署名証明書を一般の信頼済み証明書として登録しない。専用Chromeだけで一時鍵のSPKIハッシュを例外指定する。**実TLSで通信するが、公的CAの信頼・期限・ホスト名の検証が成功したという結果ではない。** 公開証明書の検証は別に必要。

## Chromeの引数

- --headless=newは画面を開かず検証。--no-first-runは初回案内を省略。
- --disable-background-networkingは不要な背景通信を抑制。--no-proxy-serverはこの検証Chromeでプロキシを使わない指定。
- --remote-debugging-port=0は空きポートで検証用のCDP接続を受ける。CDPはChromeを操作する仕組み。
- --user-data-dirは今回専用の一時プロファイル。通常の履歴・Cookie・設定を使わない。
- --host-resolver-rulesは検証用の2つの名前を、このChrome内だけで127.0.0.1へ向ける。
- --ignore-certificate-errors-spki-listは今回生成した鍵の証明書だけを例外扱いする。証明書エラー全体を無条件に無視するフラグは使わない。

[ChromiumのSPKI例外の説明](https://chromium.googlesource.com/experimental/website/+/HEAD/site/quic/playing-with-quic.md)、[MDNのCookie条件](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)を参照した。ここでの例外はテスト用で、本番の設定例ではない。

## 確認結果

8シナリオ成功。TLSv1.3、ブラウザーの安全なコンテキスト、__Host-のルートPath条件、認証Cookieの属性/保存、再読み込み/自動送信、HTTPで送らないこと、別OriginでCookieが送られても403、ログアウト後のCookie/DB削除を確認した。

HttpOnlyはCookieの送信対象と同じ/api/siteflow配下のページで確認。JavaScriptから読める確認用Cookieも同じパスへ置き、確認用は読めるが認証Cookieは読めないことを確認後、確認用Cookieを削除した。ブラウザーへCookieを手動登録するCDP操作や、API要求へCookieヘッダーを手動で付ける処理は使っていない。

初回は検証サーバーのAPIパス切出しで文字数を指定しておらず、ログインが失敗した。検証側を修正して成功後、同じパスでのHttpOnly検証を追加して再実行した。アプリ本体の認証・中継・Cookie処理は変更していない。

検証ページの1440/390pxの横はみ出しと画像を確認。画像には入力値やCookie値を含めない。結果JSONは後始末が成功した場合だけ出力し、実行開始時に前の結果だけ削除する。Windowsの証明書ストア・hosts・通常Chrome・常用アカウントは変更せず、一時鍵/証明書/プロファイル/DBデータの削除を確認した。

本体/API型検査、業務/中継/設定79件、lint、ビルドも成功。API101件・従来画面47シナリオは前段階の結果で今回は再実行していない。Next.jsの公開ルートや案件画面を通す検証、公的CAの信頼、公開DB/TLS・最小権限・配信/負荷は未確認。詳細はVERIFICATION.md。

上記は簡易ページを使う8件の段階の結果。同じスクリプトの--next-workspaceモードでは、ビルド済みNext.jsを起動する別の9件を追加済み。現在の結果と接続設定はWORKSPACE_PREVIEW.mdとVERIFICATION.mdを参照する。
