// integrated-real.mjs — "実リポジトリ×実保守タスク"で 3枚ゲートが通用するかを測る、軽い単発ランナー
//
// なぜ別ファイルか（integrated.mjs との違い）:
//   integrated.mjs は greenfield 前提（新しい独立モジュールを追加）＋並列/worktree/merge（実証済み）
//   だが本物リポジトリの実 issue は「既存コードの修正」、そこで新しい問い＝「ゲート（赤先行→凍結→
//   変異→selfcheck→人への差し戻し）が"実保守"タスクで通用するか」だけに絞る、並列/worktree/merge は載せない
//   3点だけ適応する:
//     ① 変異を"変更した行だけ"にスコープ（git diff → Stryker --mutate file:L-L）
//        ＝whole-file だと 修正と無関係な既存の未カバー箇所が survivor になりゲートが構造的に落ちる
//          （実測: yaml の log.ts 単体で survived 9/未カバー6）、これを避ける
//     ② プロンプトを"既存コード修正"用に（issue を渡し、既存の src/tests を読ませる）
//     ③ worktree を作らず 対象リポジトリ(BASE)で直接 回す（attempt 間は resetWork で src/tests を戻す）
//        ＝submodule×worktree の土台づくりを避ける（BASE には submodule が入っている＝conformance も緑）
//
// 使い方: node integrated-real.mjs        （BASE=下の対象リポジトリ・issue も下で指定）

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------- 設定（対象リポジトリと issue）----------
const BASE = "C:/dev/yaml";
const TASK_TITLE = "eemeli/yaml issue #706: stringify に行末を選べる eol オプションを足す";
const TASK_BODY =
  `GitHub issue #706: stringify() / Document#toString() の出力の行末を選べるようにする。\n` +
  `- ToStringOptions に \`eol\` オプションを追加（値は '\\n'（既定）または '\\r\\n'）。\n` +
  `- 既存の StringifyContext を通して伝播させる。\n` +
  `- 著者が挙げた変更箇所（参考）: src/stringify/stringifyDocument.ts の最後の lines.join('\\n')、` +
  `src/stringify/stringify.ts の property/value 連結、src/stringify/stringifyString.ts の block/folded scalar の行連結。\n` +
  `- 既定は '\\n' のまま（後方互換）。`;

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 2);
const WORK_DIRS = ["src", "tests"];
const MUTATION_REPORT = "reports/mutation.json";
const T = { worker: 900_000, check: 180_000, mutation: 900_000 };
const WIN = process.platform === "win32";
const WORKER_CMD = process.env.WORKER_CMD;   // スタブ用（制御フロー検証時）

// ---------- 非同期 spawn ----------
const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const { input, ...o } = opts;
    const p = spawn(cmd, args, { ...o, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (err += d));
    if (input) p.stdin.write(input);
    p.stdin.end();
    p.on("close", (code) => resolve({ code, out, err }));
    p.on("error", (e) => resolve({ code: -1, error: e, out, err }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n[real] ${m}`);

// ---------- BASE 内で回すヘルパー ----------
const git = (...a) => run("git", a, { cwd: BASE });
const npmTest = () => run("npx", ["vitest", "run"], { cwd: BASE, shell: WIN, timeout: T.check });
const sha = (f) => (existsSync(`${BASE}/${f}`) ? createHash("sha256").update(readFileSync(`${BASE}/${f}`)).digest("hex") : null);

// 全テストファイルのハッシュ（凍結の穴ふさぎ）: phase2 で "phase1 以外の既存テスト" を触っても
//   検出できるように、tests/ 配下の .ts/.js/.mjs を全部ハッシュして前後で突き合わせる
//   （実保守では「実装で壊れた既存テストを弱めて緑にする」cheat が起こりうる＝(b) で判明した穴）
async function allTestHashes() {
  const g = async (...a) => ((await run("git", a, { cwd: BASE })).out || "").split("\n").filter(Boolean);
  const files = [...new Set([...(await g("ls-files", "tests")), ...(await g("ls-files", "--others", "--exclude-standard", "tests"))])]
    .filter((f) => /\.(ts|js|mjs)$/.test(f));
  const h = {};
  for (const f of files) h[f] = sha(f);
  return h;
}

const changedInWork = async () =>
  ((await run("git", ["status", "--porcelain", "--", ...WORK_DIRS], { cwd: BASE })).out || "")
    .split("\n").filter(Boolean).map((l) => l.slice(3).trim());
const resetWork = async () => {
  await run("git", ["checkout", "--", ...WORK_DIRS], { cwd: BASE });
  await run("git", ["clean", "-fd", "--", ...WORK_DIRS], { cwd: BASE });
};

// ---------- claude（コストを積む）----------
async function callWorker(prompt, cost) {
  if (WORKER_CMD) {
    const r = await run(WORKER_CMD, [], { cwd: BASE, input: prompt, shell: true, timeout: T.worker });
    cost.calls++;
    return { ok: r.code === 0 };
  }
  const r = await run("claude", ["-p", "--output-format", "json", "--dangerously-skip-permissions"], {
    cwd: BASE, input: prompt, timeout: T.worker,
  });
  if (r.error?.code === "ENOENT") return { ok: false };
  cost.calls++;
  try {
    const j = JSON.parse(r.out);
    cost.usd += j.total_cost_usd || 0;
    cost.out += j.usage?.output_tokens || 0;
    cost.ms += j.duration_ms || 0;
    return { ok: !j.is_error };
  } catch {
    return { ok: true };
  }
}

// ---------- ① 変更した行だけを Stryker に渡す（whole-file survivor を避ける）----------
async function changedSrcRanges() {
  const out = (await run("git", ["diff", "-U0", "--", "src"], { cwd: BASE })).out || "";
  const ranges = {};
  let file = null;
  for (const line of out.split("\n")) {
    const mf = line.match(/^\+\+\+ b\/(.+)$/);
    if (mf) { file = mf[1]; (ranges[file] ??= []); continue; }
    const mh = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (mh && file) {
      const start = Number(mh[1]);
      const count = mh[2] === undefined ? 1 : Number(mh[2]);
      if (count > 0) ranges[file].push([start, start + count - 1]);
    }
  }
  return ranges;   // { "src/..ts": [[s,e],...] }
}
const rangesToMutateArg = (ranges) =>
  Object.entries(ranges).flatMap(([f, rs]) => rs.map(([s, e]) => `${f}:${s}-${e}`)).join(",");

// ---------- selfcheck（async・変異ゲートの検算）----------
function toOffset(src, line, col) {
  const ls = src.split("\n");
  let o = 0;
  for (let i = 0; i < line - 1; i++) o += ls[i].length + 1;
  return o + (col - 1);
}
function applyMutant(src, m) {
  const s = toOffset(src, m.location.start.line, m.location.start.column);
  const e = toOffset(src, m.location.end.line, m.location.end.column);
  return src.slice(0, s) + (m.replacement ?? "") + src.slice(e);
}
async function selfCheck(survivors, capPerFile = 3) {
  const byFile = {};
  for (const s of survivors) (byFile[s.file] ??= []).push(s.mutant);
  for (const [f, muts] of Object.entries(byFile)) {
    const path = `${BASE}/${f}`;
    if (!existsSync(path)) continue;
    const orig = readFileSync(path, "utf8");
    for (const m of muts.slice(0, capPerFile)) {
      writeFileSync(path, applyMutant(orig, m));
      const red = (await npmTest()).code !== 0;
      writeFileSync(path, orig);
      if (red) return { trustworthy: false, artifact: { file: f, line: m.location?.start?.line, mutator: m.mutatorName } };
    }
  }
  return { trustworthy: true };
}

// ---------- 変異チェック（変更行スコープ）----------
async function mutationCheck() {
  const ranges = await changedSrcRanges();
  const mutateArg = rangesToMutateArg(ranges);
  if (!mutateArg) return { error: "変更された src の行が無い（実装が src に入っていない？）" };
  log(`変異チェック（変更行だけ）: ${mutateArg}`);
  await run("npx", ["stryker", "run", "--mutate", mutateArg], { cwd: BASE, shell: WIN, timeout: T.mutation });
  const reportPath = `${BASE}/${MUTATION_REPORT}`;
  if (!existsSync(reportPath)) return { error: "Stryker が動かなかった（レポート無し）" };
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const survivors = [];
  let total = 0;
  for (const [file, data] of Object.entries(report.files ?? {})) {
    const lines = (data.source ?? "").split("\n");
    for (const m of data.mutants ?? []) {
      if (m.status === "Ignored") continue;
      total++;
      if (m.status === "Survived" || m.status === "NoCoverage") {
        survivors.push({ file, mutant: m, original: (lines[(m.location?.start?.line ?? 1) - 1] ?? "").trim() });
      }
    }
  }
  return { survivors, total };
}
const survivorsToFeedback = (survivors) =>
  survivors.map((s) => {
    const ln = s.mutant.location?.start?.line ?? 0;
    return `- ${s.file}:${ln} の \`${s.original}\` を \`${(s.mutant.replacement ?? "").trim()}\` に変えても、テストは全部 緑のままでした（${s.mutant.mutatorName}）。` +
      `\n  → あなたが今回 変更/追加した振る舞いを検証するテストが足りません。`;
  }).join("\n");

// ---------- 1タスクを通す（②maintenance プロンプト）----------
async function doTask(cost) {
  let feedback = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`${attempt}/${MAX_ATTEMPTS} 回目`);
    await resetWork();
    const retry = async (why) => { log(`  未 ${why}`); await resetWork(); };

    // ① テストだけ書かせる（既存の tests/ に倣う）
    const p1 =
      `あなたはワーカーです。次の GitHub issue を実装します。\n**まず「テストだけ」を書いてください**（実装 src/ はまだ触らない）。\n\n` +
      `## タスク\n${TASK_TITLE}\n\n${TASK_BODY}\n\n` +
      (feedback ? `## 前回の不足（機械が検出した事実）\n${feedback}\n→ 今回は上を必ず検証するテストにする。\n\n` : ``) +
      `## 守ること\n- **tests/ にテストを足す**（既存のテスト構成・書き方に倣う。まず既存の tests/ と src/ を読むこと）。**src/ は今は触らない。**\n` +
      `- 新しい振る舞い（eol オプションで出力の行末が変わる）を検証。**既定 '\\n' と '\\r\\n' の両方**を検証すること。\n` +
      `- まだ未実装なので、このテストは落ちるのが正しい。Vitest。\n`;
    if (!(await callWorker(p1, cost)).ok) return park(`claude 起動不可`);

    const created = await changedInWork();
    if (created.some((f) => f.startsWith("src/"))) { await retry("テストだけと言ったのに src を触った"); continue; }
    const testFiles = created.filter((f) => f.startsWith("tests/"));
    if (testFiles.length === 0) { await retry("テストが追加/変更されていない"); continue; }
    log(`  追加/変更テスト: ${testFiles.join(", ")}`);

    // ② 赤先行（既存の全テスト＋新テスト → 新テストが赤で 非0 になるはず）
    if ((await npmTest()).code === 0) { await retry("実装が無いのにテストが通った（新しい振る舞いを検証できていない）"); continue; }
    console.log("  → 赤（新しい振る舞いを掴んでいる）✓");

    // ③ 凍結（phase1 の追加分だけでなく tests/ 全体を凍結＝穴ふさぎ）
    const frozen = await allTestHashes();

    // ④ 実装させる（既存コードを修正）
    const p2 =
      `あなたはワーカーです。次の GitHub issue の**実装**を書きます。\n受け入れテスト（${testFiles.join(", ")}）が既にあり、今は落ちています。これを通す実装を **src/ の既存コードを修正**して書いてください。\n\n` +
      `## タスク\n${TASK_TITLE}\n\n${TASK_BODY}\n\n` +
      `## 守ること\n- **テストファイルは1文字も変更しない。**\n- **既存の振る舞いを壊さない**（他のテストも全部 緑のまま）。\n` +
      `- リポジトリの既存の書き方・型（StringifyContext / ToStringOptions）に合わせる。まず該当箇所を読むこと。\n- テストに合わせた その場しのぎのハードコードをしない。\n`;
    if (!(await callWorker(p2, cost)).ok) return park(`claude 起動不可`);

    // ⑤ 凍結の検証（tests/ 全体：phase2 で どのテストも 触っていないか）
    const after = await allTestHashes();
    const tamperedTests = [...new Set([...Object.keys(frozen), ...Object.keys(after)])].filter((f) => frozen[f] !== after[f]);
    if (tamperedTests.length) { await retry(`phase2 でテストを改変/追加した（禁止）: ${tamperedTests.join(", ")}`); continue; }

    // ⑥ 緑（既存＋新テスト 全部）
    if ((await npmTest()).code !== 0) { await retry("実装後もテストが赤（既存を壊した or 未達）"); continue; }
    console.log("  → 全テスト緑 ✓");

    // ⑦ 変異チェック（変更行スコープ）
    const srcFiles = (await changedInWork()).filter((f) => f.startsWith("src/"));
    if (srcFiles.length === 0) { await retry("src の実装が無い"); continue; }
    const mut = await mutationCheck();
    if (mut.error) return park(mut.error);
    if (mut.total === 0) return park("変異が0個（変更行が mutate されていない）");

    if (mut.survivors.length > 0) {
      const scv = await selfCheck(mut.survivors);
      if (!scv.trustworthy) return park(`Stryker がこのファイルで壊れている（${scv.artifact.file}:${scv.artifact.line}）— 人が確認`);
      feedback = survivorsToFeedback(mut.survivors);
      log(`  生き残り ${mut.survivors.length}/${mut.total}（変更行のみ）→ 書き直させる`);
      for (const s of mut.survivors)
        console.log(`    生存: ${s.file}:${s.mutant.location?.start?.line} ${s.mutant.mutatorName}  \`${s.original}\``);
      await resetWork();
      continue;
    }

    // ⑧ 合格（merge はしない＝単発検証、diff を残して人が読む）
    log(`  ✓ 合格（${attempt}回目・変更行の survived 0/${mut.total}）`);
    const diff = (await run("git", ["diff", "--stat", "--", ...WORK_DIRS], { cwd: BASE })).out || "";
    return { ok: true, attempt, total: mut.total, diffstat: diff.trim() };
  }
  return roundOrPark();
}

// ---------- 人への差し戻し / 投げ直し ----------
let round = 0;
async function roundOrPark() {
  round++;
  if (round < MAX_ROUNDS) {
    log(`${MAX_ATTEMPTS}回 未通過 → まっさら投げ直し（round ${round + 1}/${MAX_ROUNDS}）`);
    return { retry: true };
  }
  return park(`${MAX_ROUNDS}ラウンド×${MAX_ATTEMPTS}回 通せず（人が判断）`);
}
async function park(why) {
  log(`人に差し戻し: ${why}`);
  await resetWork();
  return { ok: false, parked: true, why };
}

// ================= 実行 =================
console.log(`=== 実リポジトリ×実保守タスクのゲート検証（単発）===`);
console.log(`対象: ${BASE}`);
console.log(`タスク: ${TASK_TITLE}\n`);

// 前提: BASE が緑か（submodule 込み）
log("前提チェック: BASE の全テストが緑か");
if ((await npmTest()).code !== 0) {
  console.log("[停止] BASE が緑でない、submodule init 済みか確認（git submodule update --init）");
  process.exit(1);
}
console.log("  → 緑 ✓");

const cost = { calls: 0, usd: 0, out: 0, ms: 0 };
const t0 = Date.now();
let result;
do { result = await doTask(cost); } while (result.retry);   // 投げ直し
const wall = ((Date.now() - t0) / 1000).toFixed(1);

console.log("\n" + "=".repeat(64));
console.log("=== 結果 ===");
console.log(`  ${result.ok ? `合格（${result.attempt}回目・survived 0/${result.total}）` : result.parked ? `人に差し戻し: ${result.why}` : "失敗"}`);
if (result.diffstat) console.log(`  変更:\n${result.diffstat.split("\n").map((l) => "    " + l).join("\n")}`);
console.log(`\n=== コスト（claude 分・実測）===`);
console.log(`  ${cost.calls}回呼び出し / $${cost.usd.toFixed(4)} / 出力${cost.out}tok / claude内部${(cost.ms / 1000).toFixed(1)}s`);
console.log(`  実時間（wall）: ${wall}s`);
console.log("=".repeat(64));
console.log(`\n※ 合格なら BASE の作業ツリーに worker の変更が残っている（人が読む用）、次に回す前に \`git checkout -- src tests && git clean -fd -- src tests\` で戻す`);
