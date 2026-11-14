# MAINTAINING — このリポジトリを保守する人向け

loop-engineering-playbook 自体を更新したときに何を確認するか

| こうしたとき | やること |
|---|---|
| ドキュメントを直した（日常） | [検査を走らせる](#検査を走らせる) → 中身は `/review-<対象>`（下の表） |
| ハーネスを直した | [検査を走らせる](#検査を走らせる) → [ハーネスの回帰テストを実行する](#ハーネスの回帰テストを実行する) → [規約と断定を照合する](#規約と断定を照合する) |
| 実験する（`claude` を実際に呼ぶ・課金あり） | [実験の作法](.claude/rules/experiment-hygiene.md) |
| 検査を足した | [検査が効くか確かめる](#検査が効くか確かめる) |
| README の図を直した・図の内容に関わる仕組みを変えた | [図を描き出し直す](#図を描き出し直す) |
| GitHub に公開する | [公開する前に](#公開する前に) |

書き方の規約は `.claude/rules/`、**対象のファイルを読むと自動で渡るので明示的に読ませる必要はない**（このファイル自体は自動では渡らない）

| ファイル | 何が書いてあるか | 読まれるタイミング |
|---|---|---|
| [experiment-hygiene.md](.claude/rules/experiment-hygiene.md) | 実験の作法・作業ツリーを壊さない・課金の確認 | **毎セッション**（コマンドを打つ時に効くので対象を絞れない） |
| [doc-review-passes.md](.claude/rules/doc-review-passes.md) | **レビューの観点リスト**（この順で全部 通す・観点を減らさない） | 保守するドキュメントを触ったとき |
| [doc-guidelines.md](.claude/rules/doc-guidelines.md) | 文体・構成・事実の裏付けの共通基準 | 保守するドキュメントを触ったとき |
| [readme-guidelines.md](.claude/rules/readme-guidelines.md) | 導入手順書としての品質・読者役に試させる検証 | README.md を触ったとき |
| [sample-readme-guidelines.md](.claude/rules/sample-readme-guidelines.md) | ループを実行した記録としての品質 | sample の README と task.md を触ったとき |

**中身のレビューは検査では分からない**、対象ごとにスキルを用意（`/` で呼ぶ）

| スキル | 対象 | 何と突き合わせるか |
|---|---|---|
| [`/review-readme`](.claude/skills/review-readme/SKILL.md) | `README.md` | ハーネスの実装（手順どおりに動くか）＋ 初見の読者 |
| [`/review-design`](.claude/skills/review-design/SKILL.md) | `DESIGN.md`・`CLAUDE.md`・`.claude/rules/`・`.claude/skills/`・`inspect.mjs` | 実装（断定が嘘になっていないか） |
| [`/review-record`](.claude/skills/review-record/SKILL.md) | `proof/`・`sample/*/` | 実測の原本（数字・母集団・限界） |
| [`/review-terms`](.claude/skills/review-terms/SKILL.md) | 全ドキュメント＋コード | 用語の統一（未定義・過負荷・画面に出る文言） |

どれも**視点を渡して読ませるのではなく、断定を列挙して実物と照合する** ── 実測で差を確認（視点を渡した回は0件、突き合わせた回は連続で発見・[proof/README.md](proof/README.md) の落とし穴25〜27）

## 検査を走らせる

```bash
cd /path/to/loop-engineering-playbook
node .claude/scripts/inspect.mjs
```

**push のたびに GitHub Actions でも同じものを実行**（[.github/workflows/inspect.yml](.github/workflows/inspect.yml)）、手元で通しておけば赤くならない

**exit 0 が合格。** 見るのは自動で判定できることだけ、**何を見たかは実行すると項目ごとに表示**（文書とハーネスのコードの両方を見る）

「手順番号を指していないか」は**自動では決められない**ので一覧だけ出力 ── **読者向けの文書では0件が合格**（番号の横に何をする手順か書いてある表だけ可・[doc-guidelines](.claude/rules/doc-guidelines.md)）、`proof/` の実験の記録は当時の事実なので残す

中身の正しさ（主張が実物と合っているか・読者が詰まらないか）はこの検査では分からない、`.claude/rules/` の基準で人が確認

## 検査が効くか確かめる

`inspect.mjs` に検査を足したら、**わざと違反を入れて落ちることを確かめる** ── 書いただけで何も見ていない検査は、合格の表示だけ出して通してしまう

**このリポジトリのファイルを汚して `git checkout` で戻すのは禁止**（未コミットの作業ごと消える・[実験の作法](.claude/rules/experiment-hygiene.md)）、複製して壊す

```bash
cd /path/to/loop-engineering-playbook
rm -rf <リポジトリ外>/check && cp -r . <リポジトリ外>/check && cd <リポジトリ外>/check
# 足した検査が拾うはずの違反を1件ずつ入れて、NG に その行が出るか見る
node .claude/scripts/inspect.mjs
```

**除外したファイルにも1件 入れてみる** ── 実際に起きた: 記号用の除外リストを別の検査へ流用していて、`CLAUDE.md` が丸ごと素通りしていた（複製で試して発覚）

**足せない検査もある** ── 文書の `$X.XX` と `変異N個` を [proof/README.md](proof/README.md) と突き合わせる検査は作れない、**同じ金額が別の実行を指す**（`$1.43` は記事ループの実行と、小さいモジュール10回の上限の2つ）、どの実行の数字かの対応づけは人が決めるしかない

## 図を描き出し直す

README の図は `figures/loop.html` が元、`figures/loop-dark.png` はそれを黒地（`#dark`）で描き出した画像 ── **PNG を直接 編集しない**、HTML を直して描き出し直す

GitHub のソーシャルプレビュー（`figures/ogp.png`）も、中身は `loop.html` を黒地で読み込んで 2:1 に収めたもの ── `loop.html` を直したら2枚とも描き出し直す

図の中身の出典は [harness/integrated.mjs](harness/integrated.mjs) の `doTask` と `mergeToMain`、README の役割の表・3つのゲートの表・コストと時間の表 ── どれかを変えたら図も直す

```bash
cd /path/to/loop-engineering-playbook/tools/figure
npm install
npx playwright install chromium
cd ../..
node tools/figure/render.mjs figures/loop-dark.html figures/loop-dark.png
node tools/figure/render.mjs figures/ogp.html figures/ogp.png
```

`figures/ogp.png` を描き出し直したら、リポジトリの Settings → General → Social preview でアップロードし直す（GitHub は画像をリポジトリから読まない）

`npm install` と `npx playwright install chromium` は初回だけ

確認: `Noto Sans JP 500/700/900: true / true / true` が出ること、書体が読み込めない時は PNG を書かずに exit 1 で停止（代わりの書体だと文字幅が変わり、文字と線が重なっても気づけない）

## ハーネスの回帰テストを実行する

`harness/integrated.mjs` を変えたら、**ワーカー1本の検証だけで済ませない** ── 並列でしか出ない壊れ方がある（[proof/README.md](proof/README.md) の落とし穴31）

リポジトリ外の検証用リポジトリを用意する（ESM・Vitest・Stryker・beads 設定済み・緑）

**置き場所はこのリポジトリの外**（`<リポジトリ外>`・[実験の作法](.claude/rules/experiment-hygiene.md)）

```bash
cd /path/to/loop-engineering-playbook
node proof/new-sandbox.mjs <リポジトリ外>/probe
```

[proof/new-sandbox.mjs](proof/new-sandbox.mjs) が作るのは**関数1個とテスト1本だけの空のリポジトリ**（`src/health.js`・`tests/health.test.js`・`package.json`・`stryker.config.json`）、そこへ依存を入れて `git init` と `bd init` まで実行 ── 導入する側は使わない、README には出てこない

| 実行するもの | コマンド | 壊れていなければ |
|---|---|---|
| ゲートの迂回 | `ATTACK=<種類> WORKER_CMD="node <playbook の絶対パス>/proof/stub-worker-attack.mjs" BASE=<リポジトリ外>/probe node harness/integrated.mjs` | 防御のログが出て **main が元のコミットのまま**・人の一覧に差し戻しが残る |
| 並列（2本） | `WORKER_CMD="node <playbook の絶対パス>/proof/stub-worker-parallel.mjs" BASE=<リポジトリ外>/probe node harness/integrated.mjs 2` | 「開け直した」が1度も出ず、2タスクとも1回目で合格 |
| 正常系（コード） | `WORKER_CMD="node <playbook の絶対パス>/proof/stub-worker.mjs" BASE=<リポジトリ外>/probe node harness/integrated.mjs` | 生き残りが出る → 「書き直しを指示」 → 2回目で生き残り0 → 統合 |
| 正常系（コード以外） | `WORKER_CMD="node <playbook の絶対パス>/proof/stub-worker-md.mjs" WORK_ROOT=articles MUTATOR=<変異器のパス> BASE=<リポジトリ外>/articles node harness/integrated.mjs` | 23個 → 7個まで減って人に差し戻し（[合格までは行かない](proof/stub-worker-md.mjs)のが正しい） |

`ATTACK` は `commit` / `disable` / `tamper` / `config` / `testcmd` / `close`、各1回ずつ実行する

**実行する前にリポジトリ外の検証用リポジトリを初期状態へ戻す**（作業コピー・ブランチ・タスクの状態・main）── 戻す先は `bd init` のコミット、**それより前へ戻すと beads のデータベースが壊れて検証が丸ごと無意味になる**

**作業コピーを消す時は `--force` を付ける** ── ハーネスは実行のたびに `node_modules` と `reports/` を作るので、付けないと `contains modified or untracked files, use --force to delete it` で失敗（実測 exit 128）、失敗を見逃すと作業コピーが残り、次の実行が `fatal: 'w1' is already used by worktree` で落ちる

```bash
git -C <リポジトリ外>/probe worktree remove --force <リポジトリ外>/probe-w1
git -C <リポジトリ外>/probe worktree remove --force <リポジトリ外>/probe-w2
```

**`WORKER_CMD` に渡すパスは絶対パスで書く**（Windows なら `C:/...` 形式・例 `C:/path/to/loop-engineering-playbook/proof/stub-worker.mjs`）

- **相対パスは効かない** ── ハーネスはワーカーを**作業コピーを cwd にして**起動するので、`proof/…` は作業コピーの中を探して見つからない
- **Windows で `/c/...` 形式も効かない** ── 子プロセスでは `C:\c\...` に変換
- どちらの場合も**スタブが起動せず全部「ワーカーの起動に失敗」で差し戻し**になり、**防御が効いたように見える**（実際にこの状態で実行して結果を1回 捨てた）
- 起動できたかは `grep -c "ワーカーの起動に失敗" <ログ>` が 0 かで判定する
- **`BASE` は `/c/...` でも `C:/...` でも動く** ── Git Bash が環境変数の値を `C:/...` へ変換して子プロセスへ渡すため、上の話は `WORKER_CMD`（コマンド文字列の中のパス）にだけ当てはまる

**スタブが動いた証拠に、スタブ自身の出力を数えない** ── ハーネスはワーカーの標準出力と標準エラー出力を変数に格納するだけで画面に出さないので、スタブが `console.error` で出す印（`[attack:…]` など）はログに1件も現れない

- 数えるのは**呼び出し回数**（画面の「合計: 呼び出しN回」）と**防御のログが実際に出ているか**
- 実際に起きた: `[attack:…]` を数えて0件だったので「攻撃が発火していない」と読み違えた、実際は12回 呼ばれて防御が全部 効いていた

## 規約と断定を照合する

ハーネスの挙動を変えたら、**それを語っている文章が嘘になっていないか**を見る、これは検査スクリプトでは分からない

```bash
cd /path/to/loop-engineering-playbook
grep -nE "権限|必ず|できない" CLAUDE.md README.md DESIGN.md
```

**`だけ`・`しない`・`ハーネス`・`ワーカー`・`ゲート` を入れると該当が桁違いに増える**（一般語なので断定でない用法が大半）、それらは直した所の周辺だけ見る

実際に実態とずれていた例（[proof/README.md](proof/README.md) の落とし穴30）

- 「ワーカーに commit / close の**権限**を渡さない」── 権限では止まっていなかった（実際には実行できるので、ハーネスが検出して取り消し）
- 「破壊的な git 操作は**必ず作業領域に限定**」── `reset --mixed`・`checkout -B`・`reset --hard` が実装に3箇所あった
- 「チェック一式（**ビルド＋テスト＋型**）」── ハーネスが呼ぶのは `npm test` だけ

**3つ目は上の `grep` では検出できない** ── 断定の語ではなく**表の中の主張**だった、こういうものは**実装から出発して数える**

```bash
cd /path/to/loop-engineering-playbook
grep -oE 'run\("[a-z]+"|run\(\["[a-z]+"' harness/integrated.mjs | sort -u   # 実際に呼んでいる外部コマンド
grep -oE 'process\.env\.[A-Z_]+' harness/integrated.mjs | sort -u           # 実際に読んでいる環境変数
```

**1箇所 直したら、同じ言い回しを全文 grep する** ── 「ここだけ直した」は「他は間違ったまま」と同じ

## 公開する前に

- `node .claude/scripts/inspect.mjs` が exit 0
- ハーネスを触ったなら[回帰テスト](#ハーネスの回帰テストを実行する)を実行したか

コミットの決まり（著者・メッセージ）は [CLAUDE.md](CLAUDE.md) のコミット規約
