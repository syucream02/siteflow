# 東京の日付とESLintの指摘を整理する（2026年11月14日）

## 今回の目的

`workspace.tsx` に残っていた `react-hooks/set-state-in-effect` の指摘を解消する。
期限超過の基準は引き続き東京の日付とし、サーバーとブラウザーの最初の表示が食い違わないようにする。
入力・登録・状態遷移の業務ルールは変更しない。新しいライブラリやESLintの例外は追加しない。

## なぜ指摘されたか

以前は `useState("")` で日付を持ち、画面の描画後に `useEffect` 内で `setToday(todayInTokyo())` を呼んでいた。
Effect実行直後の同期的な状態更新によって、改めて描画を始めるためESLintに指摘されていた。
今回の時計の同期はReact標準の `useSyncExternalStore` へ置き換えた。
ほかのEffectまで不要という意味ではない。既存のWebMCPツールの登録・解除にはEffectを維持している。

## 変更した箇所と構文

変更したアプリのファイルは `components/siteflow/workspace.tsx`。

```tsx
const today = useSyncExternalStore(subscribeToToday, todayInTokyo, getServerToday);
```

- `subscribeToToday`：時計を再確認するタイミングをReactへ知らせる関数。1分ごとのタイマーとウィンドウのfocusイベントを登録する。
- `todayInTokyo`：現在の東京日付を `YYYY-MM-DD` の文字列で読む既存の業務関数。業務ルールは `lib/siteflow/domain.ts` に維持する。
- `getServerToday`：サーバー描画とブラウザーの最初の描画では共通の空文字を返す。その後にブラウザーの時計を反映する。

サーバーのビルド時点の日付とブラウザーの日付を直接初期値として比較すると、日付が違う場合に表示が食い違う可能性がある。
共通の初期値を用意するのは、その食い違いを避けるため。ブラウザーの初期表示をサーバーのHTMLへ結び付ける処理をhydrationという。

`onChange: () => void` は「引数がなく、戻り値を使わない関数を受け取る」というTypeScriptの型。
`60_000` は60000ミリ秒、つまり1分。下線は数字を読みやすくする区切り。
購読関数が `return () => { ... }` で返す関数は、不要になったタイマーとイベントの登録を解除する後片付け。
同じ日付ならReactは値の比較により更新の必要性を判断する。1分ごとに必ず画面が再描画されるという意味ではない。

日付を開いたときに一度だけ保存する方式から、開いたままでも確認する方式へ変更した。
バックグラウンドではブラウザーによりタイマーが遅れるため、毎分の厳密な実行は保証しない。ウィンドウへ戻った際にも再確認する。
初期同期に伴う描画までなくなるわけではなく、描画回数や速度の改善は測定していない。

## 実際の検証結果

| 確認 | 結果 |
| --- | --- |
| ESLint | 成功。以前の1件を解消し、指摘0件 |
| TypeScript型検査 | 成功 |
| 業務ルールテスト | 8件成功。期限当日は超過せず、完了済みを超過にしないルールも維持 |
| Next.js本番ビルド | 成功。トップページの静的生成も成功 |
| HTTP | 修正後の開発サーバーで画面と `/api/health` の200を確認 |
| 修正後のブラウザー操作・日付またぎ・focus復帰 | 自動接続のホストが利用できず未確認。スマホ幅とキーボードも今回は未確認 |

実行したコマンド：

| コマンド | 目的・指定の意味・影響 |
| --- | --- |
| `npm.cmd run lint` | コード規約の検査。内部の `--ignore-pattern dist`・`--ignore-pattern .next` は生成先を除外。自動修正はしない |
| `node --experimental-strip-types --test tests/domain.test.mjs` | `--experimental-strip-types` で型を取り除いて読み込み、`--test` で業務ルールを実行。DBは変更しない |
| `npm.cmd run build` | Next.jsの本番用ファイルと型情報を生成。追跡済みの検査キャッシュは実行前の内容へ戻した |
| `npx.cmd tsc --noEmit --incremental false` | `--noEmit` はコード出力なし、`--incremental false` は検査キャッシュ更新なしで型を検査 |

## 次に読むファイルと練習

まずworkspace.tsxの `subscribeToToday` と `useSyncExternalStore`、次にdomain.tsの `todayInTokyo` と `isOverdue` を読む。
練習は、今日が期限の未完了の指摘には「期限超過」が付かず、昨日が期限なら付くことをシークレットウィンドウで確かめること。
この確認は、タイマーによる日付またぎまで確認済みにするものではない。

## その次の学習

次は [DATA_MODEL.md](DATA_MODEL.md) のユーザー・チーム・所属・案件の設計を具体化する。
Better Authの管理するユーザーと独自の業務データの関係、主担当の参照先、同じチームを保証する制約を決めてから、Prismaのスキーマとマイグレーションへ進む。
保存の検証はまずローカルで行い、業務APIへ公開する前に認証・所属・操作権限を組み込む。
今回このDB設計・保存・認証まで実装したわけではない。

参考：[Reactの外部データとの同期](https://react.dev/reference/react/useSyncExternalStore)、[Effect内の同期的な状態更新の規則](https://react.dev/reference/eslint-plugin-react-hooks/lints/set-state-in-effect)。
