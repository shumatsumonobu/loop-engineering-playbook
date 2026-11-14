// harness2.mjs — step1: 並列2つ ＋ claim排他 ＋ worktree隔離 の実証
//
// 確かめること:
//   ① claim 排他 … 2つが同じ仕事を取らない（ワーカーごとに BEADS_ACTOR を分けるのが必須）
//   ② worktree 隔離 … 互いのファイルを踏まない
//   ③ ゲートは各ワーカーに独立に効く … 緑で保存／赤で保存しない
//
// 使い方: node harness2.mjs

import { spawn } from "node:child_process";

const WORKERS = [
  { name: "w1", dir: "C:/dev/loop-step0-w1", actor: "worker1" },
  { name: "w2", dir: "C:/dev/loop-step0-w2", actor: "worker2" },
];

const FAIL_LIMIT = 3;
const WORKER_TIMEOUT_MS = 600_000;   // ワーカー1回 10分
const CHECK_TIMEOUT_MS = 120_000;    // チェック一式 2分（ハングしても必ず殺す）

// 非同期 spawn（並列に走らせるので spawnSync は使えない）
const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const { input, ...spawnOpts } = opts;
    const p = spawn(cmd, args, { ...spawnOpts, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    if (input) { p.stdin.write(input); }
    p.stdin.end();
    p.on("close", (code, signal) => resolve({ code, signal, out, err }));
    p.on("error", (e) => resolve({ code: -1, error: e, out, err }));
  });

// bd は npm の .cmd シム → shell 必須、shell は引数を自動クォートしないので自前で（step0 の学び）
const q = (a) => (/[\s"]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));
const bd = (w, ...args) =>
  run(["bd", ...args.map(q)].join(" "), [], {
    shell: true,
    cwd: w.dir,
    // ここが肝: ワーカーごとに別 identity、同じ identity だと claim が冪等になり排他が効かない
    env: { ...process.env, BEADS_ACTOR: w.actor },
  });

const git = (w, ...args) => run("git", args, { cwd: w.dir });

async function worker(w) {
  const log = (m) => console.log(`[${w.name}] ${m}`);

  // ---------- 1. タスクリストから1枚 claim する（他人に取られてたら次を狙う）----------
  let task = null;
  const ready = JSON.parse((await bd(w, "ready", "--json")).out || "[]");
  log(`タスクリストに ready が ${ready.length} 件`);
  for (const t of ready) {
    const c = await bd(w, "update", t.id, "--claim");
    if (c.code === 0) { task = t; break; }             // claim 成功 = 自分のもの
    log(`claim 弾かれた（他ワーカーが先に取った）: ${t.id} → 次を狙う`);
  }
  if (!task) { log("取れるタスクが無い"); return { w: w.name, result: "no-task" }; }
  log(`claim 成功: ${task.id} — ${task.title}`);

  // ---------- 2. 試行ループ（緑まで・上限つき）----------
  let fails = 0, feedback = "";
  while (fails < FAIL_LIMIT) {
    const prompt =
      `あなたはワーカーです。次のタスクだけを実装してください。\n\n` +
      `## タスク\n${task.title}\n\n` +
      `## 規約\nCLAUDE.md を読むこと。**実装（src/）と、それを検証するテスト（tests/）の両方を書く**。Vitest・ESM。\n` +
      `テストは「そのタスクが本当に出来ているか」を検証する内容にすること（手を抜いたテストを書かない）。\n\n` +
      `## 重要（守ること）\n` +
      `- **あなたは git commit も bd close もしません。権限がありません。**\n` +
      `- 実装したら「終わりました」と報告するだけ。完了判定は親（ハーネス）が npm test を実際に走らせて行います。\n` +
      `- 既存テストを消す・skip する・弱めることは禁止です。\n` +
      `- 自分のタスク以外のファイルは触らないこと。\n` +
      (feedback ? `\n## 前回の結果（赤）\n${feedback.slice(-1500)}\n\nこれを直してください。\n` : "");

    log("ワーカー起動（claude -p）… 実装させる");
    const r = await run("claude", ["-p", "--dangerously-skip-permissions"], {
      cwd: w.dir, input: prompt, timeout: WORKER_TIMEOUT_MS,
    });
    if (r.error?.code === "ENOENT") { log("[エラー] claude を起動できない"); break; }
    log("「終わった」と申告 ← これは信じない");

    // ---------- 3. 客観ゲート: ハーネスが自分でチェックを走らせる（この worktree で）----------
    const check = await run("npm", ["test"], {
      cwd: w.dir,
      shell: process.platform === "win32",   // Windows の npm は .cmd
      timeout: CHECK_TIMEOUT_MS,
    });
    if (check.code === 0) {
      log("緑 → 保存（commit + bd close）");
      await git(w, "add", "-A");
      await git(w, "commit", "-m", `${task.title}\n\nharness: チェック一式が緑であることを確認して保存（${w.name}）`);
      await bd(w, "close", task.id, "--reason", `ハーネスが緑を確認（${w.name}）`);
      return { w: w.name, task: task.id, result: "green" };
    }

    fails++;
    feedback = (check.out || "") + (check.err || "");
    log(`赤 → 保存しない・差し戻す (${fails}/${FAIL_LIMIT})`);
  }

  // ---------- 4. 失敗 → claim を解放して人の対応待ちへ（⑥）----------
  log("停止（失敗上限）→ 保存せず claim を解放");
  await bd(w, "update", task.id, "-s", "open");
  return { w: w.name, task: task.id, result: "failed" };
}

// ---------- 2つを並列で走らせる ----------
console.log("=== step1: ワーカー2つを並列起動（別 worktree・別 identity）===\n");
const results = await Promise.all(WORKERS.map(worker));

console.log("\n" + "=".repeat(60));
console.log("=== 結果 ===");
for (const r of results) console.log(`  ${r.w}: ${r.result}  ${r.task ?? ""}`);
const tasks = results.filter((r) => r.task).map((r) => r.task);
const dup = new Set(tasks).size !== tasks.length;
console.log(dup ? "  NG: 2つが同じタスクを取った（排他 失敗）" : "  OK: 2つは違うタスクを取った（claim 排他 成立）");
console.log("=".repeat(60));
