# このプロジェクトの進め方

ユーザーは就職活動のポートフォリオを育てながら学習する。各変更で目的、選んだ理由、検証結果、読むべきファイル、次の練習を日本語で説明する。判断はdocsに記録する。

- 一度に一つの学習段階を進める。業務ルールはlib/siteflow/domain.tsに置く。
- 非機能要件を追加するなら条件・測定方法・現状をdocs/NON_FUNCTIONAL_REQUIREMENTS.mdへ記録する。
- 完了済み、未実装、目標、測定結果を区別する。
- 初版はメモリのデモ。認証やDBがあると誤解させない。
- 秘密・実在の現場資料・個人情報をサンプルに入れない。
- 通常の型検査、業務ルールの検証、ビルドを行う。関係のない反復テストは不要。
- 依存の追加は、その学習段階で必要になった時に理由を説明する。

## GitHub（2026-09-30）
- GitHubのPrivateリポジトリは https://github.com/syucream02/siteflow 。
- GitHubには点検済みのコピーから新規mainをpush済み。元の.gitはSandbox由来のDeny ACLが残り、書き込み許可要求後も変更できなかったため、変更していない。保護を弱めたり、古い履歴をpushしたりしない。
- GitHub向けの作業コピーは C:/Users/syucream/Documents/Codex/2026-09-30/https-chatgpt-com-share-6abc349c-1ca8-3/work/siteflow-clean-check 。初回コミットは71881dbdf6ee826ada4518f31b538600f583b845。
- コピーには個別hosting.json、AGENTS.md、*.tsbuildinfo、生成物、依存物を含めていない。次の変更をpushする際は、新しいソースを改めて同期・点検するか、GitHubのクローンを主プロジェクトとして使うことをユーザーと整理する。
