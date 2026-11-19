# 開発用MySQL

## 今回の学習範囲

Dockerで開発用MySQLを起動し、SQLによる接続と、再起動時に同じ保存領域を使うことを確認する。
Prismaを使う確認用TypeScriptからの接続は、次の段階として [PRISMA_CONNECTION.md](PRISMA_CONNECTION.md) に記録した。
SiteFlowの画面・APIからDBへの接続、認証、業務テーブル、マイグレーションは未実装。
現在の指摘管理画面はメモリ上のデモのままで、再読み込みすると操作内容がリセットされる。

## ファイルの役割

| ファイル | 役割 |
| --- | --- |
| `compose.dev.yaml` | 開発用MySQLだけの起動設定。既存のDockerfile・本番配信とは独立 |
| `config/mysql.env.example` | 秘密情報を含まない設定見本。パスワードは空欄 |
| `.env.mysql.local` | このPCだけの設定とパスワード。Git管理・アプリのDockerビルドから除外 |

このPCの `.env.mysql.local` は、管理者用とアプリ用に異なるランダムなパスワードを生成して作成した。
別の開発環境では見本をコピーし、2つの空欄に異なるランダムなパスワードを設定する。
パスワードを表示するComposeの設定出力や、認証情報を含むファイルを共有しない。

## 起動設定と選んだ理由

| 項目 | 設定・理由 |
| --- | --- |
| イメージ | 公式の `mysql:8.4.13`。検証した版を明示し、意図せず別の系列へ変わることを避ける |
| Composeプロジェクト | `siteflow-dev`。他の開発環境と区別する |
| サービス | `mysql` |
| 接続先 | `127.0.0.1:3307`。このPCからの接続に限定し、一般的な3306番との競合を避ける |
| DB名 | `siteflow_dev` |
| アプリ用ユーザー | `siteflow_app`。対象DBの操作用。サーバー全体の管理者にはしない |
| 管理者 | `root`。接続元をコンテナ内のlocalhostに限定する |
| データ保存 | 名前付きボリューム `siteflow-dev_mysql-data` を `/var/lib/mysql` に割り当てる |
| 起動確認 | アプリ用ユーザーで `SELECT 1` が成功するとhealthyとする |

コンテナはMySQLを実行する環境、ボリュームはデータを置く保存領域。
コンテナを停止してもボリュームは残る。ただし、ボリュームはバックアップの代わりではない。
DBのバージョン変更や、データが入ったボリュームの取り扱いは別途計画する。

## 起動・状態確認・停止

Docker Desktopを起動した状態で、リポジトリのルートから実行する。
Dockerインストール後にコマンドが見つからない場合は、ターミナルを開き直す。

```powershell
docker compose --env-file .env.mysql.local -f compose.dev.yaml up --detach --wait --wait-timeout 180 mysql
```

- `--env-file`：ローカル設定の読み込み元。
- `-f`：使うComposeファイル。通常のアプリ用Dockerfileは使わない。
- `up`：必要なコンテナ・ネットワーク・ボリュームを用意して起動する。
- `--detach`：ターミナルを占有せず、バックグラウンドで動かす。
- `--wait`：healthcheckの成功を待つ。`--wait-timeout 180` は待ち時間の上限（秒）。

状態の確認と停止：

```powershell
docker compose --env-file .env.mysql.local -f compose.dev.yaml ps
docker compose --env-file .env.mysql.local -f compose.dev.yaml stop mysql
```

通常の停止・再開で保存ボリュームを削除する必要はない。
Docker Desktopのボリューム削除や `down --volumes` はデータも削除する操作なので、通常の停止には使わない。
環境変数のDB名・ユーザー・パスワードは、空の保存領域の初回初期化に使われる。
既存ボリュームがある場合、環境ファイルだけを書き換えてもDB内の設定は変更されない。
接続できなくなっても、解決のためにデータを削除して初期化し直さない。

## 接続して試す

```powershell
docker compose --env-file .env.mysql.local -f compose.dev.yaml exec mysql mysql --protocol=TCP --host=127.0.0.1 --user=siteflow_app --password siteflow_dev
```

パスワードを求められたら、ローカル設定の `MYSQL_PASSWORD` の値を入力する。
コマンドの引数にパスワードそのものを書かない。

```sql
SELECT 1;
SELECT DATABASE(), CURRENT_USER(), VERSION();
exit
```

`SELECT 1` は、接続したDBがSQLを実行して1を返せるか確認する処理。
この接続はコンテナ内のMySQLクライアントからの確認であり、SiteFlowからの接続確認ではない。
Prismaの接続確認例でもこのローカル設定を読み込む。詳細は [PRISMA_CONNECTION.md](PRISMA_CONNECTION.md) を参照。
マイグレーション用の権限や検証用DBも、その段階で設計する。

## 検証結果

2026年11月12日に確認した結果：

- Composeの `config --quiet`：成功。パスワードを設定出力に表示せず検査した。
- 公式MySQL 8.4.13を取得し、`siteflow-dev-mysql-1` がhealthyになることを確認した。
- アプリ用ユーザーによるSQL：`SELECT 1` は1、接続DBは `siteflow_dev`、利用者は `siteflow_app@%`、バージョンは8.4.13だった。
- 同じユーザーで管理用の `mysql.user` テーブルを読み取れないことを確認した。
- Windows側から `127.0.0.1:3307` へのTCP接続を確認した。Windows側からのMySQL認証・SQLはまだ確認していない。
- コンテナを再起動し、healthyに戻り、MySQLの `server_uuid` が変わらないことを確認した。
- `siteflow-dev_mysql-data` が `/var/lib/mysql` に割り当てられていることを確認した。業務データの保存・復元やバックアップはまだ検証していない。
- `.env.mysql.local` がGitの除外対象であり、既存の `.dockerignore` の `.env.*` でアプリのビルド対象からも除外される構成を確認した。

最初の取得ではDockerの認証補助コマンドがPATHに見つからず失敗した。
インストール直後の実行環境だったため、そのプロセス内だけDockerのbinをPATHへ追加して再実行し、成功した。
Windows全体のPATHやDockerのサインイン設定は変更していない。

アプリのコードや依存ライブラリは変更していないため、今回の確認対象はCompose設定と実際のDB接続。
型検査・業務テスト・アプリのビルドは今回再実行しない。

参考：[公式MySQLイメージの説明](https://github.com/docker-library/docs/blob/master/mysql/README.md)、[Composeの起動コマンド](https://docs.docker.com/reference/cli/docker/compose/up/)。
