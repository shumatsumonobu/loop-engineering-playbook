// harness3.mjs — step2: 依存 ＋ 外側ループ（タスクが無くなるまで回す）
//
// 確かめること:
//   ① 依存 … B は A が close されるまで ready に出ない（＝取れない）
//   ② 外側ループ … ワーカーは「取る→書く→ゲート→完了→次の1枚」をタスクが無くなるまで回す
//   ③ 依存が解けた瞬間 … A が close された後、B が ready になり誰かが取る
//
// 使い方: node harness3.mjs

import { spawn } from "node:child_process";

const WORKERS = [
  { name: "w1", dir: "C:/dev/loop-step0-w1", actor: "worker1" },
  { name: "w2", dir: "C:/dev/loop-step0-w2", actor: "worker2" },
];

const FAIL_LIMIT = 3;
const WORKER_TIMEOUT_MS = 600_000;
const CHECK_TIMEOUT_MS = 120_000;
const POLL_MS = 5_000;        // 取れる仕事が無い時に待つ間隔（依存が解けるかも）
const MAX_IDLE_POLLS = 24;    // 2分ぶん待っても何も出なければ諦める（終了保証）

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const { input, ...o } = opts;
    const p = spawn(cmd, args, { ...o, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    if (input) p.stdin.write(input);
    p.stdin.end();
    p.on("close", (code) => resolve({ code, out, err }));
    p.on("error", (e) => resolve({ code: -1, error: e, out, err }));
  });

const q = (a) => (/[\s"]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));
const bd = (w, ...args) =>
  run(["bd", ...args.map(q)].join(" "), [], {
    shell: true,
    cwd: w.dir,
    env: { ...process.env, BEADS_ACTOR: w.actor },   // 別 identity（排他の必須条件）
  });
const git = (w, ...args) => run("git", args, { cwd: w.dir });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// タスクリストにまだ「終わってない仕事」が残っているか（open も blocked も含む）
async function pending(w) {
  const all = JSON.parse((await bd(w, "list", "--json")).out || "[]");
  return all.filter((t) => t.status !== "closed").length;
}

// ready を1枚 claim（他人に取られてたら次を狙う）
async function claimNext(w, log) {
  const ready = JSON.parse((await bd(w, "ready", "--json")).out || "[]");
  for (const t of ready) {
    const c = await bd(w, "update", t.id, "--claim");
    if (c.code === 0) return t;
    log(`claim 弾かれた（他ワーカーが先）: ${t.id}`);
  }
  return null;
}

// 1枚を仕上げる（緑になるまで・上限つき）、true=緑で保存, false=失敗
async function doTask(w, task, log) {
  let fails = 0, feedback = "";
  while (fails < FAIL_LIMIT) {
    const prompt =
      `あなたはワーカーです。次のタスクだけを実装してください。\n\n## タスク\n${task.title}\n\n` +
      `## 規約\nCLAUDE.md を読むこと。**実装（src/）と、それを検証するテスト（tests/）の両方を書く**。Vitest・ESM。\n` +
      `テストは「そのタスクが本当に出来ているか」を検証する内容にすること。\n\n` +
      `## 重要\n- **あなたは git commit も bd close もしません（権限なし）。**\n` +
      `- 実装したら「終わりました」と報告するだけ。完了判定は親が npm test を実際に走らせて行います。\n` +
      `- 既存テストを消す・skip・弱めるのは禁止。自分のタスク以外は触らない。\n` +
      (feedback ? `\n## 前回の結果（赤）\n${feedback.slice(-1500)}\n直してください。\n` : "");

    log("ワーカー起動（claude -p）…");
    const r = await run("claude", ["-p", "--dangerously-skip-permissions"], {
      cwd: w.dir, input: prompt, timeout: WORKER_TIMEOUT_MS,
    });
    if (r.error?.code === "ENOENT") { log("[エラー] claude を起動できない"); return false; }
    log("「終わった」と申告 ← 信じない");

    // 客観ゲート
    const check = await run("npm", ["test"], {
      cwd: w.dir, shell: process.platform === "win32", timeout: CHECK_TIMEOUT_MS,
    });
    if (check.code === 0) {
      log(`緑 → 保存（commit + bd close）: ${task.id}`);
      await git(w, "add", "-A");
      await git(w, "commit", "-m", `${task.title}\n\nharness: チェック緑を確認して保存（${w.name}）`);
      await bd(w, "close", task.id, "--reason", `ハーネスが緑を確認（${w.name}）`);
      return true;
    }
    fails++;
    feedback = (check.out || "") + (check.err || "");
    log(`赤 → 保存しない・差し戻す (${fails}/${FAIL_LIMIT})`);
  }
  log(`停止（失敗上限）→ claim を解放: ${task.id}`);
  await bd(w, "update", task.id, "-s", "open");
  return false;
}

// 外側ループ: タスクが無くなるまで「取る→やる→次」を回す
async function worker(w) {
  const log = (m) => console.log(`[${w.name}] ${m}`);
  const done = [];
  let idle = 0;

  while (idle < MAX_IDLE_POLLS) {
    const task = await claimNext(w, log);

    if (task) {
      idle = 0;
      log(`claim 成功: ${task.id} — ${task.title}`);
      const ok = await doTask(w, task, log);
      done.push({ id: task.id, ok });
      continue;                       // ← 次の1枚へ（外側ループ）
    }

    // 取れる仕事が無い、まだ終わってない仕事が残ってる？（依存待ち・他ワーカーが作業中）
    const left = await pending(w);
    if (left === 0) { log("タスクが無くなった → 終了"); break; }
    log(`取れる仕事なし（残 ${left} 件・依存待ち or 他が作業中）→ ${POLL_MS / 1000}秒 待つ`);
    idle++;
    await sleep(POLL_MS);
  }

  return { w: w.name, done };
}

console.log("=== step2: 依存 ＋ 外側ループ（タスクが無くなるまで）===\n");
const results = await Promise.all(WORKERS.map(worker));

console.log("\n" + "=".repeat(60));
console.log("=== 結果 ===");
for (const r of results) {
  const s = r.done.map((d) => `${d.id}${d.ok ? "(緑)" : "(失敗)"}`).join(", ") || "なし";
  console.log(`  ${r.w}: ${s}`);
}
console.log("=".repeat(60));
