// harness6.mjs — 難所の完成形: 3枚の機械ゲート（赤先行 → 凍結 → 変異チェック/Stryker）
//
// harness5 との違い: 変異ルールを自作しない、実在のツール（Stryker）に任せる
//   自作ルール（harness5 の MUTATIONS）は空白区切りの演算子しか壊せず、
//   factorial の実装から変異を1個しか作れなかった（*= も ++ も数値リテラルも見逃す）
//   → Stryker は同じ実装から 7個 の変異を作る、ゲートの深さが桁違い
//
// ゲート条件＝「生き残った変異が 0 個」（変異スコアの閾値ではない）
// 実測でそう決めた:
//
//   実装               テスト    変異スコア  survived  「スコア>=80」  「survived==0」
//   factorial(ループ)  本物       100%         0        合格            合格
//   factorial(ループ)  ゆるい      28.57%       5        REJECT          REJECT
//   gcd(whileループ)  ゆるい      80.00%       1        すり抜けた      REJECT
//   gcd(再帰)          本物       100%         0        合格            合格
//   gcd(再帰)          ゆるい      60.00%       2        REJECT          REJECT
//
//   → 変異スコアは「実装の形」で 60〜80% と揺れる（while を false に壊すと無限ループ→
//     タイムアウト→変異テストは "検出した(killed)" と数える＝何も検証してないテストが
//     点をもらう）、実際に「ゆるいテストが 80.00% でゲートを通過してコミットされた」
//   → survived（生き残った変異）は揺れない、「テストが検出できない壊し方が在る」＝
//     まさに知りたいこと、だからスコアではなく survived を見る
//
// 判定はハーネスが持つ（Stryker の thresholds.break には任せない＝唯一の門番）
// 等価変異（壊しても動きが変わらない＝誰にも殺せない変異）で詰まった時は、
//   AIに「等価だから無視していい」と判断させない（＝自分の答案を自分で採点に逆戻り）
//   → REJECT して人に差し戻し、無視の印（// Stryker disable）を書けるのは人間だけ
//   → ループは止まらない（他のワーカーは次のタスクへ）＝放置と両立
//
// 実装の鉄則（2回 事故った）: ハーネスは「ワーカーの作業領域（src / tests）」だけを触る
//   - `git clean -fd`（リポジトリ全体）→ 未追跡のハーネス自身が消えた
//   - `git add -A`（リポジトリ全体）  → ハーネス自身・設定・ロックファイルをコミットに巻き込み、
//                                巻き戻し（reset --hard）で全部 消えた
//   → add も clean も checkout も **必ず `-- src tests` で限定**

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const FAKE_LAZY = process.env.FAKE_LAZY_TEST === "1";
const CHECK_TIMEOUT_MS = 120_000;
const MUTATION_TIMEOUT_MS = 900_000;   // 変異テストはテストスイートを何度も回すので長め
const WORKER_TIMEOUT_MS = 600_000;
const WORK_DIRS = ["src", "tests"];    // ハーネスが触っていい範囲はここだけ

const log = (m) => console.log(`\n[harness] ${m}`);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const git = (...a) => run("git", a);
const q = (a) => (/[\s"]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));
const bd = (...a) => run(["bd", ...a.map(q)].join(" "), [], { shell: true, encoding: "utf8" });
const sha = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);

const check = () =>
  run("npm", ["test"], { shell: process.platform === "win32", timeout: CHECK_TIMEOUT_MS, stdio: "inherit" }).status;

// 変異チェック＝Stryker を走らせ、ハーネスが JSON を読んで「生き残った変異」を数える
//   --mutate で「今回 変更した src だけ」に絞る（毎回 全部やると遅い）
//   戻り値: { survivors: [...], total: n }   survivors が1個でもあれば REJECT
const MUTATION_REPORT = "reports/mutation.json";

function mutationCheck(srcFiles) {
  const r = run("npx", ["stryker", "run", "--mutate", srcFiles.join(",")], {
    shell: process.platform === "win32",
    timeout: MUTATION_TIMEOUT_MS,
    stdio: "inherit",
  });
  if (r.error || !existsSync(MUTATION_REPORT)) return { error: "Stryker が動かなかった" };

  const report = JSON.parse(readFileSync(MUTATION_REPORT, "utf8"));
  const survivors = [];
  let total = 0;
  for (const [file, data] of Object.entries(report.files ?? {})) {
    for (const m of data.mutants ?? []) {
      if (m.status === "Ignored") continue;   // 人が明示的に無視の印を付けたもの（AIは付けられない）
      total++;
      // Survived  = 壊してもテストが赤くならなかった（＝テストが検出できない）
      // NoCoverage = そもそもテストがその行を通っていない（＝検出しようがない）
      if (m.status === "Survived" || m.status === "NoCoverage") {
        survivors.push(`${file}:${m.location?.start?.line} ${m.mutatorName}（${m.status}）`);
      }
    }
  }
  return { survivors, total };
}

const changedInWork = () =>
  (run("git", ["status", "--porcelain", "--", ...WORK_DIRS]).stdout ?? "")
    .split("\n").filter(Boolean).map((l) => l.slice(3).trim());

const callWorker = (prompt) =>
  !(run("claude", ["-p", "--dangerously-skip-permissions"], {
    input: prompt, stdio: ["pipe", "inherit", "inherit"], timeout: WORKER_TIMEOUT_MS,
  }).error?.code === "ENOENT");

// ---------- タスクリストから1枚 ----------
const task = JSON.parse(bd("ready", "--json").stdout || "[]")[0];
if (!task) { log("タスクリストに ready なタスクが無い"); process.exit(0); }
bd("update", task.id, "--claim");
log(`タスク: ${task.id} — ${task.title}`);

const fail = (why) => {
  log(`REJECT: ${why}`);
  git("checkout", "--", ...WORK_DIRS);              // 作業領域だけ
  run("git", ["clean", "-fd", "--", ...WORK_DIRS]); // 作業領域だけ
  bd("update", task.id, "-s", "open");
  console.log("\n" + "=".repeat(60));
  console.log("結果: REJECT（1行も保存されていない）");
  console.log("=".repeat(60));
  process.exit(1);
};

// ---------- ① テストだけ書かせる ----------
log("① ワーカーに「テストだけ」書かせる");
if (FAKE_LAZY) {
  log("[模擬] 手抜きワーカー: 型だけ見るゆるいテスト（赤先行チェックは通ってしまう）");
  writeFileSync("tests/lcm.test.js",
    `import { describe, it, expect } from 'vitest';\n` +
    `import { lcm } from '../src/lcm.js';\n\n` +
    `describe('lcm', () => {\n` +
    `  it('数値を返す', () => {\n    expect(typeof lcm(4, 6)).toBe('number');\n  });\n});\n`);
} else {
  if (!callWorker(
    `あなたはワーカーです。次のタスクの「テストだけ」を書いてください。\n\n## タスク\n${task.title}\n\n` +
    `## 絶対に守ること\n- **テスト（tests/）だけを書く。実装（src/）は絶対に作らない。**\n` +
    `- **戻り値そのものを検証すること**（型だけ見るテストは不合格）。複数ケース・境界値も。\n` +
    `- まだ実装が無いので、このテストは落ちるのが正しい。\n- CLAUDE.md を読むこと。Vitest・ESM。\n`)) fail("claude 起動不可");
}

const created = changedInWork();
log(`作られたもの: ${created.join(", ") || "なし"}`);
if (created.some((f) => f.startsWith("src/"))) fail("テストだけと言ったのに実装まで作った");
const testFiles = created.filter((f) => f.startsWith("tests/"));
if (testFiles.length === 0) fail("テストが書かれていない");

// ---------- ② ゲート1: 赤先行 ----------
log("② ゲート1｜赤先行: 実装が無い状態でテストを走らせる");
if (check() === 0) fail("実装が無いのにテストが通った（何も検証していない）");
console.log("  → 赤、何かを検証している ✓");

// ---------- ③ ゲート2: 凍結 ----------
const frozen = Object.fromEntries(testFiles.map((f) => [f, sha(f)]));
log(`③ ゲート2｜凍結: ${testFiles.join(", ")}`);

// ---------- ④ 実装させる ----------
log("④ ワーカーに実装させる（テストは変更禁止）");
if (!callWorker(
  `あなたはワーカーです。次のタスクの「実装」を書いてください。\n\n## タスク\n${task.title}\n\n` +
  `## 状況\n受け入れテスト（${testFiles.join(", ")}）が既にあり、今は落ちています。これを通す実装を src/ に書いてください。\n\n` +
  `## 絶対に守ること\n- **テストファイルは1文字も変更しない。**\n- テストに合わせて値をハードコードしない。\n- CLAUDE.md を読むこと。\n`)) fail("claude 起動不可");

// ---------- ⑤ 凍結の検証 ----------
log("⑤ テストが書き換えられていないか");
for (const [f, h] of Object.entries(frozen)) if (sha(f) !== h) fail(`テスト ${f} が書き換えられた（弱めて通すズル）`);
console.log("  → 凍結されたまま ✓");

// ---------- ⑥ チェック一式 ----------
log("⑥ チェック一式（npm test）");
if (check() !== 0) fail("実装後もテストが赤");
console.log("  → 緑 ✓");

// ---------- ⑦ ゲート3: 変異チェック（Stryker） ----------
const srcFiles = changedInWork().filter((f) => f.startsWith("src/"));
if (srcFiles.length === 0) fail("実装（src/）が作られていない");
log(`⑦ ゲート3｜変異チェック（Stryker）: ${srcFiles.join(", ")}`);
const mut = mutationCheck(srcFiles);
if (mut.error) fail(mut.error);
if (mut.total === 0) fail("変異が1個も作られなかった（変異チェックが効いていない）→ 人が見る");
if (mut.survivors.length > 0) {
  fail(
    `生き残った変異が ${mut.survivors.length}/${mut.total} 個ある＝テストが検出できない壊し方がある:\n` +
    mut.survivors.map((s) => `    - ${s}`).join("\n") +
    `\n\n  ※ もしこれが「等価変異」（壊しても動きが変わらない＝誰にも殺せない）なら、` +
    `\n    人間が reports/mutation.json を見て判断し、実装に // Stryker disable の印を付ける` +
    `\n    AIには判断させない（「等価だから無視して」と言えばゲートが死ぬため）`
  );
}
console.log(`  → 生き残った変異 0/${mut.total} ✓ テストは実装を縛っている`);

// ---------- ⑧ 保存 ----------
log("3枚とも通過 → 保存（commit + bd close）");
git("add", "-A", "--", ...WORK_DIRS);   // 作業領域だけ（-A だけだとハーネス自身を巻き込む）
git("commit", "-m", `${task.title}\n\nharness: 赤先行→凍結→実装→緑→変異チェック(Stryker) を確認して保存`);
bd("close", task.id, "--reason", "テストの機械ゲート3枚（赤先行＋凍結＋変異チェック/Stryker）を通過");

console.log("\n" + "=".repeat(60));
console.log("結果: 合格（テストが実装を縛っていることまで機械で確認）");
console.log(`  ${git("log", "--oneline", "-1").stdout.trim()}`);
console.log("=".repeat(60));
