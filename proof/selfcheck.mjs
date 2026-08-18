// selfcheck.mjs — 変異ゲートの「自己チェック」（ゲート3を信じてよいかを検算）
//
// なぜ要るか（実コードで判明・DESIGN §4）:
//   実コード（このリポジトリの Express API）に Stryker を素で当てたら スコア 7.25%・routes.js は
//   killed 0（116個 全部 生き残り）、だがテストは強い——生き残ったと報告された変異を手で
//   入れたら npm test が赤くなった、原因＝テストが supertest で HTTP 経由に叩き、ソースを
//   直接 import していない＋ routes.js が CommonJS → Stryker が「関連テスト」を辿れず、
//   エラーで止まらず"それっぽい低スコア"を出した、これを信じると完璧なテストでも全 REJECT
//
// 自己チェックの原理:
//   Stryker が「生き残った」と報告した変異を1個ずつ 手で当てて、素の npm test を回す
//     npm test が赤 → テストは殺せている → Stryker が嘘（ツール壊れ）= artifact
//     npm test が緑 → テストが本当に殺せない → 本物の生き残り（弱い or 等価 or 未カバー）
//   artifact が1個でも出たら Stryker はこのリポジトリで信用できない → ゲートを使わず人に警告
//
// 実測（このリポジトリで確認済み）:
//   routes.js（CJS＋HTTP統合テスト）: Survived 8/8 が artifact → 「Stryker 壊れ」を検出 ✓
//   index.js （ESM 直接 import）    : Survived 6/6 が real     → 「本物」と正しく判定 ✓
//   ＝ 常に警告するのではなく、Stryker が壊れている時だけ warn（＝使える）
//
// 使い方（ハーネスから呼ぶ想定）:
//   const v = selfCheck({ repo, reportPath, srcFilter });
//   v.trustworthy===false なら ゲート3 を使わず人に差し戻し（人が Stryker 設定を直す）

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// line/col(1-based) → 文字オフセット
function toOffset(src, line, col) {
  const lines = src.split("\n");
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i].length + 1; // +1 = \n
  return off + (col - 1);
}
function applyMutant(src, m) {
  const s = toOffset(src, m.location.start.line, m.location.start.column);
  const e = toOffset(src, m.location.end.line, m.location.end.column);
  return src.slice(0, s) + (m.replacement ?? "") + src.slice(e);
}

/**
 * @param {object} o
 * @param {string} o.repo         リポジトリのルート（npm test を回す場所）
 * @param {string} o.reportPath   Stryker の JSON レポート（reports/mutation.json）
 * @param {number} [o.capPerFile=5]  ファイルごとに突き合わせる survivor の上限
 * @returns {{trustworthy:boolean, artifact?:object, checked:number}}
 *
 * 壊れは「ファイル単位」（実測: 同じリポジトリでも index.js=ESM は正常・routes.js=CJS は壊れ）
 *   だから cap は全体ではなく "ファイルごと"、survivor を持つ全ファイルを検算
 */
export function selfCheck({ repo, reportPath, capPerFile = 5 }) {
  if (!existsSync(reportPath)) return { trustworthy: false, reason: "レポートが無い（Stryker が動かなかった）", checked: 0 };
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const npmTest = () =>
    spawnSync("npm", ["test"], { cwd: repo, shell: process.platform === "win32", timeout: 120_000 }).status;

  let checked = 0;
  for (const [f, d] of Object.entries(report.files ?? {})) {
    // Survived を先に見る（NoCoverage=catchブロック等は後回し）
    const survivors = (d.mutants ?? [])
      .filter((m) => m.status === "Survived" || m.status === "NoCoverage")
      .sort((a) => (a.status === "Survived" ? -1 : 1));
    if (survivors.length === 0) continue;
    const path = `${repo}/${f}`;
    if (!existsSync(path)) continue;
    const orig = readFileSync(path, "utf8");

    for (const m of survivors.slice(0, capPerFile)) {   // ファイルごとに cap
      checked++;
      writeFileSync(path, applyMutant(orig, m));
      const red = npmTest() !== 0;
      writeFileSync(path, orig); // 必ず戻す
      if (red) {
        // テストは殺せているのに Stryker は survived と言った ＝ Stryker が壊れている
        return {
          trustworthy: false,
          reason: `Stryker がこのファイルで変異を効かせられていない（例: テストが直接 import していない/CommonJS）`,
          artifact: { file: f, line: m.location.start.line, mutator: m.mutatorName },
          checked,
        };
      }
    }
  }
  return { trustworthy: true, checked };
}
