// harness.mjs — step0: 客観ゲートの実証
//
// 確かめること: 「ワーカーは申告するだけ／ハーネスが実際にテストを走らせ、緑でしか保存しない」
//
// 使い方:
//   node harness.mjs               本番（claude -p でワーカーを起動）
//   FAKE_WORKER=lie node harness.mjs   嘘つきワーカーを模擬（何もせず「終わった」と申告）
//
// 設計（DESIGN §5「ハーネスの1サイクル」）:
//   タスクリストから取る → claim → ワーカーが実装（commit/close の権限なし）→ 申告
//   → ハーネスが自分でチェック一式を走らせる
//   → 緑なら commit + bd close ／ 赤なら差し戻し（上限で停止・claim 解放・人の対応待ち）

import { spawnSync } from "node:child_process";

const FAKE = process.env.FAKE_WORKER || "";     // "lie" = 何もしないワーカー（嘘つき）
const FAIL_LIMIT = 3;                            // 連続失敗の上限（早く諦める）
const WORKER_TIMEOUT_MS = 600_000;               // ワーカー1回: 10分
const CHECK_TIMEOUT_MS = 120_000;                // チェック一式: 2分（ハングしても必ず殺す）
const TOTAL_BUDGET_MS = 900_000;                 // タスク全体: 15分（終了保証の本体）

const started = Date.now();
const log = (m) => console.log(`\n[harness] ${m}`);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const git = (...args) => run("git", args);   // git は .exe なので shell 不要
const head = () => git("rev-parse", "HEAD").stdout?.trim() ?? "";

// bd は npm グローバルの .cmd シム → Windows では shell 経由が必須（shell 無しだと ENOENT）
// ただし shell:true は引数を自動クォートしないので、空白・日本語を含む引数は自前でクォート
const q = (a) => (/[\s"]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));
const bd = (...args) =>
  spawnSync(["bd", ...args.map(q)].join(" "), [], { encoding: "utf8", shell: true });

// ---------- 1. タスクリストから ready なタスクを1枚取る ----------
let task = null;
try {
  const arr = JSON.parse(bd("ready", "--json").stdout ?? "[]");
  task = Array.isArray(arr) ? arr[0] : null;
} catch { /* パース失敗は task=null 扱い */ }

if (!task) { log("タスクリストに ready なタスクが無い、終了"); process.exit(0); }
const { id, title } = task;
log(`タスク: ${id} — ${title}`);

// ---------- 2. claim（原子的に確保）----------
bd("update", id, "--claim");
log(`claim した: ${id}`);

// ---------- 3. 試行ループ（緑になるまで・上限つき）----------
const prompt = (feedback) =>
  `あなたはワーカーです。次のタスクだけを実装してください。\n\n` +
  `## タスク\n${title}\n\n` +
  `## 規約\nCLAUDE.md を読むこと。実装は src/、テストは tests/。Vitest。ESM。\n\n` +
  `## 重要（守ること）\n` +
  `- **あなたは git commit も bd close もしません。権限がありません。**\n` +
  `- 実装したら、それで終わりです。「終わりました」と報告するだけ。\n` +
  `- 完了判定は親（ハーネス）が npm test を実際に走らせて行います。\n` +
  `- 既存テストを消す・skip する・弱めることは禁止です。\n` +
  (feedback ? `\n## 前回の結果（赤）\n${feedback.slice(-2000)}\n\nこれを直してください。\n` : "");

let failCount = 0;
let feedback = "";
let result = "unknown";

while (failCount < FAIL_LIMIT) {
  // 終了保証: 総時間の上限（ワーカーがダラダラ働き続けても必ず止まる）
  if (Date.now() - started > TOTAL_BUDGET_MS) {
    log(`[停止] 総時間の上限（${TOTAL_BUDGET_MS / 1000}秒）を超過`);
    result = "timeout";
    break;
  }

  const before = head();

  // --- ワーカーを起動（実装だけさせる）---
  if (FAKE === "lie") {
    log('[嘘つきワーカー] 何もせず「終わりました」と申告');
  } else {
    log("ワーカー起動（claude -p）… 実装させる");
    const r = run("claude", ["-p", "--dangerously-skip-permissions"], {
      input: prompt(feedback),
      stdio: ["pipe", "inherit", "inherit"],
      timeout: WORKER_TIMEOUT_MS,
      // shell は使わない（timeout 時に claude 本体が孤児化するため）
    });
    if (r.error?.code === "ENOENT") {
      log("[エラー] claude を起動できない（PATH を確認）");
      result = "error";
      break;
    }
    if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM" || r.signal === "SIGKILL") {
      failCount++;
      log(`[失敗] ワーカーがタイムアウト (${failCount}/${FAIL_LIMIT})`);
      continue;
    }
  }
  log("ワーカーが「終わった」と申告した ← これは信じない");

  // --- 事故検知: ワーカーが勝手に commit していたら巻き戻す（権限が無いので）---
  const after = head();
  if (before && after && before !== after) {
    log("[違反] ワーカーが勝手に commit した → git reset --mixed で巻き戻す");
    git("reset", "--mixed", before);
  }

  // ---------- 客観ゲート: ハーネスが自分でチェック一式を走らせる ----------
  log(" チェック一式を実行する（npm test）… 申告ではなく実際に走らせる");
  const check = run("npm", ["test"], {
    shell: process.platform === "win32",   // Windows の npm は .cmd なので shell 必須
    timeout: CHECK_TIMEOUT_MS,             // ハングしても必ず殺す（ゲートで固まらない）
  });
  const out = (check.stdout ?? "") + (check.stderr ?? "");
  console.log(out.split("\n").slice(-12).join("\n"));   // 末尾だけ表示
  const green = check.status === 0;

  if (green) {
    log(" 緑 → 保存（commit + bd close）");
    git("add", "-A");
    git("commit", "-m", `${title}\n\nharness: チェック一式が緑であることを確認して保存`);
    bd("close", id, "--reason", "ハーネスがテスト緑を確認");
    result = "green";
    break;
  }

  failCount++;
  feedback = out;
  log(` 赤 → 保存しない、ワーカーに差し戻す (${failCount}/${FAIL_LIMIT})`);
}

// ---------- 4. 結末 ----------
console.log("\n" + "=".repeat(60));
if (result === "green") {
  log("成功: 緑を確認して保存・close 済み");
  console.log(`  最新コミット: ${git("log", "--oneline", "-1").stdout?.trim()}`);
} else {
  const why = result === "timeout" ? "時間上限" : result === "error" ? "起動エラー" : "失敗上限";
  log(`停止（${why}）: 赤のコードは1行も保存していない`);
  // ⑥ 後始末: claim を解放して人の対応待ちに戻す（置き去りの in_progress を残さない）
  bd("update", id, "-s", "open");
  log(`claim を解放した（${id} → 人の対応待ち）`);
  process.exitCode = 1;
}
console.log("=".repeat(60));
