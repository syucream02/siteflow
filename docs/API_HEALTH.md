# 小さなAPIの接続確認（2026年11月12日）

> 以下はVinextで追加した時点の記録です。2026年11月13日にNext.jsへ移行し、同じAPIのGET 200・POST 405を開発、本番起動、Dockerで確認しました。現在の起動方法と制限は [NEXTJS_MIGRATION.md](NEXTJS_MIGRATION.md) を参照してください。

## 目的と実装

VinextのApp Router形式で、ブラウザーからサーバーの処理を呼び出せることを確認する。
`app/api/health/route.ts` を追加し、GET `/api/health` に次のJSONを返す。

```json
{"message":"SiteFlowのAPIは動いています"}
```

`export function GET()` はGETリクエストを受ける処理を公開し、
`Response.json(...)` はデータをJSON形式のHTTPレスポンスにする。
HTTPステータス200は、このリクエストが成功したことを表す。

まずルーティングとHTTP応答だけを学べるよう、DBや認証に依存しない構成を選んだ。
追加入力を受け付けず、案件・利用者・接続情報を返さないため、認証なしの固定応答とする。
業務APIで必要となる認証・チーム所属・操作権限の検証を省略してよいという意味ではない。
この応答はAPIの疎通確認であり、DB・メール・認証の稼働や本番環境の健全性は保証しない。

既存の画面、業務ルール、依存ライブラリ、AWS・CI/CD設定は変更していない。

## 確認結果

- `npm.cmd run dev` で開発サーバーを起動し、`http://127.0.0.1:5173/api/health` にHTTPでアクセスした。
- GET：200、Content-Typeは `application/json`、上記のメッセージと一致することを確認した。
- 未定義のPOST：405（許可されていないメソッド）になることを確認した。
- `npx.cmd tsc --noEmit --incremental false`：成功。`--noEmit` はコードを出力せず型検査、`--incremental false` は検査キャッシュの生成を無効にする。
- `node --experimental-strip-types --test tests/domain.test.mjs`：既存の業務ルールテスト8件が成功。
- `npm.cmd run build`：成功。`/api/health` がAPIルートとして認識された。既存の `/` の自動分類は `Unknown` と表示された。
- ブラウザーの表示操作、本番サーバーでのHTTP応答、DB・認証接続は未検証。

今回は固定応答の疎通確認なので、応答をそのまま再現する単体テストは追加せず、実際のHTTP通信で確認した。

## 自分で試す

開発サーバーが起動している間に、ブラウザーで上記のURLを開く。
表示される `message` と `route.ts` の返す値を見比べる。
ここまでで「URLへのリクエスト → サーバーのGET処理 → JSONのレスポンス」を確認できる。

次の学習では、今回の固定応答と、DBから読み取った値を返す業務APIの違いを整理する。
MySQL・Prisma・Better Authの接続検証は、この疎通確認とは別の段階として進める。
