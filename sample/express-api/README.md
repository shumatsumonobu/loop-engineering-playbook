# sample: Express の API にエンドポイントを追加する

ループを回したいプロジェクト（＝導入先）の一式（→ [sample/README.md](../README.md)）、一般的なサービス開発のタスクを [ハーネス](../../harness/integrated.mjs)に改造なしで回した結果

題材は「メールアドレスの形式を検証して登録するエンドポイント」、**ループに渡したのは [task.md](task.md) の文章1つだけ**（動くベースと設定は人が用意）

## 中身

| ファイル | 誰が書いたか |
|---|---|
| [package.json](package.json) | 人（実走で検証した版に固定） |
| [.gitignore](.gitignore) | 人（`node_modules/`・`reports/`・`.stryker-tmp/`・`*.log` を除外） |
| [package-lock.json](package-lock.json) | npm（実走した時の依存の木そのまま・間接依存まで固定） |
| [stryker.config.json](stryker.config.json) | 人（[harness/stryker.config.json](../../harness/stryker.config.json) をそのままコピー） |
| [CLAUDE.md](CLAUDE.md) | 人（本体 README の[セットアップ](../../README.md#セットアップ)で推奨している規約2つ） |
| [task.md](task.md) | 人（`bd create` に渡したタスク文と その書き方の理由） |
| [src/app.js](src/app.js) | 人（土台の Express アプリ・`GET /health` のみ） |
| [tests/app.test.js](tests/app.test.js) | 人（ハーネスの前提である「最初に全テスト緑」を満たすためのテスト） |
| [src/register.js](src/register.js) | **AI**（ループが生成し 3つのゲートに合格したもの） |
| [tests/register.test.js](tests/register.test.js) | **AI**（同上） |

`src/register.js` と `tests/register.test.js` は AI の生成物をそのまま置いてある、人による修正は一切していない

`.beads/` や `AGENTS.md` を入れていない理由は [sample/README.md](../README.md)

## 実測（2026-08-04）

合格した回の値

| 項目 | 値 |
|---|---|
| コスト | $0.88 |
| 所要時間 | 6.9分 |
| `claude` の呼び出し | 4回（テストと実装で1回ずつ × 2周） |
| 書き直し | 1回（1周目に変異が1個生き残り、その箇所を伝えられて2周目で合格） |
| 変異チェック | 22個中 生き残り0 |

下の再現手順を上から踏んで別の場所で回し直しても合格（$0.51・2.4分・呼び出し2回・書き直しゼロ・変異22個中 生き残り0）

## 再現する

前提は本体 README の[セットアップ](../../README.md#セットアップ)と同じ（Node.js 20 以上・git・Claude Code・beads）

```bash
# 0. clone した loop-engineering-playbook のルートへ移動
cd /path/to/loop-engineering-playbook

# 1. この一式をハーネスの隣へ複製（プロジェクトはハーネスの外に置く）
cp -r sample/express-api ../my-api && cd ../my-api

# 2. 依存をインストール（package-lock.json のとおりに入れる＝実走と同じ木になる）
npm ci

# 3. ループが生成した2ファイルを消す（AI にもう一度書かせるため）
rm src/register.js tests/register.test.js

# 4. 緑を確認（土台のテストだけが残る）
npm test

# 5. git と beads を初期化
git init && git add -A && git commit -m "init"
bd init

# 6. タスクを登録（-d には task.md の「仕様」のコードブロックを丸ごと貼る）
bd create "メールアドレスを登録するエンドポイントを追加" -d "<task.md の仕様>"

# 7. ハーネスのルートへ戻って回す（claude を呼ぶ＝課金される）
cd /path/to/loop-engineering-playbook
BASE=../my-api node harness/integrated.mjs

# 8. 作業コピーを削除（実行中に生まれた未追跡ファイルがあるため --force が要る）
cd ../my-api && git worktree remove --force ../my-api-w1
```

不合格になった時の中身は `../my-api-log/run-<実行日時>/` に残る、消して良い

AI の出力は毎回同じにはならない、書き直しの回数もコストも上下する

生成物を消してから回すので、**出てきた実装が本当に生成されたものか 自分で確かめられる**（実測: 同じタスク文から 変数名も注釈もテストの書き方も違う実装が出た）

## 分かったこと

- 一般的なサービス開発でも ハーネスの改造は不要、`src/` と `tests/` にコードを置く規約に乗る限りそのまま動く
- 正規表現を含む仕様は変異チェックを通しにくい、アンカー（`^` `$`）を消す変異は 対応する入力がテストに無いと殺せないので タスク文で検証すべき入力を挙げる
- タスクの題名は500バイト（日本語なら約160文字）まで、仕様は `-d`（説明）へ書く
- `bd init` は `CLAUDE.md` に beads 用の記述を追記し、その変更を自分でコミットする、この sample の `CLAUDE.md` からは読みやすさのため外してある

**正直な限界**: 「生き残り0」が保証するのは、**タスク文で挙げた入力に対してテストが実装を検証していること**だけ、挙げなかった入力（大文字小文字・国際化ドメイン・長さの上限など）は変異も作られずテストも書かれないので 合格しても仕様の穴は残る（列挙を省いた版が通らなかった経緯は [task.md](task.md)）
