// harness4.mjs — 難所への答え: 「テストにも客観ゲートを掛ける」
//
// これまでの穴: ワーカーがテストと実装を同時に書く＝自分の答案を自分で採点
//   弱いテスト（expect(true).toBe(true) 等）を書けば、緑ゲートは何も守らない
//
// 答え: テストの良し悪しも「人やAIの判断」ではなく「機械」で判定（＝§4-1 の原則をテストにも適用）
//
// 2フェーズ ＋ 機械的なテスト品質ゲート:
//   ① ワーカーが「テストだけ」書く（実装は作らせない）
//   ② 赤先行チェック: 実装が無い状態でテストを走らせる
//        赤 → OK（そのテストは"何か"を検証している）
//        緑 → REJECT（実装が無いのに通る＝何も検証していない弱いテスト）
//   ③ テストを凍結（ハッシュを記録）
//   ④ ワーカーが実装する
//   ⑤ テストが書き換えられていないか検証（弱めて通すズルを封じる）
//   ⑥ チェック一式 → 緑で保存
//
// 使い方:
//   node harness4.mjs                   本番
//   FAKE_WEAK_TEST=1 node harness4.mjs  手抜きワーカーを模擬（赤先行チェックが弾くはず）

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const FAKE_WEAK = process.env.FAKE_WEAK_TEST === "1";
const CHECK_TIMEOUT_MS = 120_000;
const WORKER_TIMEOUT_MS = 600_000;

// ワーカーの作業領域だけを巻き戻す、リポジトリ全体を clean すると
//   ハーネス自身（未追跡ファイル）まで消える（実際にやらかした）
const WORK_DIRS = ["src", "tests"];

const log = (m) => console.log(`\n[harness] ${m}`);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const git = (...a) => run("git", a);
const q = (a) => (/[\s"]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));
const bd = (...a) => run(["bd", ...a.map(q)].join(" "), [], { shell: true, encoding: "utf8" });

const check = () =>
  run("npm", ["test"], { shell: process.platform === "win32", timeout: CHECK_TIMEOUT_MS }).status;

const sha = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);

// ワーカーが作業領域に作った/変えたファイル
const changedInWork = () =>
  (run("git", ["status", "--porcelain", "--", ...WORK_DIRS]).stdout ?? "")
    .split("\n").filter(Boolean).map((l) => l.slice(3).trim());

const callWorker = (prompt) => {
  const r = run("claude", ["-p", "--dangerously-skip-permissions"], {
    input: prompt, stdio: ["pipe", "inherit", "inherit"], timeout: WORKER_TIMEOUT_MS,
  });
  return !(r.error?.code === "ENOENT");
};

// ---------- タスクリストから1枚 ----------
const task = JSON.parse(bd("ready", "--json").stdout || "[]")[0];
if (!task) { log("タスクリストに ready なタスクが無い"); process.exit(0); }
bd("update", task.id, "--claim");
log(`タスク: ${task.id} — ${task.title}`);

const fail = (why) => {
  log(`REJECT: ${why}`);
  log("保存しない、作業領域を巻き戻して claim を解放（人の対応待ち）");
  git("checkout", "--", ...WORK_DIRS);          // 変更を戻す
  run("git", ["clean", "-fd", "--", ...WORK_DIRS]); // 作業領域だけ掃除（ハーネスは消さない）
  bd("update", task.id, "-s", "open");
  console.log("\n" + "=".repeat(60));
  console.log("結果: REJECT（保存されていない）");
  console.log("=".repeat(60));
  process.exit(1);
};

// ---------- ① テストだけ書かせる ----------
log("① ワーカーに「テストだけ」書かせる（実装は作らせない）");
if (FAKE_WEAK) {
  log("[模擬] 手抜きワーカー: 何も検証しない弱いテストを書く");
  writeFileSync("tests/power.test.js",
    `import { describe, it, expect } from 'vitest';\n` +
    `describe('power', () => {\n  it('とりあえず通る', () => {\n    expect(true).toBe(true);\n  });\n});\n`);
} else {
  const ok = callWorker(
    `あなたはワーカーです。次のタスクの「テストだけ」を書いてください。\n\n` +
    `## タスク\n${task.title}\n\n` +
    `## 絶対に守ること\n` +
    `- **テスト（tests/）だけを書く。実装（src/）は絶対に作らない。**\n` +
    `- テストは「そのタスクが本当に出来ているか」を検証する内容にする（複数ケース・境界値も）。\n` +
    `- まだ実装が無いので、このテストは"落ちる"のが正しい。\n` +
    `- CLAUDE.md を読むこと。Vitest・ESM。\n`);
  if (!ok) fail("claude を起動できない");
}

const created = changedInWork();
log(`ワーカーが作業領域に作ったもの: ${created.join(", ") || "なし"}`);
if (created.some((f) => f.startsWith("src/"))) fail("テストだけ書けと言ったのに実装(src/)まで作った（ルール違反）");
const testFiles = created.filter((f) => f.startsWith("tests/"));
if (testFiles.length === 0) fail("テストが1つも書かれていない");

// ---------- ② 赤先行チェック（テストの客観ゲート）----------
log("② 赤先行チェック: 実装が無い状態でテストを走らせる");
if (check() === 0) {
  fail("実装が無いのにテストが通った ＝ そのテストは何も検証していない（弱いテスト）");
}
console.log("  → 赤、このテストは「何か」を検証している ✓");

// ---------- ③ テストを凍結 ----------
const frozen = Object.fromEntries(testFiles.map((f) => [f, sha(f)]));
log(`③ テストを凍結（実装フェーズで書き換えられたら REJECT）: ${testFiles.join(", ")}`);

// ---------- ④ 実装させる ----------
log("④ ワーカーに実装させる（テストは変更禁止）");
if (!callWorker(
  `あなたはワーカーです。次のタスクの「実装」を書いてください。\n\n` +
  `## タスク\n${task.title}\n\n` +
  `## 状況\n既に受け入れテスト（${testFiles.join(", ")}）が置いてあり、今は落ちています。これを通す実装を src/ に書いてください。\n\n` +
  `## 絶対に守ること\n` +
  `- **テストファイルは1文字も変更しない**（弱めたり消したりしない）。変更したら不合格になります。\n` +
  `- テストに合わせて値をハードコードしない。ちゃんとした実装を書く。\n` +
  `- CLAUDE.md を読むこと。\n`)) fail("claude を起動できない");

// ---------- ⑤ テストが書き換えられていないか ----------
log("⑤ テストが書き換えられていないか検証");
for (const [f, h] of Object.entries(frozen)) {
  if (sha(f) !== h) fail(`テスト ${f} が実装フェーズで書き換えられた（弱めて通すズル）`);
}
console.log("  → テストは凍結されたまま ✓");

// ---------- ⑥ チェック一式 → 緑で保存 ----------
log("⑥ チェック一式を実行（npm test）");
if (check() !== 0) fail("実装後もテストが赤（実装が不十分）");

log("緑 → 保存（commit + bd close）");
git("add", "-A");
git("commit", "-m", `${task.title}\n\nharness: 赤先行チェック→テスト凍結→実装→緑 を確認して保存`);
bd("close", task.id, "--reason", "テストの客観ゲート（赤先行＋凍結）を通過して緑");

console.log("\n" + "=".repeat(60));
console.log("結果: 合格（テストの質も機械で検証したうえで保存）");
console.log(`  ${git("log", "--oneline", "-1").stdout.trim()}`);
console.log("=".repeat(60));
