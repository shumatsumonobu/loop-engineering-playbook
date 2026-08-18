# CHANGELOG

## 2026-08-10

初回公開

**AI にコードを書かせ続けるループを1本 作って実証し、手元のプロジェクトに導入できる形にまとめたもの**

ハーネスを clone して環境変数で対象を指すだけで回せる（[セットアップ](README.md#セットアップ)）

### ループ本体（[harness/integrated.mjs](harness/integrated.mjs)）

- 複数ワーカーの並列実行（git worktree で作業コピーを隔離・beads で担当の割り当てと排他）
- 3つのゲート ── 赤先行・凍結（`tests/` 全部）・変異チェック（Stryker・生き残り0）
- 補助 ── 自己チェック（変異ツールの誤判定を素のテストで検算）・人への差し戻し（`blocked-for-human`）
- 統合 ── ブランチごとに元のブランチへ合体して全テストを再実行、緑なら採用・赤なら巻き戻し
- 不合格の中身を残す（判定に使った出力・巻き戻す前の成果物を `<プロジェクト名>-log/run-<実行日時>/` へ）
- 拡張点2つ ── `WORK_ROOT`（成果物の置き場所）と `MUTATOR`（変異チェックの差し替え）で、**導入先のソースコードの言語を問わず**コード以外の成果物にも使える

### ワーカーが規約を破っても通らないようにする仕組み

迂回できることを実際に確かめてから塞いだ

- 勝手なコミットを取り消す／勝手に閉じたタスクを開け直す／作業領域の外の変更を元へ戻す
- 変異チェックを黙らせる印（`// Stryker disable`）を検出して不合格にする
- 変異チェックは実行前にレポートを消して exit code を見る（前の走のレポートで合格にしない）
- 再検証は [proof/stub-worker-attack.mjs](proof/stub-worker-attack.mjs)（ゲートの迂回）と [proof/stub-worker-parallel.mjs](proof/stub-worker-parallel.mjs)（並列でしか出ない壊れ方）で $0

### 実際に回した題材（[sample/](sample/)）

- `sample/express-api/` 一般的なサービス開発（Express の API にエンドポイントを追加・ハーネスの改造なし）
- `sample/article-loop/` コード以外の成果物（markdown の記事・自作の変異器）
- `sample/python-pytest/` JavaScript 以外の言語（Python + pytest・変異チェックを自作に差し替えるだけ）

### 検証の記録（[proof/](proof/)）

各段階で何を確かめたか・実測のコストと時間・実証で判明した落とし穴

### 導入の手順（[README.md](README.md)）

README だけを情報源にした別の `claude` に繰り返し踏ませて穴を潰した（各回の中身と実測は [proof/README.md](proof/README.md)）

### 保守の手順（[MAINTAINING.md](MAINTAINING.md)）

こうしたとき何を確認するかの一覧と、自動で回せる検査（[.claude/scripts/inspect.mjs](.claude/scripts/inspect.mjs)）── push のたびに GitHub Actions でも回る
