# SiteFlow — 現場・プロジェクト管理

土木設計・現場調査で見つけた指摘事項を、登録から対応・確認・完了まで追跡する、学習用のWebアプリです。

## 初版で試せること
- 架空のプロジェクト一覧と案件切替
- 指摘事項の登録（担当者・場所・期限・優先度・詳細）
- 状態別・期限超過の絞り込み
- 対応内容の記録、確認依頼、承認、差し戻し
- 件数・完了率・状態変更履歴
- PCとスマホのレイアウト

Reactのメモリを使うデモです。再読み込みでリセットされ、他の利用者と共有しません。写真・DB・認証・案件作成・報告書は未実装。

## 起動
Node.js 22.13以上（検証環境は24）とnpmを用意します。

```sh
npm ci
npm run dev
```

表示されたLocal URL（通常 http://localhost:5173）をブラウザで開きます。Windowsでnpm.ps1の実行が拒否される場合は npm.cmd を使ってください。設定を弱める必要はありません。

## 検証
```sh
npx tsc --noEmit
node --experimental-strip-types --test tests/domain.test.mjs
npm run build
```

依存パッケージはpackage-lock.jsonで固定。業務ルールのテストはNodeの標準機能で実行します。

## 構成
- app/page.tsx：画面の入口
- components/siteflow/workspace.tsx：対話する画面
- lib/siteflow/domain.ts：型・入力検証・状態遷移
- lib/siteflow/seed.ts：架空データ
- app/globals.css：デザイン・レスポンシブ対応
- tests/domain.test.mjs：業務ルールのテスト
- docs/LEARNING.md：設計理由、練習、拡張ロードマップ
- docs/NON_FUNCTIONAL_REQUIREMENTS.md：品質の要件と検証方法

React + TypeScript、App Router形式のSitesスターター（Vinext実行）を使います。Next.js本体を使った構成と同一ではありません。PostgreSQLや認証を追加する前に、ランタイム・ホスティングも検討します。

## 次の学習
まずdomain.tsの状態遷移を読み、画面で同じ流れを試す。次にDB/APIを追加して、保存とサーバー側入力検証を学びます。認証・企業別権限、写真、更新競合、CI・運用へ一段階ずつ進めます。

## 公開について
Sitesで本人向けの公開を準備しましたが、公開用処理への入力が自動承認レビューに拒否され、公開は未完了です。ローカル版を利用できます。就活向けの外部共有は、認証・デモ導線・公開する情報を整えてから別途設定します。.openai/hosting.jsonにはSitesの識別情報があり、秘密情報は保存しません。
