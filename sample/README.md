# sample — 実際に回した題材

**ここにあるのは「ループを回した側」ではなく「回された側」** ── ループを回したいプロジェクト（＝導入先）の一式

ハーネスはこのリポジトリの [harness/integrated.mjs](../harness/integrated.mjs) を共有して使う、各 sample の中には置かない

| 題材 | 成果物 | 分かること |
|---|---|---|
| [express-api/](express-api/) | JavaScript のコード | 一般的なサービス開発は ハーネスの改造なしで回る |
| [article-loop/](article-loop/) | markdown の記事 | 仕組みも3つのゲートもコード以外へ移植できる、**ただしゲートが保証するのは形式だけ** |
| [python-pytest/](python-pytest/) | Python のコード | **ソースコードの言語は問わない** ── 変異チェックを自作に差し替えるだけで回る |

実測（コスト・所要時間・変異の生き残り）は各 sample の README にある

## どこまでセットアップ済みか

**`bd init` を除いたセットアップ済みの状態**

3つに共通で入っているもの ── `package.json`・成果物とテスト・タスク文

変異チェックの持ち物は題材で違う

| sample | `package.json` | 変異チェック |
|---|---|---|
| express-api | ESM・開発依存に Vitest と Stryker | `stryker.config.json`（ハーネスからコピー） |
| article-loop | ESM・開発依存は Vitest だけ | `mutate-md.mjs`（自作の変異器） |
| python-pytest | テストコマンドの1行だけ（ESM も開発依存も無し） | `mutate-py.mjs`（自作の変異器） |

入っていないもの ── **`bd init` が作るもの一式**（`.beads/`（タスクリスト）・`AGENTS.md`・`.agents/`・`.codex/` と、`CLAUDE.md`・`.gitignore`・`.claude/settings.json` への追記）

`bd init` は既存のファイルを消さない ── 追記して自分でコミットする（実測: 既存の `.claude/settings.json` の項目も `CLAUDE.md` の中身もそのまま残った）

## なぜ beads のファイルを入れないか

**beads はタスクのデータベースを git に置かない設計**

`.beads/` の中身は2種類に分かれる

| 中身 | 何か | git に入るか |
|---|---|---|
| `config.yaml` / `metadata.json` / `hooks/` など | 設定・フックのひな形・DB の名前と ID | 入る |
| `embeddeddolt/` | **タスクが実際に入っているデータベース本体** | **入らない**（beads 自身の `.beads/.gitignore` が除外） |

同期は `bd dolt push/pull` で git の別の保管場所（`refs/dolt/data`）を使う、つまり**複製しただけでは DB が無い**

そのため `.beads/` を同梱しても読者の手間は減らず（結局 `bd init` が要る）、`metadata.json` に入っている**別プロジェクトの DB 名と ID を持ち込む**だけになる

`AGENTS.md` と、`bd init` が `CLAUDE.md` へ追記する beads 用の記述は `bd init` が作るものなので、先に置くと `bd init` と重複する可能性がある（未確認）

## 使い方

各 sample の README にある再現手順のとおりに複製して回す、途中で `bd init` を打つと実際の完成形になる

導入先の要件（テストの置き場所・最初に緑であること・JavaScript なら ESM など）は本体 README の[導入先の要件](../README.md#導入先の要件)
