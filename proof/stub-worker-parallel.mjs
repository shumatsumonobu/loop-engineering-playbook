// stub-worker-parallel.mjs — claude の代わりに決まった動きをする偽のワーカー（並列の場合・$0）
//
// なぜ要るか:
//   タスクリストは全ワーカーで共有なので、「呼び出しの前後で状態を比べる」類の防御は
//   目の前のワーカーのせいでない変化まで拾ってしまう
//   実際に起きた: ワーカーの `bd close` を打ち消す仕組みを入れたら、並列で別のワーカーが
//   正しく完了させたタスクまで開け直し、互いの成果を取り消し合って同じタスクを延々とやり直した
//   （proof/README.md の落とし穴31）
//   ワーカー1本の検証では絶対に出ない ── ハーネスを変えたら並列も回す
//
// 仕掛け: w1 だけ テスト段階で10秒 待つ → その間に w2 が1タスクを完了する
//   ＝「自分の呼び出し中に、他のワーカーがタスクを閉じた」状況を決定論的に作る
//
// 使い方（ハーネスのルートから・対象は独立したタスクを2件 登録したリポジトリ外の検証用リポジトリ）:
//   WORKER_CMD="node <絶対パス>/proof/stub-worker-parallel.mjs" BASE=/path/to/probe node harness/integrated.mjs 2
//
// 注意1: WORKER_CMD は絶対パスで書く（Windows は C:/… 形式）
//   ハーネスは作業コピーを現在地にしてワーカーを起動するので、相対パスだとこのスタブが見つからず
//   全部「ワーカーの起動に失敗」で差し戻しになる ── 検証していないのに元のブランチは無傷なので、
//   防御が効いたように見えてしまう
//
// 注意2: 成果物は src/ に固定で書く ── WORK_ROOT を変えて回すと、ハーネスは指定した場所を見るのに
//   このスタブは src/ に書くので「成果物が作られていない」で落ちる
//
// 判定
//   壊れていない  「開け直した」が1度も出ない／2タスクとも1回目で合格して採用／呼び出しは各2回
//   壊れている    互いの完了を「ワーカーが閉じた」と誤検知して開け直し、同じタスクを再実行する
//                 （呼び出しが倍に増える）

import { writeFileSync, mkdirSync } from "node:fs";

const m = process.cwd().match(/-w(\d+)$/);
const tag = m ? `_w${m[1]}` : "";        // 作業コピーごとに別ファイル＝並列でも統合で衝突しない
const SLOW = m && m[1] === "1";
const prompt = await new Promise((r) => {
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => r(s));
});

mkdirSync("src", { recursive: true });
mkdirSync("tests", { recursive: true });

if (prompt.includes("テストだけ")) {
  writeFileSync(`tests/double${tag}.test.js`, `import { test, expect } from "vitest";
import { double } from "../src/double${tag}.js";
test("2倍", () => { expect(double(2)).toBe(4); });
test("0", () => { expect(double(0)).toBe(0); });
test("負数", () => { expect(double(-3)).toBe(-6); });
`);
  if (SLOW) {
    console.error("[parallel] w1 はテスト段階で10秒 待つ（この間に w2 がタスクを完了する）");
    await new Promise((r) => setTimeout(r, 10_000));
  }
} else {
  writeFileSync(`src/double${tag}.js`, `export const double = (n) => n * 2;\n`);
}
