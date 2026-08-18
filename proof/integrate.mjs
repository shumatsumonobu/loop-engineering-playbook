// integrate.mjs — ⑤統合（DESIGN §7⑤）
//
// 「終わった枝を1本ずつ main に統合 ＋ 毎回 全テストを再実行、
//   緑なら採用／緑にできなければ巻き戻して人へ差し戻し」
//
// ここでも原則は同じ: 統合してよいかは"実際に全テストを走らせて"決める（申告や見た目で決めない）

import { spawnSync } from "node:child_process";

const MAIN = "C:/dev/loop-step0";
const BRANCHES = process.argv.slice(2);
if (BRANCHES.length === 0) { console.log("使い方: node integrate.mjs worker1 worker2"); process.exit(0); }

const log = (m) => console.log(`\n[integrate] ${m}`);
const git = (...a) => spawnSync("git", a, { cwd: MAIN, encoding: "utf8" });
const head = () => git("rev-parse", "HEAD").stdout?.trim() ?? "";

// チェック一式（main で全テストを走らせる）
const checkAll = () =>
  spawnSync("npm", ["test"], {
    cwd: MAIN,
    shell: process.platform === "win32",
    timeout: 120_000,
    encoding: "utf8",
  }).status === 0;

// 統合前に main が緑であることを確認（ベースは常に緑・§4 要件1）
log("統合前チェック: main が緑か");
if (!checkAll()) {
  console.log("[停止] main が既に赤、統合を始めない（ベースは常に緑が前提）");
  process.exit(1);
}
console.log("  main は緑 → 統合を開始");

const results = [];
for (const b of BRANCHES) {
  const before = head();
  log(`${b} を main に統合`);

  const m = git("merge", "--no-edit", b);
  if (m.status !== 0) {
    console.log(`  衝突/失敗:\n${(m.stdout || "") + (m.stderr || "")}`);
    git("merge", "--abort");
    console.log(`  → 統合を中止して巻き戻した、人へ差し戻し（AIによる衝突解決は次段階）`);
    results.push({ b, result: "conflict" });
    continue;
  }

  // 統合しただけでは採用しない、全テストを実際に走らせる
  console.log("  統合できた → 全テストを再実行して確かめる");
  if (checkAll()) {
    console.log(`  緑 → 採用（main に残す）`);
    results.push({ b, result: "merged" });
  } else {
    console.log(`  赤 → 採用しない、巻き戻す（main を緑のまま保つ）`);
    git("reset", "--hard", before);
    results.push({ b, result: "reverted" });
  }
}

console.log("\n" + "=".repeat(60));
console.log("=== 統合の結果 ===");
for (const r of results) console.log(`  ${r.b}: ${r.result}`);
console.log(`  main: ${git("log", "--oneline", "-1").stdout?.trim()}`);
console.log(`  main は緑か: ${checkAll() ? "緑（OK）" : "赤（NG）"}`);
console.log("=".repeat(60));
