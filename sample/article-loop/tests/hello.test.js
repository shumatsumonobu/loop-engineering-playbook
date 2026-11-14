// 人が用意した緑のベース（ハーネスの前提: 最初に全テスト緑）
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";

const md = readFileSync("articles/hello.md", "utf8");

test("見出しが3つ以上ある", () => {
  expect(md.match(/^#{1,2} .+$/gm).length).toBeGreaterThanOrEqual(3);
});

test("リンクが正しい形式で含まれる", () => {
  expect(md).toMatch(/\[[^\]]+\]\(https?:\/\/[^)]+\)/);
});
