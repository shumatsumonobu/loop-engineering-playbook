// stub-worker.mjs — claude の代わりに決まった動きをする偽のワーカー（正常系・$0）
//
// なぜ要るか:
//   「弱いテストで落ちる → 書き直しの指示 → 通る → 統合まで到達」が本当に配線されているかを、
//   課金せず 毎回 同じ結果で確かめるため
//   claude は素直に良いテストを書くので、落ちる側の道はまず通らない
//
// 使い方（ハーネスのルートから・対象はリポジトリ外の検証用リポジトリ）:
//   WORKER_CMD="node <絶対パス>/proof/stub-worker.mjs" BASE=/path/to/probe node harness/integrated.mjs
//
// 動き ── ハーネスが渡すプロンプトで段階を判定する
//   「テストだけ」を含む → テスト段階、それ以外 → 実装段階
//
//   テスト段階で書くもの
//     初回                            弱いテスト（0 の枝を検証しない → 変異が生き残る）
//     「前回のテストは不合格」を含む   強いテスト（変異を全部 殺す）
//     STUB_MODE=always-weak           常に弱いテスト（書き直しの上限まで落ちて人に差し戻される）
//
// 注意1: 成果物は src/ に固定で書く ── WORK_ROOT を変えて回すと、ハーネスは指定した場所を見るのに
//   このスタブは src/ に書くので「成果物が作られていない」で落ちる
//
// 注意2: 書くファイル名は作業コピーごとに変える（classify_w1.js / classify_w2.js）
//   並列で回した時に、元のブランチへの統合で衝突しないため
//
// 判定
//   壊れていない  1回目に生き残りが出て書き直しの指示 → 2回目で生き残り0 → 合格 → 元のブランチへ採用
//                 STUB_MODE=always-weak なら 上限まで落ちて人に差し戻される
//   壊れている    1回目から合格する（弱いテストで変異が死んでいる＝変異チェックが効いていない）
//                 「ワーカーの起動に失敗」が出る（WORKER_CMD のパスが相対のまま）

import { writeFileSync, mkdirSync } from "node:fs";

const m = process.cwd().match(/-w(\d+)$/);
const tag = m ? `_w${m[1]}` : "";           // 例: ...-w2 → "_w2"
const LABEL = m ? `stub w${m[1]}` : "stub";   // 画面に出す名前（作業コピーの番号が取れない時は付けない）
const SRC = `src/classify${tag}.js`;
const TEST = `tests/classify${tag}.test.js`;

const IMPL = `export function classify(n) {
  if (n < 0) return "neg";
  if (n === 0) return "zero";
  return "pos";
}
`;

// 弱い: 0 の枝（"zero"）を1度も検証していない → Stryker の変異が生き残る
const WEAK = `import { test, expect } from "vitest";
import { classify } from "../${SRC}";
test("正の数は pos", () => { expect(classify(5)).toBe("pos"); });
test("負の数は neg", () => { expect(classify(-3)).toBe("neg"); });
`;

// 強い: 0・境界も検証 → 変異を全部殺す
const STRONG = `import { test, expect } from "vitest";
import { classify } from "../${SRC}";
test("正の数は pos", () => { expect(classify(5)).toBe("pos"); });
test("負の数は neg", () => { expect(classify(-3)).toBe("neg"); });
test("ゼロは zero", () => { expect(classify(0)).toBe("zero"); });
test("境界 -1 は neg", () => { expect(classify(-1)).toBe("neg"); });
test("境界 1 は pos", () => { expect(classify(1)).toBe("pos"); });
`;

let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  mkdirSync("src", { recursive: true });
  mkdirSync("tests", { recursive: true });

  if (prompt.includes("テストだけ")) {
    const strong = prompt.includes("前回のテストは不合格") && process.env.STUB_MODE !== "always-weak";
    writeFileSync(TEST, strong ? STRONG : WEAK);
    console.error(`[${LABEL}] テスト段階 → ${strong ? "強い" : "弱い"}テストを書いた（${TEST}）`);
  } else {
    writeFileSync(SRC, IMPL);
    console.error(`[${LABEL}] 実装段階 → ${SRC} を書いた`);
  }
  process.exit(0);
});
