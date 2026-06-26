// Stop フック: ループの headless 実行時だけ、テストが赤なら「まだ終わるな」と差し戻す（自己改善のハード強制）。
// 対話セッション（LOOP_RUN 未設定）では何もしない＝普段の開発を邪魔しない。
// 公式契約: Stop フックは top-level {"decision":"block","reason":...} を stdout に出すと Claude が続行する。
//   入力 JSON の stop_hook_active=true（前回のブロックで継続中）なら停止を許可し無限ループを防ぐ。
//   Claude Code は連続ブロックが既定8回でこのフックを上書きする（出典: 公式 hooks-guide.md "Stop hook hits the block cap"・env CLAUDE_CODE_STOP_HOOK_BLOCK_CAP で調整）。
//   ※ ヘッドレス(claude -p)で Stop が発火するかは公式未記載 → チビ検証で実測する。発火しなくても
//      PROMPT 駆動の自己改善 + loop.mjs の客観ゲートで成立する設計（このフックはハード強制の上乗せ）。
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const trace = (m) => {
  try { appendFileSync(".claude/loop/hook.log", `${new Date().toISOString()} ${m}\n`); } catch {}
};

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  // 対話セッションでは無効（ループ実行時のみ loop.mjs が LOOP_RUN=1 を渡す）
  if (process.env.LOOP_RUN !== "1") process.exit(0);

  // 無限ループ防止: 既に連続ブロック済みなら停止を許可
  try {
    if (JSON.parse(input || "{}").stop_hook_active === true) { trace("stop_hook_active=true -> allow stop"); process.exit(0); }
  } catch {}

  // テスト実行。緑なら停止を許可、赤なら差し戻し。
  const green = spawnSync("npx", ["vitest", "run"], {
    stdio: "ignore",
    shell: process.platform === "win32",
    timeout: 120000,
  }).status === 0;

  if (green) { trace("tests green -> allow stop"); process.exit(0); }

  trace("tests red -> block (差し戻し)");
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: "テストが赤です。`npx vitest run` の失敗をすべて直してから完了してください。",
  }));
  process.exit(0);
});
