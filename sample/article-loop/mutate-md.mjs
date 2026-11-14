// mutate-md.mjs — markdown 用の簡易変異器（Stryker が壊せるのはコードで markdown は対象外のため自作）
//
// ハーネスの mutationCheck と同じ形で返す: { survivors, total, output }
//   survivors の要素も同じ形（{ file, mutant: { mutatorName, location, replacement }, original }）
//   ＝ 生き残りをワーカーへ渡すフィードバック生成をそのまま使える
//
// やること: 記事を1箇所ずつ機械的に壊し、そのたびにテストを実行する
//   赤くなった → テストがその壊し方を検出できている（殺せた）
//   緑のまま   → その部分を検証しているテストが無い（生き残り）
//
// 正直な限界: 壊し方は下に並べたものだけで、Stryker のような網羅性は無い
//   見出しの削除／見出しの格下げ／箇条書きの項目の削除／リンクを壊す／
//   コードブロックの削除／本文の行の削除
//   ＝「生き残り0」の意味は、コードに Stryker を当てた時より弱い

import { readFileSync, writeFileSync } from "node:fs";

// 1つの記事から「壊し方」を全部作る（この時点では当てない）
//   add に渡す line は配列の添字（0始まり）、ハーネスへ返す location.start.line は
//   画面と記録に出る行番号（1始まり）なので +1 する
function plan(src) {
  const lines = src.split("\n");
  const out = [];
  const add = (mutatorName, line, replacement, apply) =>
    out.push({ mutatorName, location: { start: { line: line + 1 } }, replacement, original: lines[line], apply });

  // ファイル全体を走査して、壊せる場所を集める
  let inFence = false, fenceStart = -1;
  lines.forEach((l, i) => {
    if (/^```/.test(l)) {
      if (!inFence) { inFence = true; fenceStart = i; }
      else {   // コードブロックを丸ごと消す
        const s = fenceStart, e = i;
        add("CodeBlockRemoval", s, "（コードブロックを削除）", (ls) => ls.filter((_, j) => j < s || j > e));
        inFence = false;
      }
      return;
    }
    if (inFence) return;

    if (/^#{1,6} .+/.test(l)) {
      add("HeadingRemoval", i, "（見出しの行を削除）", (ls) => ls.filter((_, j) => j !== i));
      add("HeadingDemotion", i, l.replace(/^#{1,6} /, ""), (ls) => ls.map((x, j) => (j === i ? x.replace(/^#{1,6} /, "") : x)));
      return;
    }
    if (/^\s*[-*] .+/.test(l)) {
      add("ListItemRemoval", i, "（箇条書きの項目を削除）", (ls) => ls.filter((_, j) => j !== i));
      return;
    }
    if (/\[[^\]]+\]\([^)]+\)/.test(l)) {
      add("LinkBreak", i, l.replace(/(\[[^\]]+\])\([^)]+\)/g, "$1()"), (ls) =>
        ls.map((x, j) => (j === i ? x.replace(/(\[[^\]]+\])\([^)]+\)/g, "$1()") : x)));
      return;
    }
    if (l.trim().length > 0) {
      add("ParagraphRemoval", i, "（本文の行を削除）", (ls) => ls.filter((_, j) => j !== i));
    }
  });
  return out;
}

/**
 * 記事を1箇所ずつ壊して、テストが気づくか調べる
 *
 * ハーネスは `MUTATOR` にこのファイルを渡されると、Stryker の代わりにこの関数を呼ぶ
 *
 * @param {{dir: string}} w ワーカーの作業コピー（`dir` は絶対パス）
 * @param {string[]} files 変異させる記事（対象リポジトリからの相対パス）
 * @param {{runTest: () => Promise<{code: number}>}} ctx テストを1回 走らせる（0 以外＝赤）
 * @returns {Promise<{survivors: object[], total: number, output: string}>}
 *   survivors 緑のままだった壊し方 ── ハーネスがこれをそのまま書き直しの指示にする
 *   total     作った壊し方の数（0 だと「チェックが効いていない」として人に差し戻される）
 *   output    判定に使った出力（不合格の時に記録として残る）
 */
export default async function mutateMarkdown(w, files, { runTest }) {
  const survivors = [];
  let total = 0;
  const log = [];

  for (const f of files) {
    const path = `${w.dir}/${f}`;
    const orig = readFileSync(path, "utf8");
    const mutants = plan(orig);
    for (const m of mutants) {
      const mutated = m.apply(orig.split("\n")).join("\n");
      if (mutated === orig) continue;   // 何も変わらない＝変異になっていないので数えない
      total++;
      writeFileSync(path, mutated);
      const red = (await runTest()).code !== 0;
      writeFileSync(path, orig);   // 必ず戻す
      if (!red) survivors.push({ file: f, mutant: m, original: (m.original || "").trim() });
      log.push(`${red ? "検出した  " : "生き残った"} ${f}:${m.location.start.line} ${m.mutatorName}`);
    }
  }
  return { survivors, total, output: log.join("\n") };
}
