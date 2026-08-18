// harness5.mjs — 難所の仕上げ: 変異チェック（テストが実装を本当に縛っているか）
//
// harness4（赤先行＋凍結）で弾けなかった穴:
//   - 「1ケースだけの ゆるいテスト」
//   - 型だけ見るテスト（例: expect(typeof power(2,3)).toBe('number')）
//     → 実装が無ければ赤になるので赤先行チェックを通ってしまう
//   - 実装のハードコード
//
// 変異チェック: 緑になった後、実装をわざと壊して、テストが赤くなるか確かめる
//   赤くなる   → テストは実装を縛っている（OK）
//   緑のまま   → その変異を検出できない＝テストが弱い（REJECT）
//
// これも「人やAIの判断」ではなく「機械」で判定できる（§4-1 の原則をテストにも適用）
//
// 使い方:
//   node harness5.mjs                    本番
//   FAKE_LAZY_TEST=1 node harness5.mjs   型だけ見るゆるいテストを模擬（変異チェックが弾くはず）

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const FAKE_LAZY = process.env.FAKE_LAZY_TEST === "1";
const CHECK_TIMEOUT_MS = 120_000;
const WORKER_TIMEOUT_MS = 600_000;
const WORK_DIRS = ["src", "tests"];

const log = (m) => console.log(`\n[harness] ${m}`);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const git = (...a) => run("git", a);
const q = (a) => (/[\s"]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));
const bd = (...a) => run(["bd", ...a.map(q)].join(" "), [], { shell: true, encoding: "utf8" });
const check = () =>
  run("npm", ["test"], { shell: process.platform === "win32", timeout: CHECK_TIMEOUT_MS }).status;
const sha = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);
const changedInWork = () =>
  (run("git", ["status", "--porcelain", "--", ...WORK_DIRS]).stdout ?? "")
    .split("\n").filter(Boolean).map((l) => l.slice(3).trim());
const callWorker = (prompt) =>
  !(run("claude", ["-p", "--dangerously-skip-permissions"], {
    input: prompt, stdio: ["pipe", "inherit", "inherit"], timeout: WORKER_TIMEOUT_MS,
  }).error?.code === "ENOENT");

// ---------- 変異ルール（実装をわざと壊す） ----------
// 演算子を1つだけ入れ替える、テストがこれを検出できなければ、そのテストは実装を縛っていない
const MUTATIONS = [
  { name: "** → *", from: " ** ", to: " * " },
  { name: "* → +",  from: " * ",  to: " + " },
  { name: "+ → -",  from: " + ",  to: " - " },
  { name: "- → +",  from: " - ",  to: " + " },
  { name: "/ → *",  from: " / ",  to: " * " },
  { name: "=== → !==", from: " === ", to: " !== " },
  { name: "<= → <",  from: " <= ", to: " < " },
  { name: ">= → >",  from: " >= ", to: " > " },
  { name: "< → <=",  from: " < ",  to: " <= " },
  { name: "> → >=",  from: " > ",  to: " >= " },
];

// 実装を1箇所ずつ壊して、テストが赤くなるか調べる
// 戻り値: 生き残った変異（＝テストが検出できなかった＝弱い）のリスト
function mutationCheck(srcFiles) {
  const survivors = [];
  let tried = 0;
  for (const f of srcFiles) {
    const original = readFileSync(f, "utf8");
    for (const m of MUTATIONS) {
      if (!original.includes(m.from)) continue;
      const mutant = original.replace(m.from, m.to);   // 最初の1箇所だけ壊す
      if (mutant === original) continue;
      tried++;
      writeFileSync(f, mutant);
      const stillGreen = check() === 0;
      writeFileSync(f, original);                      // 必ず元に戻す
      console.log(`  ${f}  [${m.name}]  → ${stillGreen ? "緑のまま（検出できず＝弱い）" : "赤（検出した ✓）"}`);
      if (stillGreen) survivors.push(`${f}: ${m.name}`);
    }
  }
  return { survivors, tried };
}

// ---------- タスクリストから1枚 ----------
const task = JSON.parse(bd("ready", "--json").stdout || "[]")[0];
if (!task) { log("タスクリストに ready なタスクが無い"); process.exit(0); }
bd("update", task.id, "--claim");
log(`タスク: ${task.id} — ${task.title}`);

const fail = (why) => {
  log(`REJECT: ${why}`);
  git("checkout", "--", ...WORK_DIRS);
  run("git", ["clean", "-fd", "--", ...WORK_DIRS]);
  bd("update", task.id, "-s", "open");
  console.log("\n" + "=".repeat(60));
  console.log("結果: REJECT（保存されていない）");
  console.log("=".repeat(60));
  process.exit(1);
};

// ---------- ① テストだけ書かせる ----------
log("① ワーカーに「テストだけ」書かせる");
if (FAKE_LAZY) {
  log("[模擬] 手抜きワーカー: 型だけ見るゆるいテストを書く（赤先行チェックは通ってしまう）");
  writeFileSync("tests/factorial.test.js",
    `import { describe, it, expect } from 'vitest';\n` +
    `import { factorial } from '../src/factorial.js';\n\n` +
    `describe('factorial', () => {\n` +
    `  it('数値を返す', () => {\n    expect(typeof factorial(5)).toBe('number');\n  });\n});\n`);
} else {
  if (!callWorker(
    `あなたはワーカーです。次のタスクの「テストだけ」を書いてください。\n\n## タスク\n${task.title}\n\n` +
    `## 絶対に守ること\n- **テスト（tests/）だけを書く。実装（src/）は絶対に作らない。**\n` +
    `- テストは「そのタスクが本当に出来ているか」を検証する（複数ケース・境界値も）。**戻り値そのものを検証すること**（型だけ見るテストは不合格）。\n` +
    `- まだ実装が無いので、このテストは落ちるのが正しい。\n- CLAUDE.md を読むこと。Vitest・ESM。\n`)) fail("claude 起動不可");
}

const created = changedInWork();
log(`作られたもの: ${created.join(", ") || "なし"}`);
if (created.some((f) => f.startsWith("src/"))) fail("テストだけと言ったのに実装まで作った");
const testFiles = created.filter((f) => f.startsWith("tests/"));
if (testFiles.length === 0) fail("テストが書かれていない");

// ---------- ② 赤先行チェック ----------
log("② 赤先行チェック: 実装が無い状態でテストを走らせる");
if (check() === 0) fail("実装が無いのにテストが通った（何も検証していない）");
console.log("  → 赤、何かを検証している ✓");

// ---------- ③ テストを凍結 ----------
const frozen = Object.fromEntries(testFiles.map((f) => [f, sha(f)]));
log(`③ テストを凍結: ${testFiles.join(", ")}`);

// ---------- ④ 実装させる ----------
log("④ ワーカーに実装させる（テストは変更禁止）");
if (!callWorker(
  `あなたはワーカーです。次のタスクの「実装」を書いてください。\n\n## タスク\n${task.title}\n\n` +
  `## 状況\n受け入れテスト（${testFiles.join(", ")}）が既にあり、今は落ちています。これを通す実装を src/ に書いてください。\n\n` +
  `## 絶対に守ること\n- **テストファイルは1文字も変更しない。**\n- テストに合わせて値をハードコードしない。\n- CLAUDE.md を読むこと。\n`)) fail("claude 起動不可");

// ---------- ⑤ テスト凍結の検証 ----------
log("⑤ テストが書き換えられていないか");
for (const [f, h] of Object.entries(frozen)) if (sha(f) !== h) fail(`テスト ${f} が書き換えられた（弱めて通すズル）`);
console.log("  → 凍結されたまま ✓");

// ---------- ⑥ チェック一式 ----------
log("⑥ チェック一式（npm test）");
if (check() !== 0) fail("実装後もテストが赤");
console.log("  → 緑 ✓");

// ---------- ⑦ 変異チェック（テストが実装を本当に縛っているか）----------
const srcFiles = changedInWork().filter((f) => f.startsWith("src/"));
log(`⑦ 変異チェック: 実装をわざと壊して、テストが気づくか（${srcFiles.join(", ")}）`);
const { survivors, tried } = mutationCheck(srcFiles);

if (tried === 0) {
  log("[警告] 壊せる箇所が見つからなかった（変異チェック不能）→ 人に確認させる");
  fail("変異チェックができない実装（演算子が無い等）");
}
if (survivors.length > 0) {
  fail(`テストが弱い、次の変異を検出できなかった（実装を壊しても緑のまま）:\n    - ${survivors.join("\n    - ")}`);
}
console.log(`  → ${tried} 個の変異を全部 検出した ✓ テストは実装を縛っている`);

// ---------- ⑧ 保存 ----------
log("合格 → 保存（commit + bd close）");
git("add", "-A");
git("commit", "-m", `${task.title}\n\nharness: 赤先行→凍結→実装→緑→変異チェック(${tried}個 全検出) を確認して保存`);
bd("close", task.id, "--reason", `テストの機械ゲート（赤先行＋凍結＋変異チェック）を通過`);

console.log("\n" + "=".repeat(60));
console.log(`結果: 合格（テストが実装を縛っていることまで機械で確認: 変異 ${tried}個 全検出）`);
console.log(`  ${git("log", "--oneline", "-1").stdout.trim()}`);
console.log("=".repeat(60));
