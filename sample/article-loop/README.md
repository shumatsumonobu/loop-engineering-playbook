# sample: 記事を書くループ（コード以外の成果物）

ループを回したいプロジェクト（＝導入先）の一式（→ [sample/README.md](../README.md)）、成果物がコードではなく **markdown の記事**のタスクを [ハーネス](../../harness/integrated.mjs)で回した結果

題材は「git worktree の使い方を説明する技術記事」、**ループに渡したのは [task.md](task.md) の文章1つだけ**（土台の記事と設定は人が用意）

## 何を確かめたかったか

本体 README の[どんな用途に使えるか](../../README.md#ユーザガイド)はこう主張している

1. 仕組み（タスク分配・並列実行・人への差し戻し）は**コード以外の成果物にも使える**
2. ただし**ゲートが保証する範囲は「テストが何を検証できるか」で決まる**、記事なら形式まで

この sample は**両方とも実物で確かめたもの**、片方だけを見せて良く言うことはしていない

## 結果

**1. 仕組みも3つのゲートも、そのまま移植できた**

コード以外へ移すために足したのは切り替え2つだけ（成果物の置き場所・変異チェックの実行方法）、合否の判定そのものは触っていない

| 項目 | 値 |
|---|---|
| コスト | $1.43 |
| 所要時間 | 6.8分 |
| `claude` の呼び出し | 4回（テストと記事で1回ずつ × 2周） |
| 書き直し | 1回（1周目に変異が6個生き残り、フィードバックを受けて2周目で合格） |
| 変異チェック | 15個中 生き残り0 |

**2. でもゲートが保証したのは形式だけ、内容の正しさは誰も見ていない**

合格した [articles/worktree.md](articles/worktree.md) の事実を書き換えても、**この記事を検証するテスト10本が全部 緑のまま通る**

```markdown
作業コピーは元のリポジトリの中にしか作れない          ← 嘘
remove を実行すると、そのブランチも一緒に削除される    ← 嘘
同じブランチを複数の作業コピーで同時に開いても問題ない  ← 嘘

git worktree add --recursive --shallow               ← 存在しないオプション
```

テストが見ているのは「その見出しがあるか」「そのコマンドがコードブロックの中にあるか」だけなので、書いてある内容が正しいかは1つも検証していない

**3. 生き残り0 を要求すると、成果物は検証された要素だけに痩せる**

合格した記事には `## 注意点` という見出しがあるが、**その下に注意点は1文も書かれていない**

変異チェックは「テストが検証していない部分」を全部 生き残りとして報告するので、通そうとすると「検証された要素以外を書かない」形に収束する

コードでは望ましい規律（[proof/README.md](../../proof/README.md) の「冗長な実装が等価変異を生む」と同じ話）だが、**読み物としては骨だけになる**

## 中身

| ファイル | 誰が書いたか |
|---|---|
| [package.json](package.json) | 人（Vitest だけ・Stryker は使わない） |
| [package-lock.json](package-lock.json) | npm（実走した時の依存の木そのまま・間接依存まで固定） |
| [.gitignore](.gitignore) | 人（`node_modules/`・`*.log` を除外、この sample は Stryker を使わないので `reports/`・`.stryker-tmp/` は要らない） |
| [mutate-md.mjs](mutate-md.mjs) | 人（markdown 用の変異器・下で説明） |
| [task.md](task.md) | 人（`bd create` に渡したタスク文と その書き方の理由） |
| [articles/hello.md](articles/hello.md) / [tests/hello.test.js](tests/hello.test.js) | 人（ハーネスの前提である「最初に全テスト緑」を満たすための土台） |
| [articles/worktree.md](articles/worktree.md) | **AI**（ループが生成し 3つのゲートに合格したもの） |
| [tests/worktree.test.js](tests/worktree.test.js) | **AI**（同上） |

`CLAUDE.md` は置いていない、[sample/express-api/](../express-api/) にあるのは変異チェック向けのコーディング規約で、記事には当てはまらないため（この実走では規約なしで回した）

`.beads/` や `AGENTS.md` を入れていない理由は [sample/README.md](../README.md)

## markdown 用の変異器

Stryker が壊せるのはコード（JavaScript/TypeScript・C#・Scala）で markdown は対象外なので、記事用は自作した（[mutate-md.mjs](mutate-md.mjs)）

記事を1箇所ずつ機械的に壊し、そのたびにテストを実行する

| 壊し方 | 何を確かめているか |
|---|---|
| 見出しの行を削除 | その見出しの存在を検証しているテストがあるか |
| 見出しの記法を壊す（`## X` → `X`） | 見出しとして検証しているか（ただの本文と区別しているか） |
| 箇条書きの項目を削除 | その項目を検証しているテストがあるか |
| コードブロックを削除 | コードブロックの中身を検証しているテストがあるか |
| リンクの URL を空にする | リンクの形式を検証しているテストがあるか |
| 本文の行を削除 | その行を検証しているテストがあるか |

**正直な限界**: 壊し方は上の表にあるものだけで、Stryker のような網羅性は無い。だから「生き残り0」の意味は コードに Stryker を当てた時より弱い

## 再現する

前提は本体 README の[セットアップ](../../README.md#セットアップ)と同じ（Node.js 20 以上・git・Claude Code・beads）

```bash
# 0. clone した loop-engineering-playbook のルートへ移動
cd /path/to/loop-engineering-playbook

# 1. この一式をハーネスの隣へ複製（プロジェクトはハーネスの外に置く）
cp -r sample/article-loop ../my-articles && cd ../my-articles

# 2. 依存をインストール（package-lock.json のとおりに入れる＝実走と同じ木になる）
npm ci

# 3. ループが生成した2ファイルを消す（AI にもう一度書かせるため）
rm articles/worktree.md tests/worktree.test.js

# 4. 緑を確認（土台のテストだけが残る）
npm test

# 5. git と beads を初期化
git init && git add -A && git commit -m "init"
bd init

# 6. タスクを登録（-d には task.md の「仕様」のコードブロックを丸ごと貼る）
bd create "git worktree の使い方を説明する技術記事を書く" -d "<task.md の仕様>"

# 7. ハーネスのルートへ戻って回す（claude を呼ぶ＝課金される）
cd /path/to/loop-engineering-playbook
WORK_ROOT=articles MUTATOR=../my-articles/mutate-md.mjs BASE=../my-articles node harness/integrated.mjs

# 8. 作業コピーを削除（実行中に生まれた未追跡ファイルがあるため --force が要る）
cd ../my-articles && git worktree remove --force ../my-articles-w1
```

不合格になった時の中身は `../my-articles-log/run-<実行日時>/` に残る、消して良い

AI の出力は毎回同じにはならない、書き直しの回数もコストも上下する

## コード以外へ移すために足したもの

**読者がハーネスを書き換える必要は無い** ── このリポジトリの開発時に [harness/integrated.mjs](../../harness/integrated.mjs) へ差し替え口を2つ足してあり、記事ループはそれを使うだけ、合否の判定そのものは触っていない

| 環境変数 | 既定 | 記事ループでの値 |
|---|---|---|
| `WORK_ROOT` | `src` | `articles`（成果物の置き場所・プロンプトと置き場所チェックに使われる） |
| `MUTATOR` | 未設定（Stryker を使う） | `mutate-md.mjs` のパス（`{ survivors, total, output }` を返す関数を default export したモジュール） |

`MUTATOR` を指定すると、Stryker の生き残りを素のテストで検算する自己チェックは飛ばす（自作の変異器は自分で壊して自分でテストを走らせるので、ツールが壊れているかを疑う必要が無い）

ワーカーへのプロンプトはコード向けの文言（「戻り値そのものを検証」「境界値・特殊入力」）を含んだまま、**記事ループのために書き換えてはいない** ── そのままで回して合格したので、**実証していない変更を入れない**方針で残してある
