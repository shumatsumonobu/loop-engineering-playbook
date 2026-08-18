// mutate-py.mjs — Python 用の簡易変異器（Stryker は JavaScript/TypeScript 専用のため自作）
//
// ハーネスの mutationCheck と同じ形で返す: { survivors, total, output }
//   survivors の要素も同じ形（{ file, mutant: { mutatorName, location, replacement }, original }）
//   ＝ 生き残りをワーカーへ渡すフィードバック生成をそのまま使える
//
// やること: 実装を1箇所ずつ機械的に壊し、そのたびにテストを実行する
//   赤くなった → テストがその壊し方を検出できている（殺せた）
//   緑のまま   → その部分を検証しているテストが無い（生き残り）
//
// 正直な限界: 壊し方は下に並べたものだけで、Stryker のような網羅性は無い
//   比較（== != > < >= <=）／算術（+ - * %）／論理（and or）／真偽値（True False）／
//   not の除去／数値／文字列／return の除去
//   ＝「生き残り0」の意味は、JavaScript に Stryker を当てた時より弱い
//   書き換えは行単位の正規表現で、構文木は解析しない（Python のパーサは持ち込まない）

import { readFileSync, writeFileSync } from "node:fs";

// 1行を書き換える変異（探す形 → 置き換える形）
const LINE_RULES = [
  ["ComparisonOperator", /(?<![<>=!])==(?!=)/, "!="],
  ["ComparisonOperator", /!=/, "=="],
  ["ComparisonOperator", /(?<![<>=!])>=/, ">"],
  ["ComparisonOperator", /(?<![<>=!])<=/, "<"],
  ["ComparisonOperator", /(?<![<>=!])>(?!=)/, "<"],
  ["ComparisonOperator", /(?<![<>=!])<(?!=)/, ">"],
  ["ArithmeticOperator", /(?<![+\-*/%])\+(?![+=])/, "-"],
  ["ArithmeticOperator", /(?<![+\-*/%])-(?![-=>])/, "+"],
  ["ArithmeticOperator", /(?<![*])\*(?![*=])/, "/"],
  ["ArithmeticOperator", /%(?!=)/, "*"],
  ["LogicalOperator", /\band\b/, "or"],
  ["LogicalOperator", /\bor\b/, "and"],
  ["BooleanLiteral", /\bTrue\b/, "False"],
  ["BooleanLiteral", /\bFalse\b/, "True"],
  ["ConditionalNegation", /\bnot\s+/, ""],
];

// 1つの実装ファイルから「壊し方」を全部作る（この時点では当てない）
//   add に渡す i は配列の添字（0始まり）、ハーネスへ返す location.start.line は
//   画面と記録に出る行番号（1始まり）なので +1 する
function plan(src) {
  const lines = src.split("\n");
  const out = [];
  const add = (mutatorName, i, replacement, apply) =>
    out.push({ mutatorName, location: { start: { line: i + 1 } }, replacement, original: lines[i], apply });

  lines.forEach((l, i) => {
    const code = l.replace(/#.*$/, "");          // 行コメントは壊さない
    if (!code.trim() || /^\s*(import|from)\s/.test(code)) return;

    for (const [name, re, to] of LINE_RULES) {
      if (!re.test(code)) continue;
      const mutated = code.replace(re, to) + l.slice(code.length);
      if (mutated === l) continue;
      add(name, i, mutated.trim(), (ls) => ls.map((x, j) => (j === i ? mutated : x)));
    }

    // 数値リテラルを +1 する（境界値を検証しているテストがあるか）
    const num = code.match(/(?<![\w.])(\d+)(?![\w.])/);
    if (num) {
      const mutated = code.replace(num[0], String(Number(num[1]) + 1)) + l.slice(code.length);
      add("NumberLiteral", i, mutated.trim(), (ls) => ls.map((x, j) => (j === i ? mutated : x)));
    }

    // 文字列リテラルを空にする（戻り値の中身を検証しているテストがあるか）
    const str = code.match(/(['"])((?:(?!\1).)+)\1/);
    if (str && str[2].length > 0) {
      const mutated = code.replace(str[0], `${str[1]}${str[1]}`) + l.slice(code.length);
      add("StringLiteral", i, mutated.trim(), (ls) => ls.map((x, j) => (j === i ? mutated : x)));
    }

    // return を落として None を返させる（戻り値を検証しているテストがあるか）
    const ret = code.match(/^(\s*)return\s+\S/);
    if (ret) {
      const mutated = `${ret[1]}return None`;
      add("ReturnRemoval", i, mutated.trim(), (ls) => ls.map((x, j) => (j === i ? mutated : x)));
    }
  });
  return out;
}

/**
 * Python の実装を1箇所ずつ壊して、テストが気づくか調べる
 *
 * ハーネスは `MUTATOR` にこのファイルを渡されると、Stryker の代わりにこの関数を呼ぶ
 *
 * @param {{dir: string}} w ワーカーの作業コピー（`dir` は絶対パス）
 * @param {string[]} files 変異させる実装（対象リポジトリからの相対パス）
 *   `.py` 以外と `__init__.py` は飛ばす（`__init__.py` は import をまとめるだけで振る舞いを持たない）
 * @param {{runTest: () => Promise<{code: number}>}} ctx テストを1回 走らせる（0 以外＝赤）
 * @returns {Promise<{survivors: object[], total: number, output: string}>}
 *   survivors 緑のままだった壊し方 ── ハーネスがこれをそのまま書き直しの指示にする
 *   total     作った壊し方の数（0 だと「チェックが効いていない」として人に差し戻される）
 *   output    判定に使った出力（不合格の時に記録として残る）
 */
export default async function mutatePython(w, files, { runTest }) {
  const survivors = [];
  let total = 0;
  const log = [];

  for (const f of files) {
    if (!/\.py$/.test(f) || /__init__\.py$/.test(f)) continue;
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
      log.push(`${red ? "検出した  " : "生き残った"} ${f}:${m.location.start.line} ${m.mutatorName} → ${m.replacement}`);
    }
  }
  return { survivors, total, output: log.join("\n") };
}
