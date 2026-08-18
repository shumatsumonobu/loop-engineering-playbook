// harness7.mjs — 3枚の機械ゲート ＋ フィードバック付きリトライ ＋ 人への差し戻し
//
// harness6 で分かったこと:
//   ゲート3（変異チェック）は「テストが通っていて、行カバレッジも100%なのに穴がある」を
//   正確に見つける、実際に本物のワーカーがこう書いた:
//       実装:  if (a === 0 || b === 0) return 0;   ← ゼロ判定
//       テスト: lcm(4,6) lcm(3,5) lcm(6,6) …       ← 0 を1回も渡していない
//   → ゼロ判定を丸ごと消しても全テストが緑のまま = 生き残った変異4個 → REJECT
//
// だが「REJECT して終わり」では、ワーカーは何が悪かったか分からず同じ失敗を繰り返す
//   ハーネスは「どの変異が生き残ったか」を正確に知っている（ツールが出した事実であって
//   AIの意見ではない）→ それを次のワーカーへのフィードバックとして渡す
//
// このハーネスの1サイクル:
//   1..3回:
//     テストだけ書かせる（前回の生き残り変異があれば、それを渡す）
//     → ゲート1 赤先行 → ゲート2 凍結 → 実装 → 凍結の検証 → チェック一式
//     → ゲート3 変異チェック（survived == 0 か）
//         survived > 0 → 巻き戻して 次の回へ（生き残りをフィードバックに積む）
//         survived == 0 → 保存（commit + bd close）して終了
//   3回とも駄目 → 人に差し戻し、無限リトライはしない
//
// 等価変異（誰にも殺せない変異）で詰まった場合もここに落ちる
//   AIに「等価だから無視していい」と判断させない（＝自分の答案を自分で採点に逆戻り）
//   無視の印（// Stryker disable）を付けられるのは人間だけ
//   ループは止まらない（他のワーカーは次のタスクへ）＝放置と両立
//
// 実装の鉄則（2回 事故った）: ハーネスは「ワーカーの作業領域（src / tests）」だけを触る
//   git add / clean / checkout は必ず `-- src tests` で限定
//   （リポジトリ全体にかけて、ハーネス自身・設定・ロックファイルを巻き込んで消した）

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MAX_ATTEMPTS = 3;
const CHECK_TIMEOUT_MS = 120_000;
const MUTATION_TIMEOUT_MS = 900_000;
const WORKER_TIMEOUT_MS = 600_000;
const WORK_DIRS = ["src", "tests"];
const MUTATION_REPORT = "reports/mutation.json";

const log = (m) => console.log(`\n[harness] ${m}`);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const git = (...a) => run("git", a);
const q = (a) => (/[\s"]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));
const bd = (...a) => run(["bd", ...a.map(q)].join(" "), [], { shell: true, encoding: "utf8" });
const sha = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);

const check = () =>
  run("npm", ["test"], { shell: process.platform === "win32", timeout: CHECK_TIMEOUT_MS, stdio: "inherit" }).status;

const callWorker = (prompt) =>
  !(run("claude", ["-p", "--dangerously-skip-permissions"], {
    input: prompt, stdio: ["pipe", "inherit", "inherit"], timeout: WORKER_TIMEOUT_MS,
  }).error?.code === "ENOENT");

const changedInWork = () =>
  (run("git", ["status", "--porcelain", "--", ...WORK_DIRS]).stdout ?? "")
    .split("\n").filter(Boolean).map((l) => l.slice(3).trim());

const resetWork = () => {
  git("checkout", "--", ...WORK_DIRS);
  run("git", ["clean", "-fd", "--", ...WORK_DIRS]);
};

// 変異チェック: Stryker を走らせ、ハーネスが JSON を読んで「生き残った変異」を数える
//   ゲート条件は「変異スコア >= 閾値」ではなく 「survived == 0」
//   （スコアは実装の形で 60〜80% と揺れる、実測で、ゆるいテストがスコア80%でゲートを
//     すり抜けたことがある、survived は揺れない＝「検出できない壊し方が在る」そのもの）
//   生き残りには「実際の壊し方」を付けて返す ← これがワーカーへのフィードバックになる
function mutationCheck(srcFiles) {
  const r = run("npx", ["stryker", "run", "--mutate", srcFiles.join(",")], {
    shell: process.platform === "win32", timeout: MUTATION_TIMEOUT_MS, stdio: "inherit",
  });
  if (r.error || !existsSync(MUTATION_REPORT)) return { error: "Stryker が動かなかった" };

  const report = JSON.parse(readFileSync(MUTATION_REPORT, "utf8"));
  const survivors = [];
  let total = 0;
  for (const [file, data] of Object.entries(report.files ?? {})) {
    const lines = (data.source ?? "").split("\n");
    for (const m of data.mutants ?? []) {
      if (m.status === "Ignored") continue;   // 人が明示的に無視の印を付けたもの（AIは付けられない）
      total++;
      // Survived   = 壊してもテストが赤くならなかった（テストが検出できない）
      // NoCoverage = そもそもテストがその行を通っていない（検出しようがない）
      if (m.status === "Survived" || m.status === "NoCoverage") {
        const ln = m.location?.start?.line ?? 0;
        survivors.push({
          where: `${file}:${ln}`,
          original: (lines[ln - 1] ?? "").trim(),
          replacement: (m.replacement ?? "").trim(),
          mutator: m.mutatorName,
        });
      }
    }
  }
  return { survivors, total };
}

const survivorsToFeedback = (survivors) =>
  survivors.map((s) =>
    `- ${s.where} の \`${s.original}\` を \`${s.replacement}\` に書き換えても、テストは全部 緑のままでした（${s.mutator}）。` +
    `\n  → つまり、この部分の振る舞いを検証しているテストが1つもありません。`
  ).join("\n");

// ---------- タスクリストから1枚 ----------
const task = JSON.parse(bd("ready", "--json").stdout || "[]")[0];
if (!task) { log("タスクリストに ready なタスクが無い"); process.exit(0); }
bd("update", task.id, "--claim");
log(`タスク: ${task.id} — ${task.title}`);

const park = (why) => {
  log(`人に差し戻し: ${why}`);
  resetWork();
  bd("update", task.id, "-s", "open");
  bd("update", task.id, "--add-label", "blocked-for-human");   // bd は --add-label（--labels は無効・黙って無視される、統合版の実走で判明）
  console.log("\n" + "=".repeat(70));
  console.log("結果: 人に差し戻し（1行も保存されていない・人が見るまで放置）");
  console.log("  → ループは止まらない、他のワーカーは次のタスクへ進む");
  console.log("=".repeat(70));
  process.exit(1);
};

let feedback = "";   // 前回の回で生き残った変異（ツールが出した事実、AIの意見ではない）

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log("\n" + "#".repeat(70));
  console.log(`# ${attempt} 回目 / ${MAX_ATTEMPTS}`);
  console.log("#".repeat(70));
  resetWork();

  const retry = (why) => { log(`未 ${attempt}回目 失敗: ${why}`); resetWork(); };

  // ---------- ① テストだけ書かせる ----------
  log("① ワーカーに「テストだけ」書かせる");
  const ok1 = callWorker(
    `あなたはワーカーです。次のタスクの「テストだけ」を書いてください。\n\n## タスク\n${task.title}\n\n` +
    (feedback
      ? `## 前回のテストは不合格でした（機械が検出した事実）\n` +
        `実装をわざと壊してテストを走らせたところ、次の壊し方をテストが検出できませんでした:\n\n` +
        `${feedback}\n\n` +
        `→ **今回は、上で挙がった振る舞いを必ず検証するテストを含めてください。**\n\n`
      : ``) +
    `## 絶対に守ること\n- **テスト（tests/）だけを書く。実装（src/）は絶対に作らない。**\n` +
    `- **戻り値そのものを検証すること**（型だけ見るテストは不合格）。\n` +
    `- **境界値・特殊な入力（0 や 負数 など）も必ず検証すること。**\n` +
    `- まだ実装が無いので、このテストは落ちるのが正しい。\n- CLAUDE.md を読むこと。Vitest・ESM。\n`);
  if (!ok1) park("claude 起動不可");

  const created = changedInWork();
  log(`作られたもの: ${created.join(", ") || "なし"}`);
  if (created.some((f) => f.startsWith("src/"))) { retry("テストだけと言ったのに実装まで作った"); continue; }
  const testFiles = created.filter((f) => f.startsWith("tests/"));
  if (testFiles.length === 0) { retry("テストが書かれていない"); continue; }

  // ---------- ② ゲート1: 赤先行 ----------
  log("② ゲート1｜赤先行: 実装が無い状態でテストを走らせる");
  if (check() === 0) { retry("実装が無いのにテストが通った（何も検証していない）"); continue; }
  console.log("  → 赤、何かを検証している ✓");

  // ---------- ③ ゲート2: 凍結 ----------
  const frozen = Object.fromEntries(testFiles.map((f) => [f, sha(f)]));
  log(`③ ゲート2｜凍結: ${testFiles.join(", ")}`);

  // ---------- ④ 実装させる ----------
  log("④ ワーカーに実装させる（テストは変更禁止）");
  if (!callWorker(
    `あなたはワーカーです。次のタスクの「実装」を書いてください。\n\n## タスク\n${task.title}\n\n` +
    `## 状況\n受け入れテスト（${testFiles.join(", ")}）が既にあり、今は落ちています。これを通す実装を src/ に書いてください。\n\n` +
    `## 絶対に守ること\n- **テストファイルは1文字も変更しない。**\n- テストに合わせて値をハードコードしない。\n` +
    `- **テストが要求していない"念のため"のコードを足さないこと**（検証されない枝は不合格になる）。\n` +
    `- CLAUDE.md を読むこと。\n`)) park("claude 起動不可");

  // ---------- ⑤ 凍結の検証 ----------
  log("⑤ テストが書き換えられていないか");
  const tampered = Object.entries(frozen).find(([f, h]) => sha(f) !== h);
  if (tampered) { retry(`テスト ${tampered[0]} が書き換えられた（弱めて通すズル）`); continue; }
  console.log("  → 凍結されたまま ✓");

  // ---------- ⑥ チェック一式 ----------
  log("⑥ チェック一式（npm test）");
  if (check() !== 0) { retry("実装後もテストが赤"); continue; }
  console.log("  → 緑 ✓");

  // ---------- ⑦ ゲート3: 変異チェック ----------
  const srcFiles = changedInWork().filter((f) => f.startsWith("src/"));
  if (srcFiles.length === 0) { retry("実装（src/）が作られていない"); continue; }
  log(`⑦ ゲート3｜変異チェック（Stryker）: ${srcFiles.join(", ")}`);
  const mut = mutationCheck(srcFiles);
  if (mut.error) park(mut.error);
  if (mut.total === 0) park("変異が1個も作られなかった（変異チェックが効いていない）");

  if (mut.survivors.length > 0) {
    feedback = survivorsToFeedback(mut.survivors);   // 次の回に渡す
    console.log(`\n  生き残った変異 ${mut.survivors.length}/${mut.total} 個:`);
    console.log(feedback.split("\n").map((l) => "    " + l).join("\n"));
    retry("テストが検出できない壊し方がある → 生き残りをフィードバックして書き直させる");
    continue;
  }
  console.log(`  → 生き残った変異 0/${mut.total} ✓ テストは実装を縛っている`);

  // ---------- ⑧ 保存 ----------
  log("3枚とも通過 → 保存（commit + bd close）");
  git("add", "-A", "--", ...WORK_DIRS);   // 作業領域だけ（-A だけだとハーネス自身を巻き込む）
  git("commit", "-m", `${task.title}\n\nharness: 赤先行→凍結→実装→緑→変異チェック(survived 0/${mut.total}) を確認して保存`);
  bd("close", task.id, "--reason", `機械ゲート3枚を通過（${attempt}回目・変異チェック survived 0/${mut.total}）`);

  console.log("\n" + "=".repeat(70));
  console.log(`結果: 合格（${attempt}回目で通過）`);
  console.log(`  ${git("log", "--oneline", "-1").stdout.trim()}`);
  console.log("=".repeat(70));
  process.exit(0);
}

park(`${MAX_ATTEMPTS}回やっても変異チェックを通せなかった（等価変異かもしれない → 人が判断）`);
