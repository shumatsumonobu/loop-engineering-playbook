// integrated.mjs — ループ本体、タスクを取って3つのゲートに通し、合格したものだけをコミットする
//
// 全体の流れ ── ワーカー（claude のプロセス）を並列に回し、タスクが無くなるまで続ける
//   1. タスクを1件 担当する
//   2. テストだけ書かせる → ゲート1 赤先行（実装が無いのに通ったら不合格）
//   3. tests/ 全部の内容を記録する（ゲート2 凍結）
//   4. 実装を書かせる → テストが書き換えられていないか・全テストが通るか
//   5. ゲート3 変異チェック（実装を壊してテストが気づくか・生き残り0 で合格）
//   6. 合格なら commit してタスクを完了、落ち続けたら人に差し戻し
//   7. 全ワーカーが終わったら、枝を1本ずつ元のブランチへ統合して 全テストが通れば採用
//
// ワーカーは信用しない ── 呼び出しの前後で調べて元へ戻す
//   勝手なコミットを取り消す／勝手に閉じたタスクを開け直す／作業領域の外の変更を戻す／
//   変異チェックを黙らせる印を検出して不合格にする（迂回6通りを実際に確かめてから塞いだ）
//
// 補助が2つ
//   自己チェック    変異ツール自体が壊れて誤判定することがあるので、生き残りを素のテストで検算する
//                   壊れていると分かったら 不合格にせず人に差し戻す（人が設定を直す）
//   コストの計測    claude を --output-format json で呼び、料金・出力トークン・所要時間を積む
//
// 実装の鉄則: git の add / clean / checkout は必ず `-- <成果物の置き場所> tests` で対象を限定する
//   `-A` だけだと このハーネス自身・設定・ロックファイルまで巻き込み、巻き戻しで消える（実際に2回 壊した）
//
// 使い方:
//   BASE=/path/to/my-repo node harness/integrated.mjs      ワーカー1つ
//   BASE=/path/to/my-repo node harness/integrated.mjs 2    並列2つ（最大4）
//
// 前提: BASE は 全テストが通る・ESM・Stryker とテストランナーと beads が設定済みのリポジトリ
//   条件を満たしたリポジトリは proof/new-sandbox.mjs で1コマンドで作れる（検証用）

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ---------- 設定 ----------
// 相対パスのまま子プロセスに渡すと、起動シェルの表記がそのまま伝わる
//   Windows でドライブレターが小文字（c:\...）だと Vitest がモジュールを二重に解決して
//   テストの収集が全滅する（症状: Vitest failed to find the current suite）
//   → 絶対パスに直し、ドライブレターは大文字に揃える
const norm = (p) => {
  const a = resolve(p);
  return /^[a-z]:/.test(a) ? a[0].toUpperCase() + a.slice(1) : a;
};
const BASE = norm(process.env.BASE || "../sandbox");   // 回す対象のリポジトリ（例 BASE=/path/to/your/repo）
// 対象が git リポジトリでなければ ここで止める
//   先へ進むと作業コピーの作成が中途半端に失敗して、本当の原因が見えなくなる
if (!existsSync(`${BASE}/.git`)) {
  console.error(`対象が git リポジトリではないため終了`);
  console.error(`  指定されたパス: BASE=${process.env.BASE ?? "(未設定・既定は ../sandbox)"}`);
  console.error(`  解決後のパス  : ${BASE}`);
  console.error(`  このパスに .git がありません。BASE に git リポジトリのパスを指定してください`);
  process.exit(1);
}
// ワーカーに教えるテストの書き方は 対象プロジェクトの test スクリプトから取る（テストランナーを決め打ちしない）
const TEST_CMD = (() => {
  try { return JSON.parse(readFileSync(`${BASE}/package.json`, "utf8")).scripts?.test || "npm test"; } catch { return "npm test"; }
})();
const N = Math.max(1, Math.min(4, Number(process.argv[2] || 1)));   // ワーカー本数
const WORKERS = Array.from({ length: N }, (_, i) => ({
  name: `w${i + 1}`, dir: `${BASE}-w${i + 1}`, branch: `w${i + 1}`, actor: `worker${i + 1}`,
}));

// タスクが無ければ、このデモタスクを BASE に登録（独立＝並列が効く）
const SEED_TASKS = [
  "src/gcd.js に2つの正の整数の最大公約数を返す関数 gcd(a, b) を実装し、tests/gcd.test.js で検証する（境界値・同値・互いに素を含む）",
  "src/isPrime.js に整数が素数かを返す関数 isPrime(n) を実装し、tests/isPrime.test.js で検証する（0・1・2・負数・合成数を含む）",
];

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);   // 1タスクを書き直させる上限
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 2);       // 上限に達した後、最初から投げ直す回数（AI の出力は毎回ちがうので救済する）

// 成果物の置き場所と変異チェックの方式は環境変数で差し替えられる
//   コード以外の成果物（記事など）に使う時は、この2つだけ変えれば回る
const WORK_ROOT = process.env.WORK_ROOT || "src";
const MUTATOR = process.env.MUTATOR;   // 指定時: そのファイルが返す関数を変異チェックとして使う
const WORK_DIRS = [WORK_ROOT, "tests"];   // ワーカーが書き換えてよい場所＝巻き戻しの対象

// 不合格になった時の中身（テストの出力・その時の成果物）を残す場所
//   作業領域は書き直しのたびに元へ戻すので、残さないと後から原因を調べられない
//   対象リポジトリの外（作業コピーと同じく隣）に置く＝対象リポジトリを汚さない
//   走ごとにフォルダを分ける（連番は走ごとに1から振り直すので、同じ場所だと前の走の記録を上書きする）
const RUN_ID = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const LOG_DIR = `${process.env.LOG_DIR || `${BASE}-log`}/run-${RUN_ID}`;
const MUTATION_REPORT = "reports/mutation.json";   // Stryker が結果を書き出す先（対象リポジトリからの相対）

// 打ち切りの時間（ミリ秒）── 超えたら失敗として扱う
//   check の120秒は「テスト一式が2分以内に終わること」という導入先の要件そのもの
const T = { worker: 600_000, check: 120_000, mutation: 900_000, install: 300_000 };
// 取れるタスクが無い時、5秒おきに最大24回 待つ（＝2分待って何も来なければ終了）
const POLL_MS = 5_000, MAX_IDLE_POLLS = 24;
const WIN = process.platform === "win32";   // npm と npx は Windows では shell 経由でないと起動しない（bd は常に shell 経由）
const WORKER_CMD = process.env.WORKER_CMD;   // 設定時は claude の代わりにこれを呼ぶ（検証用のスタブ）

// ---------- 子プロセスの起動 ----------
// 待ち合わせない形（spawn）で書く ── spawnSync だと処理が止まって並列にならない
/**
 * 子プロセスを1つ起動し、終わるまで待って 終了コードと出力を返す
 *
 * 例外を投げない ── 起動に失敗しても `code: -1` で返るので、呼ぶ側は必ず `code` で判定する
 * （規約「成否は exit code で判定」・パイプ越しの `$?` は当てにならない）
 *
 * @param {string} cmd 実行するコマンド（`shell: true` の時はコマンド文字列そのもの）
 * @param {string[]} args 引数（`shell: true` の時は空配列にして cmd 側へ書く）
 * @param {{cwd?: string, shell?: boolean, timeout?: number, input?: string, env?: object}} [opts]
 *   input を渡すと標準入力へ流して閉じる（ワーカーへプロンプトを渡す時に使う）
 * @returns {Promise<{code: number, out: string, err: string, error?: Error}>}
 *   code は終了コード、起動できなかった場合だけ -1 と error が入る
 */
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

const q = (a) => (/[\s"]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));
const tail = (s, n = 20) => String(s || "").trim().split("\n").slice(-n).join("\n");   // 判定に使った出力の末尾（原因が出る所）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ワーカーごとの短縮（現在地はそのワーカーの作業コピー）----------
const bd = (w, ...a) =>
  run(["bd", ...a.map(q)].join(" "), [], { shell: true, cwd: w.dir, env: { ...process.env, BEADS_ACTOR: w.actor } });
const git = (w, ...a) => run("git", a, { cwd: w.dir });
const npmTest = (w) => run("npm", ["test"], { cwd: w.dir, shell: WIN, timeout: T.check });
const sha = (w, f) => (existsSync(`${w.dir}/${f}`) ? createHash("sha256").update(readFileSync(`${w.dir}/${f}`)).digest("hex") : null);

// 元のブランチ（BASE）で直接 実行する ── 統合の段階だけで使う
const gitBase = (...a) => run("git", a, { cwd: BASE });
const npmTestBase = () => run("npm", ["test"], { cwd: BASE, shell: WIN, timeout: T.check });

// tests/ の全ファイル（追跡済み＋未追跡）、凍結の対象＝この走で触った物だけでなく全部
const allTests = async (w) =>
  ((await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "tests"], { cwd: w.dir })).out || "")
    .split("\n").filter(Boolean);

const changedInWork = async (w) =>
  ((await run("git", ["status", "--porcelain", "--", ...WORK_DIRS], { cwd: w.dir })).out || "")
    .split("\n").filter(Boolean).map((l) => l.slice(3).trim());
const resetWork = async (w) => {
  await run("git", ["checkout", "--", ...WORK_DIRS], { cwd: w.dir });
  await run("git", ["clean", "-fd", "--", ...WORK_DIRS], { cwd: w.dir });
};

// ---------- ワーカーが触ったタスクを元へ戻す ----------
// タスクを決めるのも完了にするのも人とハーネスの仕事、ワーカーではない
//
// 何が起きるか
//   タスクを増やす  beads が導入先の CLAUDE.md に「作業の終わりに残りを issue に登録しろ」と
//                   書き込むので、ワーカーがそれに従うことがある（稀だが起きる）
//                   放置すると 終了判定（未完了のタスクが0か）が満たされず、待機の上限まで空回りする
//   タスクを閉じる  自分のタスクを `bd close` すると、不合格でも
//                   `bd list --label blocked-for-human` に出てこない＝人が失敗に気づけない（落とし穴29）
//   どちらも bd は誰からでも受け付けるので、権限では止まらない
//
// どうするか ── 呼び出しの前後でタスク一覧を比べ、増えていたら閉じる／消えていたら開け直す
//   閉じるのは そのワーカーが作ったタスクだけ（`created_by` が自分の actor）
//   ワーカーには BEADS_ACTOR を渡してあるので、人が回している最中に足したタスクとは区別できる
//   （BEADS_ACTOR=worker1 で作ると created_by=worker1、素で作ると git の名前になる）
const taskStates = async (w) =>
  new Map(JSON.parse((await bd(w, "list", "--json")).out || "[]").map((t) => [t.id, t]));
//
// 注意: 開け直すのは このワーカーが担当中のタスクだけ
//   タスクリストは全ワーカーで共有なので、「open だったタスクが消えた」の中には
//   並列で動く別のワーカーが正しく完了させたものが混ざる
//   区別せずに開け直したら、互いの完了を取り消し合って同じタスクを延々とやり直した（落とし穴31）
//   ＝共有している状態の変化を、目の前のワーカーのせいと決めつけない
/**
 * ワーカーが増やしたタスクを閉じ、勝手に閉じたタスクを開け直す
 *
 * @param {{dir: string, actor: string}} w 呼び出したワーカー
 * @param {Map<string, object>} before 呼び出す前のタスク一覧（taskStates の戻り値）
 * @param {(msg: string) => void} log 画面へ出す
 * @param {string} [taskId] このワーカーが今 担当しているタスク（開け直す対象はこれだけ）
 */
async function restoreTasksChangedBy(w, before, log, taskId) {
  const now = await taskStates(w);
  for (const [id, t] of now)
    if (!before.has(id) && t.created_by === w.actor) {
      await bd(w, "close", id, "--reason", "ワーカーが作ったタスク（タスクを決めるのは人）");
      log(`  ワーカーがタスクを作ったので閉じた: ${id}`);
    }
  if (taskId && before.get(taskId)?.status !== "closed" && !now.has(taskId)) {
    await bd(w, "update", taskId, "-s", "open");
    log(`  ワーカーが担当中のタスクを閉じたので開け直した: ${taskId}（完了にするのはハーネス）`);
  }
}

// ---------- ワーカーが勝手にしたコミットを取り消す ----------
// commit するのはハーネスだけ ── ゲートを通ったものだけが履歴に残る
//   ワーカーは作業コピーの中で git を叩けるので、権限では止まらない
//
// 放置するとゲートを1つも通らずに保存される（落とし穴25）
//   ハーネスは git status で成果物を見るため、コミット済みの変更は「何も書いていない」に見える
//   さらにそのコミットは枝に残るので、統合の段階で「全テストが通れば採用」だけを通ってしまう
//
// どうするか ── コミットだけ取り消して中身は作業領域へ戻す（消さない）、判定はゲートにさせる
const headOf = async (w) => ((await git(w, "rev-parse", "HEAD")).out || "").trim();
/**
 * ワーカーが勝手にしたコミットを取り消す（中身は作業領域に残す）
 *
 * @param {{dir: string}} w 呼び出したワーカー
 * @param {string} before 呼び出す前の HEAD（headOf の戻り値）
 * @param {(msg: string) => void} log 画面へ出す
 * @returns {Promise<boolean>} 取り消したら true
 */
async function undoWorkerCommits(w, before, log) {
  const now = await headOf(w);
  if (!now || !before || now === before) return false;
  await git(w, "reset", "--mixed", before);
  log(`  ワーカーが勝手にコミットしたので取り消した（commit するのはハーネス・中身は残してゲートで判定）`);
  return true;
}

// ---------- 作業領域の外への変更を戻す ----------
// ワーカーが書き換えてよいのは 成果物の置き場所と tests/ だけ
//   その外にあるのは判定の材料（設定・依存・テストコマンド）＝採点される側に触らせない
//
// 放置すると判定そのものを緩められる（落とし穴28）
//   巻き戻し（resetWork）は作業領域しか戻さないので、外を触られるとその走のあいだ効きっぱなしになる
//   実際に `stryker.config.json` の excludedMutations に「生き残る種類」だけ足されて、
//   不合格だった実装が生き残り0 で合格した
//
// どうするか ── 呼び出しのたびに作業領域の外の変更を元へ戻す（何を戻したかは画面に出す）
/**
 * 成果物の置き場所と tests/ の外に付いた変更を元へ戻す
 *
 * @param {{dir: string}} w 呼び出したワーカー
 * @param {(msg: string) => void} log 画面へ出す
 * @returns {Promise<string[]>} 戻したファイルのパス（1つも無ければ空）
 */
async function revertOutsideWork(w, log) {
  const rows = ((await run("git", ["status", "--porcelain"], { cwd: w.dir })).out || "").split("\n").filter(Boolean);
  const outside = rows
    .map((l) => ({ untracked: l.startsWith("??"), path: l.slice(3).trim() }))
    .filter((r) => !WORK_DIRS.some((d) => r.path === d || r.path.startsWith(`${d}/`)));
  if (outside.length === 0) return [];
  const tracked = outside.filter((r) => !r.untracked).map((r) => r.path);
  const untracked = outside.filter((r) => r.untracked).map((r) => r.path);
  if (tracked.length) await run("git", ["checkout", "--", ...tracked], { cwd: w.dir });
  if (untracked.length) await run("git", ["clean", "-fd", "--", ...untracked], { cwd: w.dir });
  log(`  作業領域の外を書き換えていたので戻した: ${outside.map((r) => r.path).join(", ")}`);
  return outside.map((r) => r.path);
}

// ---------- ワーカーが変異チェックを黙らせていないか ----------
// Stryker は `// Stryker disable …` と書かれた箇所を「無視」として扱う
//   ハーネスは無視された変異を数えないので、実装にこの印を1行 足すだけで
//   検証されていない枝をゲートから隠せる（落とし穴26 ── 印なしで不合格だった実装が、印ありで合格した）
//
// どうするか ── その走で増えた印だけを見る（元から人が書いていた印は尊重する）
const IGNORE_MARK = /Stryker\s+(disable|restore)/gi;
const countMarks = (s) => (String(s).match(IGNORE_MARK) || []).length;
/**
 * この走で新しく足された「変異チェックを黙らせる印」を探す
 *
 * @param {{dir: string}} w 判定中のワーカー
 * @param {string[]} files 調べる成果物（リポジトリからの相対パス）
 * @returns {Promise<string[]>} 印が増えていたファイル（1つでもあれば不合格にする）
 */
async function addedIgnoreMarks(w, files) {
  const hits = [];
  for (const f of files) {
    const now = existsSync(`${w.dir}/${f}`) ? readFileSync(`${w.dir}/${f}`, "utf8") : "";
    const base = (await git(w, "show", `HEAD:${f}`)).out || "";   // 新規ファイルなら空＝0個
    if (countMarks(now) > countMarks(base)) hits.push(f);
  }
  return hits;
}

// ---------- claude 呼び出し（コストを積む）----------
/**
 * ワーカーを1回 呼ぶ（WORKER_CMD が設定されていれば claude の代わりにそれを呼ぶ）
 *
 * @param {{dir: string, actor: string}} w 呼ぶワーカー（作業コピーを現在地にして起動する）
 * @param {string} prompt 標準入力から渡す指示
 * @param {{calls: number, usd: number, out: number, ms: number}} cost 呼ぶたびに積む（この関数が書き換える）
 * @returns {Promise<{ok: boolean}>} ok:false は起動できなかった時（人に差し戻す）
 */
async function callWorker(w, prompt, cost) {
  const env = { ...process.env, BEADS_ACTOR: w.actor };   // ワーカーが bd を叩いたら その actor で記録される
  if (WORKER_CMD) {   // スタブワーカー（制御フロー検証用・コストは付かない）
    const r = await run(WORKER_CMD, [], { cwd: w.dir, input: prompt, shell: true, timeout: T.worker, env });
    cost.calls++;
    return { ok: r.code === 0 };
  }
  const r = await run("claude", ["-p", "--output-format", "json", "--dangerously-skip-permissions"], {
    cwd: w.dir, input: prompt, timeout: T.worker, env,
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
    return { ok: true };   // JSON 壊れても「呼べてはいる」、ゲートが実際の成否を見る
  }
}

// ---------- 自己チェック（変異チェックの検算）----------
// 変異ツールが「生き残った」と報告したものを1個ずつ手で当て直し、素のテストを回す
//   落ちる     テストは検出できている → 変異ツール側が壊れている（生き残りを信じない）
//   通る       本当に検出できていない → 本物の生き残り
// なぜ要るか: 変異ツールがテストを辿れないと、完璧なテストでも全部 生き残りと報告される
//   それを信じると 通るはずのタスクが全部 不合格になる（proof/README.md の step3-e）
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
/**
 * 生き残りが本物か、変異ツール側が壊れているだけかを検算する
 *
 * @param {{dir: string}} w 判定中のワーカー
 * @param {object[]} survivors 変異チェックが「生き残った」と報告したもの
 * @param {number} [capPerFile=3] 1ファイルにつき当て直す上限（全部やると時間がかかる）
 * @returns {Promise<{trustworthy: boolean, artifact?: {file: string, line: number, mutator: string}}>}
 *   trustworthy:false は変異ツールが壊れている ── 生き残りを信じず人に差し戻す
 *   artifact は その判断の根拠になった1件（どのファイルの何行目か）
 */
async function selfCheck(w, survivors, capPerFile = 3) {
  const byFile = {};
  for (const s of survivors) (byFile[s.file] ??= []).push(s.mutant);
  for (const [f, muts] of Object.entries(byFile)) {
    const path = `${w.dir}/${f}`;
    if (!existsSync(path)) continue;
    const orig = readFileSync(path, "utf8");
    for (const m of muts.slice(0, capPerFile)) {
      writeFileSync(path, applyMutant(orig, m));
      const red = (await npmTest(w)).code !== 0;
      writeFileSync(path, orig);   // 必ず戻す
      if (red) return { trustworthy: false, artifact: { file: f, line: m.location?.start?.line, mutator: m.mutatorName } };
    }
  }
  return { trustworthy: true };
}

// ---------- 変異チェック ----------
// MUTATOR が指定されていれば そのファイルに任せる（コード以外の成果物・Stryker が使えない言語）
//   渡すファイルの条件: 関数を1つ default export し、{ survivors, total, output } を返すこと
//   （下の mutationCheck が返すものと同じ形・書き方の実例は sample/*/mutate-*.mjs）
const externalMutator = MUTATOR ? (await import(pathToFileURL(resolve(MUTATOR)).href)).default : null;
const MUTATOR_NAME = externalMutator ? "自作" : "Stryker";

// 既定（Stryker）
/**
 * Stryker を回して、生き残った変異を集める
 *
 * 注意: 前の走のレポートを必ず消してから実行する
 *   残したまま Stryker が落ちると、ハーネスは「レポートがある」を理由に前のタスクの結果を読んで
 *   合格にしてしまう（落とし穴32 ── 作業コピーはタスクをまたいで使い回すので、
 *   合格した回の「生き残り0」が残っている）
 *
 * @param {{dir: string}} w 判定中のワーカー
 * @param {string[]} srcFiles 変異させる成果物（そのタスクで変更したファイル）
 * @returns {Promise<{survivors: object[], total: number, output: string} | {error: string, output: string}>}
 *   error が返ったら Stryker 自体が動いていない ── 人に差し戻す
 */
async function mutationCheck(w, srcFiles) {
  const reportPath = `${w.dir}/${MUTATION_REPORT}`;
  if (existsSync(reportPath)) rmSync(reportPath);
  const r = await run("npx", ["stryker", "run", "--mutate", srcFiles.join(",")], { cwd: w.dir, shell: WIN, timeout: T.mutation });
  if (r.code !== 0) return { error: `Stryker が異常終了した（exit ${r.code}）`, output: r.out + r.err };
  if (!existsSync(reportPath)) return { error: "Stryker が動かなかった（レポート無し）", output: r.out + r.err };
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const survivors = [];
  let total = 0;
  for (const [file, data] of Object.entries(report.files ?? {})) {
    const lines = (data.source ?? "").split("\n");
    for (const m of data.mutants ?? []) {
      if (m.status === "Ignored") continue;   // 無視の印が付いた変異、ワーカーがこの走で足した印は addedIgnoreMarks で先に弾いている
      total++;
      if (m.status === "Survived" || m.status === "NoCoverage") {
        survivors.push({ file, mutant: m, original: (lines[(m.location?.start?.line ?? 1) - 1] ?? "").trim() });
      }
    }
  }
  return { survivors, total, output: r.out + r.err };
}
const survivorsToFeedback = (survivors) =>
  survivors.map((s) => {
    const ln = s.mutant.location?.start?.line ?? 0;
    return `- ${s.file}:${ln} の \`${s.original}\` を \`${(s.mutant.replacement ?? "").trim()}\` に書き換えても、テストは全部 緑のままでした（${s.mutant.mutatorName}）。` +
      `\n  → この部分の振る舞いを検証しているテストがありません。`;
  }).join("\n");

// ---------- 不合格の記録（理由の1行だけでなく中身を残す）----------
// 作業領域は書き直しのたびに元へ戻すので、戻す前にここへ写しておかないと後から原因を調べられない
//   残すもの: 不合格の理由・その時点の tests/ と src/ の中身・判定に使った出力（npm test など）
let failSeq = 0;
const slug = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 32);   // ファイル名に使えない文字だけ落とす（日本語は残す＝一覧で理由が読める）
/**
 * 不合格の中身をファイルへ残す（巻き戻す前に呼ぶ）
 *
 * @param {{dir: string, name: string}} w 判定中のワーカー
 * @param {{id: string, title: string, description?: string}} task 判定中のタスク
 * @param {string} tag 何回目か（`a1`〜`a3`）または `park`（人に差し戻し）
 * @param {string} why 不合格の理由（ファイル名にも入る）
 * @param {Record<string, string>} [detail] 判定に使った出力（見出し → 中身）
 * @returns {Promise<string>} 書いたファイル名
 */
async function saveFailure(w, task, tag, why, detail = {}) {
  const name = `${String(++failSeq).padStart(2, "0")}-${w.name}-${slug(task.id)}-${tag}-${slug(why)}.txt`;
  const parts = [`理由: ${why}`, `タスク: ${task.id} — ${task.title}`, task.description || "", `ワーカー: ${w.name}（${tag}）`, ""];
  for (const [k, v] of Object.entries(detail)) parts.push(`===== ${k} =====`, String(v ?? "").trim(), "");
  for (const f of await changedInWork(w)) {
    const p = `${w.dir}/${f}`;
    if (existsSync(p)) parts.push(`===== 成果物 ${f} =====`, readFileSync(p, "utf8"), "");
  }
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(`${LOG_DIR}/${name}`, parts.join("\n"));
  return name;
}

// ---------- 人への差し戻し（このプロセスは止めない＝他のワーカーは回り続ける）----------
const parked = new Set();   // 人に差し戻したタスクは担当し直させない（open に戻すと ready に出るため）
const rounds = {};          // task.id → 最初からやり直した回数（差し戻しが毎回ちがうので救済する・MAX_ROUNDS で打ち切る）
/**
 * タスクを人に差し戻す（このプロセスは止めない＝他のワーカーは回り続ける）
 *
 * @param {{dir: string, name: string}} w 判定中のワーカー
 * @param {{id: string, title: string, description?: string}} task 差し戻すタスク
 * @param {(msg: string) => void} log 画面へ出す
 * @param {string} why 差し戻す理由
 * @param {Record<string, string>} [detail] 判定に使った出力（記録に残す）
 * @returns {Promise<{ok: false, parked: true, why: string}>}
 */
async function park(w, task, log, why, detail = {}) {
  parked.add(task.id);
  const saved = await saveFailure(w, task, "park", why, detail);   // 巻き戻す前に中身を残す
  await resetWork(w);
  await bd(w, "update", task.id, "-s", "open");
  await bd(w, "update", task.id, "--add-label", "blocked-for-human");   // bd は --add-label（--labels は無効・黙って無視される）
  log(`人に差し戻し: ${task.id} — ${why}（詳細: ${LOG_DIR}/${saved}）`);
  return { ok: false, parked: true, why };
}

// ---------- 1タスクを通す（3つのゲート＋自己チェック＋書き直しの指示）----------
/**
 * 1つのタスクを3つのゲートに通す ── 通れば commit して完了、通らなければ人に差し戻す
 *
 * 中では MAX_ATTEMPTS 回まで書き直させ、それでも通らなければ
 * 書き直しの指示を捨てて最初からやり直す（MAX_ROUNDS 回まで）
 *
 * @param {{dir: string, name: string, actor: string}} w 担当するワーカー
 * @param {{id: string, title: string, description?: string}} task 担当するタスク
 * @param {(msg: string) => void} log 画面へ出す
 * @param {{calls: number, usd: number, out: number, ms: number}} cost 呼び出しのたびに積む
 * @returns {Promise<{ok: boolean, parked?: boolean, retry?: boolean, why?: string}>}
 *   ok:true      合格して commit した
 *   parked:true  人に差し戻した（同じタスクを担当し直させない）
 *   retry:true   最初からやり直す（同じタスクを次にもう一度 担当する）
 */
async function doTask(w, task, log, cost) {
  // ワーカーへ渡す仕様は タイトルと説明の両方をつなげたもの
  //   beads のタイトルは500バイト（日本語なら約160文字）が上限で長い仕様が入らない
  //   人が `bd create "短い題名" -d "詳しい仕様"` と書けるように、説明も渡す
  const spec = task.description ? `${task.title}\n\n${task.description}` : task.title;
  let feedback = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`${task.id} ${attempt}/${MAX_ATTEMPTS} 回目`);
    await resetWork(w);
    const retry = async (why, detail) => {
      const saved = await saveFailure(w, task, `a${attempt}`, why, detail);   // 巻き戻す前に中身を残す
      log(`  不合格: ${why}（詳細: ${LOG_DIR}/${saved}）`);
      await resetWork(w);
    };

    // テストだけ書かせる（前回の生き残りを書き直しの指示として渡す）
    const p1 =
      `あなたはワーカーです。次のタスクの「テストだけ」を書いてください。\n\n## タスク\n${spec}\n\n` +
      (feedback
        ? `## 前回のテストは不合格（変異チェックが検出した事実）\n実装をわざと壊したところ、次の壊し方をテストが検出できませんでした:\n\n${feedback}\n\n→ 今回は、上の振る舞いを必ず検証するテストを含めてください。\n\n`
        : ``) +
      `## 絶対に守ること\n- テスト（tests/）だけを書く。成果物（${WORK_ROOT}/）は絶対に作らない。\n` +
      `- 戻り値そのものを検証（型だけは不合格）。境界値・特殊入力（0・負数など）も検証。\n` +
      `- まだ実装が無いので、このテストは落ちるのが正しい。CLAUDE.md を読むこと。ESM。\n` +
      `- テストは \`npm test\`（= ${TEST_CMD}）で動く形式で書き、既存のテストの書き方に合わせる。\n`;
    const headBefore1 = await headOf(w);
    const tasksBefore1 = await taskStates(w);
    if (!(await callWorker(w, p1, cost)).ok) return park(w, task, log, "ワーカーの起動に失敗");
    await restoreTasksChangedBy(w, tasksBefore1, log, task.id);
    await undoWorkerCommits(w, headBefore1, log);
    await revertOutsideWork(w, log);

    const created = await changedInWork(w);
    if (created.some((f) => f.startsWith(`${WORK_ROOT}/`))) { await retry(`テストだけと言ったのに ${WORK_ROOT}/ まで作った`); continue; }
    const testFiles = created.filter((f) => f.startsWith("tests/"));
    if (testFiles.length === 0) { await retry("テストが書かれていない"); continue; }

    // ゲート1 赤先行 ── 実装が無いのにテストが通ったら、何も検証していない
    const red = await npmTest(w);
    if (red.code === 0) { await retry("実装が無いのにテストが通った（何も検証していない）", { "npm test": red.out + red.err }); continue; }

    // ゲート2 凍結 ── 実装させる前に tests/ 全部の内容を記録しておく
    //   この走で書いたテストだけでなく tests/ 全部が対象
    //   今回 触っていない既存のテストを弱められると、このゲートは素通りしてしまう（落とし穴27）
    const frozen = Object.fromEntries((await allTests(w)).map((f) => [f, sha(w, f)]));

    // 実装させる
    const p2 =
      `あなたはワーカーです。次のタスクの「実装」を書いてください。\n\n## タスク\n${spec}\n\n` +
      `## 状況\n受け入れテスト（${testFiles.join(", ")}）が既にあり、今は落ちています。これを通す成果物を ${WORK_ROOT}/ に書いてください。\n\n` +
      `## 絶対に守ること\n- テストファイルは1文字も変更しない。テストに合わせて値をハードコードしない。\n` +
      `- テストが要求していない"念のため"のコードを足さない（検証されない枝は不合格）。\n- CLAUDE.md を読むこと。\n`;
    const headBefore2 = await headOf(w);
    const tasksBefore2 = await taskStates(w);
    if (!(await callWorker(w, p2, cost)).ok) return park(w, task, log, "ワーカーの起動に失敗");
    await restoreTasksChangedBy(w, tasksBefore2, log, task.id);
    await undoWorkerCommits(w, headBefore2, log);
    await revertOutsideWork(w, log);

    // ゲート2 の判定 ── 記録した内容と1文字でも違えば、テストを弱められている
    const tampered = Object.entries(frozen).find(([f, h]) => sha(w, f) !== h);
    if (tampered) { await retry(`テスト ${tampered[0]} が書き換えられた（消された場合も含む・弱めて通すズル）`); continue; }

    // 実装した後、全テストが通るか
    const green = await npmTest(w);
    if (green.code !== 0) { await retry("実装後もテストが赤", { "npm test": green.out + green.err }); continue; }

    // ゲート3 変異チェック ── 実装を壊してテストが気づくか（生き残り0 で合格）
    const srcFiles = (await changedInWork(w)).filter((f) => f.startsWith(`${WORK_ROOT}/`));
    if (srcFiles.length === 0) { await retry(`成果物（${WORK_ROOT}/）が作られていない`); continue; }
    const marked = await addedIgnoreMarks(w, srcFiles);
    if (marked.length > 0) { await retry(`変異チェックを黙らせる印（Stryker disable）を ${marked.join(", ")} に書いた`); continue; }
    log(`  ゲート3 変異チェック（${MUTATOR_NAME}）: ${srcFiles.join(", ")}`);
    const mut = externalMutator ? await externalMutator(w, srcFiles, { runTest: () => npmTest(w) }) : await mutationCheck(w, srcFiles);
    if (mut.error) return park(w, task, log, mut.error, { [`${MUTATOR_NAME} の出力`]: mut.output });
    if (mut.total === 0) return park(w, task, log, "変異が1個も作られなかった（チェックが効いていない）", { [`${MUTATOR_NAME} の出力`]: mut.output });

    if (mut.survivors.length > 0) {
      // 自己チェック: 生き残りは本物か、それとも変異ツール側が壊れているだけか
      const sc = externalMutator ? { trustworthy: true } : await selfCheck(w, mut.survivors);   // 自作変異器は自分で当てて確認済み＝検算は不要
      if (!sc.trustworthy)
        return park(w, task, log, `Stryker がこのファイルで変異を効かせられていない（${sc.artifact.file}:${sc.artifact.line}）— 人が設定を直す`);
      feedback = survivorsToFeedback(mut.survivors);
      log(`  生き残り ${mut.survivors.length}/${mut.total} → 書き直しを指示`);
      for (const s of mut.survivors)   // どの変異が生き残ったか（等価変異かの手掛かり）
        log(`    生存: ${s.file}:${s.mutant.location?.start?.line} ${s.mutant.mutatorName}  \`${s.original}\` → \`${(s.mutant.replacement ?? "").trim()}\``);
      const saved = await saveFailure(w, task, `a${attempt}`, "変異が生き残った", { "生き残った変異": feedback });
      log(`    詳細: ${LOG_DIR}/${saved}`);
      await resetWork(w);
      continue;
    }

    // 3つとも通った ── 作業領域だけをコミットしてタスクを完了にする
    await git(w, "add", "-A", "--", ...WORK_DIRS);
    await git(w, "commit", "-m", `${task.title}\n\nharness: 赤先行→凍結→全テスト成功→変異チェック（変異${mut.total}個中 生き残り0）を確認して保存（${w.name}）`);
    await bd(w, "close", task.id, "--reason", `3つのゲートを通過（${w.name}・${attempt}回目・変異${mut.total}個中 生き残り0）`);
    log(`  合格: ${task.id}（${attempt}回目・変異${mut.total}個中 生き残り0）`);
    return { ok: true };
  }
  // 書き直しの上限まで使っても生き残りが消えなかった
  //   AI の出力は毎回ちがうので、同じタスクが合格したり差し戻されたりする
  //   書き直しの指示を捨てて最初から投げ直すと通ることが多い → MAX_ROUNDS 回まで救済する
  rounds[task.id] = (rounds[task.id] || 0) + 1;
  if (rounds[task.id] < MAX_ROUNDS) {
    log(`${MAX_ATTEMPTS}回 通らず → 書き直しの指示を捨てて最初からやり直す（${rounds[task.id] + 1}/${MAX_ROUNDS} 回目）`);
    await resetWork(w);
    await bd(w, "update", task.id, "-s", "open");   // 開放（人への差し戻しはしない・次の doTask で feedback は空に戻る）
    return { ok: false, retry: true };
  }
  return park(w, task, log, `最初から${MAX_ROUNDS}回・各${MAX_ATTEMPTS}回 書き直しても通らなかった（テストでは検出できない変異か、実装の問題）`);
}

// ---------- タスクリスト ----------
async function pending(w) {
  const all = JSON.parse((await bd(w, "list", "--json")).out || "[]");
  return all.filter((t) => t.status !== "closed" && !parked.has(t.id)).length;
}
/**
 * 取れるタスクを1件 確保する（早い者勝ち・他のワーカーが先なら次の候補へ）
 *
 * @param {{dir: string, actor: string}} w 確保するワーカー
 * @param {(msg: string) => void} log 画面へ出す
 * @returns {Promise<object|null>} 確保できたタスク、1件も取れなければ null
 */
async function claimNext(w, log) {
  const ready = JSON.parse((await bd(w, "ready", "--json")).out || "[]");
  for (const t of ready) {
    if (parked.has(t.id)) continue;
    const c = await bd(w, "update", t.id, "--claim");
    if (c.code === 0) return t;
    log(`担当を取れず（他のワーカーが先）: ${t.id}`);
  }
  return null;
}

// ---------- 外側ループ ----------
/**
 * ワーカー1本を、タスクが無くなるまで回し続ける（取る → 通す → 次の1件へ）
 *
 * 終わり方は2つ ── 終わっていないタスクが0件になるか、取れないまま待機の上限に達するか
 * どちらも自分で終わるので、外から止める必要は無い（永久に待たない＝終了保証）
 *
 * @param {{dir: string, name: string, actor: string}} w 回すワーカー
 * @param {{calls: number, usd: number, out: number, ms: number}} cost このワーカーぶんの費用を積む先
 * @returns {Promise<{w: string, done: {id: string, ok: boolean, parked: boolean}[]}>}
 *   done は担当したタスクの結果、ok=合格・parked=人に差し戻し・どちらも false なら失敗
 */
async function worker(w, cost) {
  const log = (m) => console.log(`[${w.name}] ${m}`);
  const done = [];
  let idle = 0;
  while (idle < MAX_IDLE_POLLS) {
    const task = await claimNext(w, log);
    if (task) {
      idle = 0;
      log(`担当: ${task.id} — ${task.title}`);
      const r = await doTask(w, task, log, cost);
      if (r.retry) continue;   // 最初からやり直し（同じタスクを次に担当し直す・書き直しの指示は捨てる・feedback は空から）
      done.push({ id: task.id, ok: r.ok, parked: r.parked });
      continue;
    }
    const left = await pending(w);
    if (left === 0) { log("タスクが無くなった → 終了"); break; }
    log(`取れるタスクなし（残 ${left} 件・依存待ち または 他のワーカーが作業中）→ ${POLL_MS / 1000}秒 待つ`);
    idle++;
    await sleep(POLL_MS);
  }
  return { w: w.name, done };
}

// ---------- 作業コピーの準備 ----------
/**
 * ワーカーの作業コピーを用意する（無ければ作って依存を入れ、有れば開始時のコミットへ戻す）
 *
 * @param {{dir: string, name: string, branch: string}} w 用意するワーカー
 * @param {string} baseTip 回し始めた時のコミット
 * @throws 作業コピーの作成か依存の追加に失敗した時
 */
async function setup(w, baseTip) {
  if (existsSync(`${w.dir}/.git`)) {
    await run("git", ["checkout", "-B", w.branch, baseTip], { cwd: w.dir });
    await resetWork(w);
    console.log(`[${w.name}] 既存の作業コピーを再利用（開始時のコミットへ復元）`);
  } else {
    const r = await run("git", ["worktree", "add", "-B", w.branch, w.dir, baseTip], { cwd: BASE });
    if (r.code !== 0) throw new Error(`作業コピーの作成に失敗（${w.name}）: ${r.err}`);
    console.log(`[${w.name}] 作業コピー（git worktree）を作成、依存をインストール（1本あたり約96MB）`);
  }
  if (!existsSync(`${w.dir}/node_modules`)) {
    const inst = await run("npm", ["install"], { cwd: w.dir, shell: WIN, timeout: T.install });
    if (inst.code !== 0) throw new Error(`npm install 失敗（${w.name}）: ${inst.err}`);
  }
}

// ---------- デモタスク（タスクが無ければ BASE に登録）----------
/**
 * タスクリストが空の時だけ、動作確認用のタスクを登録する
 *
 * 人が登録したタスクがあれば何もしない ── タスクを決めるのは人なので、勝手に足さない
 *
 * @returns {Promise<void>}
 */
async function seedIfEmpty() {
  const r = await run(["bd", "ready", "--json"].join(" "), [], { shell: true, cwd: BASE });
  const ready = JSON.parse(r.out || "[]");
  if (ready.length > 0) { console.log(`タスクリストに既に ${ready.length} 件 → デモタスクは登録しない`); return; }
  const count = N === 1 ? 1 : SEED_TASKS.length;   // ワーカー1本なら1件だけ（2件 登録しても片方が待つだけ）
  for (const title of SEED_TASKS.slice(0, count)) {
    await run(["bd", "create", q(title)].join(" "), [], { shell: true, cwd: BASE });
  }
  console.log(`デモタスクを ${count} 件 登録した`);
}

// ---------- 元のブランチへの統合 ----------
// 終わった枝を1本ずつ合体 → 毎回 全テストを再実行 → 通れば採用、落ちれば巻き戻す
// 「合体できたこと」と「合体してよいこと」は別 ── 見た目ではなく実際のテストで決める
/**
 * 各ワーカーの枝を1本ずつ元のブランチへ統合する
 *
 * @param {{name: string, branch: string}[]} workers 全ワーカー
 * @param {string} baseTip 回し始めた時のコミット（枝に成果があるかの判定に使う）
 * @returns {Promise<{w: string, result: "merged"|"conflict"|"reverted"|"nothing"|"main-red"}[]>}
 *   merged   統合して全テストが通った＝採用した
 *   conflict 他の変更と衝突したので中止して巻き戻した
 *   reverted 統合したらテストが落ちたので巻き戻した
 *   nothing  統合するものが無い（人に差し戻したタスクだけ）
 *   main-red 統合する前から元のブランチでテストが落ちていたので何もしなかった
 */
async function mergeToMain(workers, baseTip) {
  console.log("\n=== 元のブランチへの統合 ===");
  const baseGreen = await npmTestBase();
  if (baseGreen.code !== 0) {
    console.log("統合を中止 ── 元のブランチで既にテストが失敗しています");
    console.log("  合格した成果も統合しません（元のブランチを常に緑に保つため）");
    console.log(tail(baseGreen.out + baseGreen.err));   // 何が赤なのかを残す（判定だけだと原因が分からない）
    return workers.map((w) => ({ w: w.name, result: "main-red" }));
  }
  const out = [];
  for (const w of workers) {
    const ahead = ((await run("git", ["rev-list", "--count", `${baseTip}..${w.branch}`], { cwd: BASE })).out || "").trim();
    if (ahead === "0" || ahead === "") { console.log(`[${w.name}] 統合するものなし（人に差し戻したタスクだけ）`); out.push({ w: w.name, result: "nothing" }); continue; }
    const before = ((await gitBase("rev-parse", "HEAD")).out || "").trim();
    const m = await gitBase("merge", "--no-edit", w.branch);
    if (m.code !== 0) {
      await gitBase("merge", "--abort");
      console.log(`[${w.name}] 統合を中止 ── 他の変更と衝突したため巻き戻しました（成果は枝 ${w.branch} に残っています）`);
      out.push({ w: w.name, result: "conflict" });
      continue;
    }
    const after = await npmTestBase();
    if (after.code === 0) {
      console.log(`[${w.name}] 統合して全テストが成功 → 採用（元のブランチに残します）`);
      out.push({ w: w.name, result: "merged" });
    } else {
      console.log(tail(after.out + after.err));
      await gitBase("reset", "--hard", before);
      console.log(`[${w.name}] 統合後にテストが失敗 → 不採用、巻き戻しました（成果は枝 ${w.branch} に残っています）`);
      out.push({ w: w.name, result: "reverted" });
    }
  }
  console.log(`  元のブランチの最新: ${((await gitBase("log", "--oneline", "-1")).out || "").trim()}`);
  console.log(`  元のブランチの全テスト: ${(await npmTestBase()).code === 0 ? "成功" : "失敗"}`);
  return out;
}

// ================= 実行 =================
console.log(`=== ハーネス（3つのゲート＋自己チェック＋コストの計測）｜ワーカー ${N} つ ===`);
console.log(`対象: ${BASE}｜成果物: ${WORK_ROOT}/｜変異チェック: ${MUTATOR_NAME}\n`);   // 解決後のパスを出す（渡した表記と違う所を指していたら ここで気づける）
const baseTip = (await run("git", ["rev-parse", "HEAD"], { cwd: BASE })).out.trim();
console.log(`開始時のコミット: ${baseTip}`);

await seedIfEmpty();
for (const w of WORKERS) await setup(w, baseTip);   // install は直列（帯域/ディスク）

const costs = Object.fromEntries(WORKERS.map((w) => [w.name, { calls: 0, usd: 0, out: 0, ms: 0 }]));
const t0 = Date.now();
const results = await Promise.all(WORKERS.map((w) => worker(w, costs[w.name])));
const wall = ((Date.now() - t0) / 1000).toFixed(1);

const merged = await mergeToMain(WORKERS, baseTip);   // 最後の1歩 ── 合格した成果を元のブランチへ入れる

console.log("\n" + "=".repeat(64));
console.log("=== 結果 ===");
for (const r of results) {
  const s = r.done.map((d) => `${d.id}${d.ok ? "(合格)" : d.parked ? "(人に差し戻し)" : "(失敗)"}`).join(", ") || "なし";
  const mg = merged.find((m) => m.w === r.w);
  // 統合の結果は日本語で出す（英語のままだと画面だけでは意味が取れない）
  const MERGE_LABEL = {
    merged: "採用した", conflict: "衝突して中止", reverted: "テストが失敗したので巻き戻した",
    nothing: "統合するものなし", "main-red": "元のブランチが最初から失敗していたため統合せず",
  };
  console.log(`  ${r.w}: ${s} → 元のブランチへの統合: ${MERGE_LABEL[mg?.result] ?? "不明"}`);
}
console.log("\n=== claude の呼び出しにかかった費用（実測）===");
let tUsd = 0, tCalls = 0, tOut = 0;
for (const [name, c] of Object.entries(costs)) {
  console.log(`  ${name}: 呼び出し${c.calls}回 / $${c.usd.toFixed(4)} / 出力${c.out}トークン / claude 内部の処理時間 ${(c.ms / 1000).toFixed(1)}秒`);
  tUsd += c.usd; tCalls += c.calls; tOut += c.out;
}
console.log(`  合計: 呼び出し${tCalls}回 / $${tUsd.toFixed(4)} / 出力${tOut}トークン`);
console.log(`  実行時間（並列を含む全体）: ${wall}秒`);
console.log("=".repeat(64));
