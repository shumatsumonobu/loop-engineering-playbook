// stub-worker-md.mjs — claude の代わりに決まった動きをする偽のワーカー（記事の場合・$0）
//
// なぜ要るか:
//   成果物がコードでない時にも「書き直しの指示」が効くかを、課金せず 毎回 同じ結果で確かめるため
//   弱いテスト（記事の中身を何も見ていない・23個 全部 生き残る）
//     → 書き直しの指示 → 強いテスト（7個まで減る）を再現する
//
// 使い方（ハーネスのルートから・対象は記事を置いたリポジトリ外の検証用リポジトリ）:
//   WORKER_CMD="node <絶対パス>/proof/stub-worker-md.mjs" WORK_ROOT=articles \
//     MUTATOR=<変異器の絶対パス> BASE=/path/to/articles node harness/integrated.mjs
//
// 注意1: 成果物は articles/ に固定で書く ── 上の使い方どおり WORK_ROOT=articles を渡すこと
//   別の場所を指定すると、ハーネスはそこを見るのにこのスタブは articles/ に書くので落ちる
//
// 注意2: 合格までは行かない ── 強いテストは固定なので必ず7個 残って人に差し戻される
//   残る7個の内訳
//     記述の重複     `# … 使い方` と `## 使い方` が同じ検証にマッチして互いを隠す
//     飾りの文       どのテストも見ていない
//   ＝書き直しの指示が効くことと、記事では重複が生き残ることの両方を確かめられる
//
// 判定 ── 記事もテストも固定なので、下の数は毎回 同じになる（走るたびに変わる実測値ではない）
//   壊れていない  1回目に生き残り23/23 → 書き直しの指示 → 2回目に生き残り7 → 人に差し戻し
//   壊れている    数が上とずれる、または書き直しの指示が出ないまま終わる
//   数の出どころは proof/README.md（記事ループの段階の行）

import { writeFileSync, mkdirSync } from "node:fs";

const ART = "articles/worktree.md";
const TEST = "tests/worktree.test.js";
const FENCE = "```";

const ARTICLE = [
  "# git worktree の使い方",
  "",
  "同じリポジトリの作業コピーを複数持てる git の機能",
  "",
  "## 何が嬉しいか",
  "",
  "ブランチを切り替えずに、別の作業を並行して進められる",
  "",
  "- 作業の中断が要らない",
  "- ビルド結果を作り直さずに済む",
  "",
  "手元の変更を退避してから切り替える、という手順が丸ごと不要になる",
  "",
  "## 使い方",
  "",
  "作業コピーを追加する、新しいブランチを同時に作れる",
  "",
  FENCE + "bash",
  "git worktree add ../myrepo-w1 -b feature",
  FENCE,
  "",
  "指定した場所に作業コピーができて、そこで普通に編集もコミットもできる",
  "",
  "## 片付け方",
  "",
  "不要になったら削除する、作業コピーの中で生まれた未追跡ファイルがあると失敗するので --force が要る",
  "",
  FENCE + "bash",
  "git worktree remove --force ../myrepo-w1",
  FENCE,
  "",
  "削除しても元のリポジトリのブランチはそのまま残る、消えるのは作業コピーだけ",
  "",
  "## 注意点",
  "",
  "同じブランチを2つの作業コピーで同時に開くことはできない、別々のブランチを割り当てる",
  "",
  "一覧の確認方法は [公式ドキュメント](https://git-scm.com/docs/git-worktree) を参照",
  "",
].join("\n");

// 弱い: ファイルが空でないことしか見ていない → 見出しを消してもリンクを壊しても緑のまま
const WEAK = [
  'import { test, expect } from "vitest";',
  'import { readFileSync } from "node:fs";',
  `const md = readFileSync("${ART}", "utf8");`,
  'test("記事が空でない", () => expect(md.length).toBeGreaterThan(0));',
  "",
].join("\n");

// 強い: 「数」ではなく「タスク文が要求した要素の存在」を検証する
//   数を数える検証（見出しが4つ以上 等）は、記事に余裕がある分だけ変異を殺せない
const STRONG = [
  'import { test, expect } from "vitest";',
  'import { readFileSync } from "node:fs";',
  `const md = readFileSync("${ART}", "utf8");`,
  'test("何が嬉しいかの見出しがある", () => expect(md).toMatch(/^#+ .*嬉しい/m));',
  'test("使い方の見出しがある", () => expect(md).toMatch(/^#+ .*使い方/m));',
  'test("片付け方の見出しがある", () => expect(md).toMatch(/^#+ .*片付け方/m));',
  'test("注意点の見出しがある", () => expect(md).toMatch(/^#+ .*注意点/m));',
  'test("追加するコマンドを載せている", () => expect(md).toMatch(/git worktree add/));',
  'test("削除するコマンドを載せている", () => expect(md).toMatch(/git worktree remove/));',
  'test("強制指定に触れている", () => expect(md).toMatch(/--force/));',
  'test("利点を箇条書きで挙げている", () => expect(md).toMatch(/^\\s*[-*] .*中断/m) && expect(md).toMatch(/^\\s*[-*] .*ビルド/m));',
  'test("公式ドキュメントへのリンクがある", () => expect(md).toMatch(/\\[[^\\]]+\\]\\(https:\\/\\/git-scm\\.com[^)]*\\)/));',
  'test("ブランチを切り替えずに済むことを説明している", () => expect(md).toMatch(/切り替え/));',
  'test("同じブランチを2つ開けないことに触れている", () => expect(md).toMatch(/同じブランチ/));',
  'test("作業コピーができる場所の説明がある", () => expect(md).toMatch(/指定した場所/));',
  'test("削除してもブランチが残ることに触れている", () => expect(md).toMatch(/ブランチはそのまま/));',
  'test("退避が不要になることに触れている", () => expect(md).toMatch(/退避/));',
  'test("複数の作業コピーを持てることを説明している", () => expect(md).toMatch(/作業コピーを複数/));',
  "",
].join("\n");

let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  mkdirSync("articles", { recursive: true });
  mkdirSync("tests", { recursive: true });
  if (prompt.includes("テストだけ")) {
    const strong = prompt.includes("前回のテストは不合格") && process.env.STUB_MODE !== "always-weak";
    writeFileSync(TEST, strong ? STRONG : WEAK);
    console.error(`[stub-md] テスト段階 → ${strong ? "強い" : "弱い"}テストを書いた`);
  } else {
    writeFileSync(ART, ARTICLE);
    console.error("[stub-md] 成果物段階 → 記事を書いた");
  }
  process.exit(0);
});
