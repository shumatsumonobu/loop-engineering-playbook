// git worktree 記事の検証。各要素を1つずつ「存在するか」で確認する。
// 見出しは #/## を、箇条書きは "- " を行頭に含めて厳密一致させ、
// 見出しの降格(demotion)・削除(removal)、箇条書きの削除(removal)を検出する。
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";

const md = readFileSync("articles/worktree.md", "utf8");

test("H1 タイトルが見出しとして存在する", () => {
  // "# git worktree の使い方" の # を剥がす/行を消すと落ちる
  expect(md).toMatch(/^# git worktree の使い方$/m);
});

test("見出し「何が嬉しいか」が ## として存在する", () => {
  expect(md).toMatch(/^## 何が嬉しいか$/m);
});

test("見出し「使い方」が ## として存在する", () => {
  // "## 使い方" の ## を剥がす/行を消すと落ちる
  expect(md).toMatch(/^## 使い方$/m);
});

test("見出し「片付け方」が ## として存在する", () => {
  expect(md).toMatch(/^## 片付け方$/m);
});

test("見出し「注意点」が ## として存在する", () => {
  expect(md).toMatch(/^## 注意点$/m);
});

test("bash コードブロック内に git worktree add がある", () => {
  expect(md).toMatch(/```bash[\s\S]*?git worktree add[\s\S]*?```/);
});

test("bash コードブロック内に git worktree remove --force がある", () => {
  expect(md).toMatch(/```bash[\s\S]*?git worktree remove --force[\s\S]*?```/);
});

test("利点の箇条書き（1つ目）が存在する", () => {
  // "- " を消して行を削除すると落ちる
  expect(md).toMatch(/^- 1つのリポジトリから複数のブランチを別ディレクトリで同時に開ける$/m);
});

test("利点の箇条書き（2つ目）が存在する", () => {
  expect(md).toMatch(/^- stash や commit で作業を中断せずにブランチを切り替えられる$/m);
});

test("公式ドキュメントへのリンクが存在する", () => {
  expect(md).toMatch(/\[[^\]]+\]\(https:\/\/git-scm\.com\/docs\/git-worktree\)/);
});
