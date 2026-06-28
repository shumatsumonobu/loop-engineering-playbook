// 自前ループ機構（Ralph loop + 客観ゲート + ガードレール）
// claude -p を1タスクずつ実行し、.claude/loop/BACKLOG.md が空になるまで回す。コミットはこのスクリプトが行う。
// 実行はリポルートから: npm run loop （= node .claude/loop/loop.mjs。パスはリポルート相対なので cwd=リポルート前提）
// 試走: npm run loop:dry （claude を呼ばず・コミットせず挙動だけ確認）
// 合成版: npm run loop -- --compose （Verifier サブエージェント＋verdict.json でゲート）
// 停止: npm run loop:stop（.claude/loop/STOP） / Ctrl+C / kill <PID>

import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync, appendFileSync, readFileSync, statSync, mkdirSync } from "node:fs";

const MAX_ITERATIONS = 15;       // 周回上限。初回試走は 2-3 に下げる
const NO_CHANGE_LIMIT = 3;       // 意味ある変更がこの回数連続ゼロで stuck 停止
const FAIL_LIMIT = 3;            // 赤/不合格がこの回数連続で失敗ブレーカー停止
const TIMEOUT_MS = 600000;       // 1周（claude 1回）のタイムアウト。10分
const TOTAL_LIMIT_MS = 1800000;  // 総量上限（最後の砦）。30分

// パスはすべてリポルート相対（npm run loop で cwd=リポルートになる前提）。
// ハーネスの状態/ログは .claude/loop/ にまとめる（リポ直下 = 開発ソースと分離する方針）。
const LOOP_DIR = ".claude/loop";
const BACKLOG = `${LOOP_DIR}/BACKLOG.md`;     // タスク待ち行列＋進捗
const LOG = `${LOOP_DIR}/loop.log`;           // 実行ログ
const VERDICT = `${LOOP_DIR}/verdict.json`;   // Verifier 判定
const STOP = `${LOOP_DIR}/STOP`;              // 安全停止センチネル

const COMPOSE = process.argv.includes("--compose");
const DRY_RUN = process.env.LOOP_DRY_RUN === "1" || process.argv.includes("--dry");

// 共通プレフィックス（baseline/composition 両方）。「自己検証→改善」と「コミットしない」を必ず含める。
const PROMPT_COMMON =
  `CLAUDE.md の作業手順に従い、${BACKLOG} の「次にやること」から先頭タスクを1つ実装する。` +
  "実装は src/ 配下、テストは tests/ 配下に置く。" +
  "実装したらテストを実行し、緑になるまで自分で直す。" +
  `完了したら ${BACKLOG} を更新する（完了へ移動・調査メモに知見を残す）。` +
  "ただしコミットはしない（CLAUDE.md 手順6 は実行しない。コミットはスクリプトが行う）。";
// composition 固有: verifier を呼び、自己検証→改善を合格まで回し、判定を verdict へ書かせる。
const PROMPT_COMPOSE =
  ` テストが緑になったら verifier サブエージェント（.claude/agents/verifier.md）を呼んで検証させる。` +
  "不合格なら、その理由に従って自分で修正し、テスト→verifier を合格するまで繰り返す。" +
  `最終判定は verifier に ${VERDICT} へ書き出させる。`;
const PROMPT = COMPOSE ? PROMPT_COMMON + PROMPT_COMPOSE : PROMPT_COMMON;

const log = (msg) => {
  console.log(msg);
  appendFileSync(LOG, msg + "\n");
};

// git を同期実行。読み取り用は stdout を trim して返す（失敗時は ""）。
const git = (...args) => spawnSync("git", args, { encoding: "utf8" }).stdout?.trim() ?? "";
// 判定が要る操作（reset/add 等）用。成否(ok)と stderr を返し、失敗を握り潰さない。
const gitRun = (...args) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
};
// HEAD 状態を { ok, exists, hash } で返す。
//   ok=false     … git 自体が失敗（リポ外/git 不在など）→ 安全側に倒す材料にする
//   exists=false … git リポだがまだ1コミットも無い（初コミット前）
const head = () => {
  const r = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
  if (r.status === 0) return { ok: true, exists: true, hash: (r.stdout ?? "").trim() };
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).status === 0;
  return { ok: inRepo, exists: false, hash: "" };
};

// src/ tests/ に未コミット差分があるか（付随物 .claude/loop/ のログ・verdict・STOP は対象外）
const meaningfulChange = () =>
  (spawnSync("git", ["status", "--porcelain", "--", "src", "tests"], { encoding: "utf8" }).stdout ?? "")
    .trim().length > 0;

// vitest を1回実行し緑(exit 0)かを返す。ハング防止に timeout を付ける（DRY_RUN は実行しない）。
// ※ npx/npm は Windows で .cmd のため shell:true が必須。claude(.exe) と違い shell を外せないので、
//   timeout 時の孤児化は許容する（vitest/npm は claude ほど長命でなくすぐ終わる前提）。
const runVitest = () =>
  DRY_RUN
    ? true
    : spawnSync("npx", ["vitest", "run"], {
        stdio: "inherit",
        shell: process.platform === "win32",
        timeout: 120000,
      }).status === 0;

// BACKLOG.md の「次にやること」に "-" 始まりの行が残っているか
const hasRemainingTasks = () => {
  if (!existsSync(BACKLOG)) return false;
  let inSection = false;
  for (const line of readFileSync(BACKLOG, "utf8").split(/\r?\n/)) {
    if (line.includes("次にやること")) { inSection = true; continue; }
    if (inSection) {
      if (line.startsWith("##")) break;
      if (line.trim().startsWith("-") && !line.includes("（なし")) return true;
    }
  }
  return false;
};

// verdict.json を fail-closed で検証（起動時刻より後に書かれた p:true のみ合格）
const readVerdict = (since) => {
  try {
    if (!existsSync(VERDICT)) return { pass: false, reason: "verdict.json 不在（Verifier 未実行）" };
    if (statSync(VERDICT).mtimeMs < since) return { pass: false, reason: "verdict.json が古い（今周回で未更新）" };
    const v = JSON.parse(readFileSync(VERDICT, "utf8"));
    if (typeof v.pass !== "boolean") return { pass: false, reason: "verdict.json スキーマ不正" };
    return v;
  } catch (e) {
    return { pass: false, reason: "verdict.json パース失敗" };
  }
};

// --- 安全装置: 中断シグナル ---
const onSignal = (sig) => { log(`[停止] シグナル ${sig} 受信、停止します`); process.exit(130); };
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

mkdirSync(LOOP_DIR, { recursive: true }); // .claude/loop/ が無いリポにコピーした初回でも write でこけないように
rmSync(STOP, { force: true });

writeFileSync(LOG, "=== 自前ループ機構 ===\n");
appendFileSync(LOG, `開始: ${new Date().toString()}\n`);
appendFileSync(LOG, `PID: ${process.pid} ／ 緊急停止: kill ${process.pid} ／ 安全停止: npm run loop:stop\n`);
appendFileSync(LOG, `モード: ${COMPOSE ? "composition (Verifier)" : "baseline"}${DRY_RUN ? " / DRY_RUN" : ""}\n\n`);

const startTime = Date.now();
let iteration = 0;
let noChange = 0;
let failCount = 0;

while (true) {
  iteration += 1;
  log(`--- 周回 ${iteration} (${COMPOSE ? "composition" : "baseline"}) ---`);

  // 安全停止
  if (existsSync(STOP)) { log("[停止] STOP ファイル検知"); rmSync(STOP, { force: true }); break; }
  // 総量上限（最後の砦）
  if (Date.now() - startTime > TOTAL_LIMIT_MS) { log("[停止] 総量上限（時間）到達"); break; }

  // 完了判定は claude 実行前（残タスク無し→緑＋カバレッジ確認→終了。空 BACKLOG.md で無駄に走らせない）
  if (!hasRemainingTasks()) {
    // 完了時は test:coverage を1回回し、テスト緑＋カバレッジ80%（vitest.config 閾値）を客観確認する
    // （これで baseline/composition どちらでも最終カバレッジが担保される）
    const ok = DRY_RUN
      ? true
      : spawnSync("npm", ["run", "test:coverage"], {
          stdio: "inherit",
          shell: process.platform === "win32",
          timeout: 120000,
        }).status === 0;
    log(ok ? "[完了] 全タスク完了（テスト緑＋カバレッジ80%）" : "[停止] タスクは空だがテスト赤 or カバレッジ80%未満");
    break;
  }

  const before = head();
  if (COMPOSE) rmSync(VERDICT, { force: true }); // 残骸で誤コミットしないよう毎周削除
  const iterStart = Date.now();

  // --- Implementer（メインセッション）を実行。コミットはさせない ---
  let timedOut = false;
  if (DRY_RUN) {
    log("[DRY_RUN] claude 呼び出しをスキップ");
  } else {
    // 自律ループのため広い権限が必要（ヘッドレス非対話では既定権限だと Edit/Bash/Agent/Skill が通らずループが機能しない）。
    // 暴走対策はこのスクリプトのガードレール（STOP/上限/失敗ブレーカー/総量上限）で担保。管理された作業コピーで回す前提。
    // プロンプトは stdin で渡す（引数だと空白/日本語が壊れうるため）。
    // shell は使わない: claude は .exe で PATH 解決できる。shell 経由だと timeout で cmd だけ殺され
    // claude 本体が孤児化（ファイル/ポートを掴んだまま残る）するため。
    // ※ もし claude が .cmd 形式の環境なら起動に shell:true が要るが、その場合は timeout 孤児化に注意。
    const r = spawnSync("claude", ["-p", "--dangerously-skip-permissions"], {
      input: PROMPT,
      stdio: ["pipe", "inherit", "inherit"],
      timeout: TIMEOUT_MS,
      // LOOP_RUN=1 で Stop フック（.claude/loop/stop-hook.mjs）を有効化する。
      // 対話セッションには付かないので、フックはループ実行時だけ「赤なら差し戻し」を強制する。
      env: { ...process.env, LOOP_RUN: "1" },
    });
    // claude が起動できない（PATH に無い／.cmd・.ps1 シム形式）と回しても無駄なので明示して停止
    if (r.error && r.error.code === "ENOENT") {
      log("[エラー] claude を起動できません（PATH に無い／.cmd・.ps1 シム形式の可能性）。`claude` が実行可能か確認してください。");
      break;
    }
    // タイムアウトは ETIMEDOUT（POSIX）か、timeout で殺された signal（Windows 等で SIGTERM）でも判定。
    // ここに来る SIGTERM/SIGKILL は spawnSync 自身の timeout が子(claude)を殺した signal。
    // STOP は周回先頭で処理し、loop プロセス自体への kill は上の SIGINT/SIGTERM ハンドラが exit するので、ここには来ない。
    if ((r.error && r.error.code === "ETIMEDOUT") || r.signal === "SIGTERM" || r.signal === "SIGKILL") {
      timedOut = true;
      log(`[タイムアウト] 周回 ${iteration} が ${TIMEOUT_MS / 1000}秒 超過`);
    }
  }

  // タイムアウト周回は中途半端な状態を判定/コミットせず、失敗扱いで次へ
  if (timedOut) {
    failCount += 1;
    log(`[失敗] タイムアウト → コミットせず (${failCount}/${FAIL_LIMIT})`);
    if (failCount >= FAIL_LIMIT) { log("[停止] 失敗ブレーカー（赤/不合格が連続）"); break; }
    continue;
  }

  // --- 事故検知: エージェントが規約違反でコミットしていたら mixed reset で巻き戻す（インデックスもクリアして再ゲート） ---
  if (!DRY_RUN) {
    const after = head();
    if (!before.ok || !after.ok) {
      // git 状態を取得できない（リポ破損 / git 失敗）。コミット判定に進まず安全停止。
      log("[停止] git 状態を取得できません（リポ破損 or git 失敗）。人間が確認してください。");
      break;
    }
    if (after.hash !== before.hash) {
      if (before.exists) {
        log("[警告] エージェントが自分でコミットした → git reset --mixed で巻き戻して再ゲート");
        const reset = gitRun("reset", "--mixed", before.hash);
        if (!reset.ok) {
          log(`[停止] reset --mixed 失敗（${reset.stderr}）。rogue コミットを巻き戻せないため停止して人間へ。`);
          break;
        }
      } else {
        // 初コミット前にエージェントがコミットした稀ケース。安全に mixed reset できないため停止。
        log("[停止] 初コミット前にエージェントがコミットしました。人間が確認してください。");
        break;
      }
    }
  }

  // --- 判定（客観ゲート） ---
  const changed = meaningfulChange();
  const green = runVitest();
  const verdict = COMPOSE ? readVerdict(iterStart) : { pass: true };

  // --- コミット条件: 意味ある変更 ＆ 緑 ＆ (composition なら) Verifier 合格 ---
  if (changed && green && verdict.pass) {
    if (DRY_RUN) {
      log("[DRY_RUN] コミット条件を満たした（実際にはコミットしない）");
      failCount = 0;
      noChange = 0;
    } else {
      // 指定パスだけをコミット（他に staged 変更があっても巻き込まない）。add で新規ファイルも stage。
      const add = gitRun("add", "src", "tests", BACKLOG);
      if (!add.ok) {
        // add 失敗のまま commit すると新規ファイルを取りこぼすので、この周回はコミットしない。
        failCount += 1;
        log(`[失敗] git add 失敗 (${failCount}/${FAIL_LIMIT}): ${add.stderr}`);
      } else {
        const c = spawnSync("git", ["commit", "-m", `自動ループ: 周回${iteration} の実装`, "--", "src", "tests", BACKLOG], { encoding: "utf8" });
        if (c.status === 0) {
          appendFileSync(LOG, "変更ファイル:\n" + git("show", "--stat", "--format=", "HEAD") + "\n\n");
          log("[コミット] 緑＋意味ある変更＋合格でコミット");
          failCount = 0;
          noChange = 0;
        } else {
          failCount += 1;
          log(`[失敗] git commit 失敗 (${failCount}/${FAIL_LIMIT}): ${(c.stderr || "").trim()}`);
        }
      }
    }
  } else if (!changed) {
    noChange += 1;
    log(`[警告] 意味ある変更なし (${noChange}/${NO_CHANGE_LIMIT})`);
  } else {
    failCount += 1;
    const why = !green ? "テスト赤" : `Verifier 不合格（${verdict.reason}）`;
    log(`[失敗] ${why} → コミットせず (${failCount}/${FAIL_LIMIT})`);
  }

  // --- 停止条件（完了判定は先頭に移動済み） ---
  if (failCount >= FAIL_LIMIT) { log("[停止] 失敗ブレーカー（赤/不合格が連続）"); break; }
  if (noChange >= NO_CHANGE_LIMIT) { log("[停止] stuck（意味ある変更が連続ゼロ）"); break; }
  if (iteration >= MAX_ITERATIONS) { log(`[停止] 周回上限 ${MAX_ITERATIONS} 到達`); break; }
}

const elapsed = Math.floor((Date.now() - startTime) / 1000);
appendFileSync(LOG, "\n=== 結果 ===\n");
appendFileSync(LOG, `周回数: ${iteration}\n`);
appendFileSync(LOG, `総時間: ${elapsed}秒 (${Math.floor(elapsed / 60)}分)\n`);
