# sample: Python のループ（JavaScript 以外の言語）

ループを回したいプロジェクト（＝導入先）の一式（→ [sample/README.md](../README.md)）、**ソースコードが Python** のタスクを [ハーネス](../../harness/integrated.mjs)で回した結果

題材は fizzbuzz、**ループに渡したのは [task.md](task.md) の文章1つだけ**（土台のコードと設定と変異器は人が用意）

## 何を確かめたかったか

本体 README の[導入先の要件](../../README.md#導入先の要件)はこう主張している

1. **ソースコードの言語は問わない** ── ハーネスは導入先で `npm install` と `npm test` を実行するだけ
2. 言語で変わるのは**変異チェックだけ**、[Stryker](https://stryker-mutator.io) が使えない言語は自分で書いて差し替える

この sample は**両方とも実物で確かめたもの**、ハーネスを1文字も変えずに回している

## 結果

**1. ハーネスの改造なしで、Python のまま通った**

| 項目 | 値 |
|---|---|
| コスト | $0.5783 |
| 所要時間 | 157.9秒 |
| `claude` の呼び出し | 2回（テストと実装で1回ずつ） |
| 書き直し | 0回（**1周目で合格**） |
| 変異チェック | 16個中 生き残り0 |
| ハーネスの変更 | **無し**（`git diff -- harness/` が空） |

起動はこれだけ

```bash
MUTATOR=/path/to/mutate-py.mjs WORK_ROOT=src BASE=/path/to/this-project node harness/integrated.mjs
```

導入先の `package.json` は `"test": "python -m pytest -q"` の1行だけ、**`"type": "module"` は書いていない**（ESM は Stryker のための要件なので、使わないなら要らない）

**2. ハーネスの外からも確かめた**

ハーネスの自己申告だけでは「本当に動いた」と言えないので、外から3つ 確かめた

| 確かめたこと | 結果 |
|---|---|
| 生成物が本物の Python か | [src/fizzbuzz.py](src/fizzbuzz.py) 8行・[tests/test_fizzbuzz.py](tests/test_fizzbuzz.py) 59行 |
| ハーネスの外で pytest が通るか | `python -m pytest -q` → `12 passed` |
| 変異チェックを外から回しても生き残り0か | 16個すべて killed |

変異器が「何を壊しても全部 killed になる」だけの見せかけでないことも先に確かめた ── 境界を検証していないテスト（`classify(1)` だけ見て `n >= 10` の境界を見ないもの）に当てたら、**生き残り4個を正しく報告**した

## 中身

| ファイル | 誰が書いたか |
|---|---|
| [package.json](package.json) | 人（`scripts.test` だけ・依存はゼロ） |
| [pytest.ini](pytest.ini) | 人（`pythonpath = .` ── テストから `from src.x import y` で読めるようにする） |
| [.gitignore](.gitignore) | 人（`node_modules/`・`__pycache__/`・`.pytest_cache/`・`reports/` を除外） |
| [mutate-py.mjs](mutate-py.mjs) | 人（Python 用の変異器・下で説明） |
| [CLAUDE.md](CLAUDE.md) | 人（このプロジェクトの規約・言語とテストの書き方）、`bd init` が追記する beads 用の記述は実走後に外した（複製して `bd init` を打つと入る） |
| [task.md](task.md) | 人（`bd create` に渡したタスク文と その書き方の理由） |
| [src/greet.py](src/greet.py) / [tests/test_greet.py](tests/test_greet.py) | 人（ハーネスの前提である「最初に全テスト緑」を満たすための土台） |
| [src/fizzbuzz.py](src/fizzbuzz.py) | **AI**（ループが生成し 3つのゲートに合格したもの） |
| [tests/test_fizzbuzz.py](tests/test_fizzbuzz.py) | **AI**（同上） |

`package-lock.json` は無い ── npm の依存が1つも無いため（ハーネスが `npm install` を実行しても何も入らない）

`.beads/` や `AGENTS.md` を入れていない理由は [sample/README.md](../README.md)

## Python 用の変異器

Stryker が壊せるのは JavaScript/TypeScript・C#・Scala で Python は対象外なので自作した（[mutate-py.mjs](mutate-py.mjs)）

実装を1箇所ずつ機械的に壊し、そのたびにテストを実行する

| 壊し方 | 何を確かめているか |
|---|---|
| 比較演算子を変える（`>=` → `>`） | 境界を検証しているテストがあるか |
| 算術演算子を変える（`%` → `*`） | その計算を検証しているテストがあるか |
| 論理演算子を変える（`and` → `or`） | 条件の組み合わせを検証しているか |
| 真偽値を反転する（`True` → `False`） | その値を検証しているか |
| `not` を消す（`if not x` → `if x`） | 条件の向きを検証しているか |
| 数値を +1 する（`15` → `16`） | 境界の値を検証しているか |
| 文字列を空にする（`"Fizz"` → `""`） | 戻り値の中身を検証しているか |
| `return X` を `return None` にする | 戻り値そのものを検証しているか |

**正直な限界**: 壊し方は上の表にあるものだけで、行単位の正規表現で書き換えている（構文木は解析していない）。だから「生き残り0」の意味は JavaScript に Stryker を当てた時より弱い

## 再現する

前提は本体 README の[セットアップ](../../README.md#セットアップ)と同じ（Node.js 20 以上・git・Claude Code・beads）に加えて **Python と pytest**

```bash
# 0. clone した loop-engineering-playbook のルートへ移動
cd /path/to/loop-engineering-playbook

# 1. この一式を作業したい場所へ複製（ハーネスのリポジトリの中には作らない）
cp -r sample/python-pytest /path/to/my-python-loop
cd /path/to/my-python-loop

# 2. pytest を入れて 土台が緑か確認
python -m pip install pytest
npm test            # 12 passed（AI の生成物を含む状態）

# 3. AI が作ったものを消して、人が用意した土台だけに戻す
rm src/fizzbuzz.py tests/test_fizzbuzz.py
npm test            # 2 passed（greet の分だけ）

# 4. git と beads を初期化して、タスクを1件 登録
git init && git add -A && git commit -m "Python の土台"
bd init
bd create "src/fizzbuzz.py に fizzbuzz(n) を実装" -d "<task.md の仕様をそのまま>"

# 5. ハーネスのルートへ移り、MUTATOR を渡して実行
cd /path/to/loop-engineering-playbook
MUTATOR=/path/to/my-python-loop/mutate-py.mjs WORK_ROOT=src \
  BASE=/path/to/my-python-loop node harness/integrated.mjs

# 6. 作業コピーを削除（実行中に生まれた未追跡ファイルがあるため --force が要る）
cd /path/to/my-python-loop && git worktree remove --force /path/to/my-python-loop-w1
```

不合格になった時の中身は `/path/to/my-python-loop-log/run-<実行日時>/` に残る、消して良い

実行の最初に `対象: …｜成果物: src/｜変異チェック: 自作` と出る、**変異チェックが `自作` でなければ `MUTATOR` のパスが渡っていない**

同じタスク文からでも AI の出力は毎回ちがう（変数名・テストの書き方・関数の並び）、通ることと 生き残り0 になることは再現する

## 本体 README のセットアップとの違い

変わるのは次の5つ、ほかの手順はそのまま

| 何をする手順 | 本体 README | Python の場合 |
|---|---|---|
| 依存を追加 | `npm install -D vitest stryker…` | **npm の依存は入れない**、代わりに `pip install pytest`（`bd init` は同じように打つ） |
| ESM に設定 | `"type": "module"` を追加 | **要らない** |
| テストコマンド | `"test": "vitest run"` | `"test": "python -m pytest -q"` |
| Stryker の設定 | `stryker.config.json` をコピー | **コピーしない**、代わりに変異器を1本 書く |
| 実行 | `BASE=… node harness/integrated.mjs` | `MUTATOR=…` を足す |
