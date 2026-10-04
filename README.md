# SiteFlow — 現場・プロジェクト管理

土木設計・現場調査で見つけた指摘事項を、登録から対応・確認・完了まで追跡する、Webアプリです。

## 起動方法

Node.js 22.13以上（検証環境は24）とnpmを用意します。

```sh
npm ci
npm run dev
```

表示されたLocal URL（通常 http://localhost:5173）をブラウザで開きます。Windowsでnpm.ps1の実行が拒否される場合は npm.cmd を使ってください。設定を弱める必要はありません。

## テスト方法

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
- docs/NON_FUNCTIONAL_REQUIREMENTS.md：品質の要件と検証方法
