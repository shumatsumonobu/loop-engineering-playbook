// inspect.mjs — ドキュメントとコードのうち、自動で判定できる所を1本で検査する
//
// なぜ要るか: 同じ検査を毎回 手で組み立てると抜ける（実際に起きた: 改行コードの検査が無く、
//   Python で書き戻したファイルを全行 CRLF にして差分を593行に膨らませた）
//
// 使い方: node .claude/scripts/inspect.mjs
//   exit 0 が合格、落ちた項目だけ理由を出す
//
// ここで見るのは「自動で判定できること」だけ、中身の正しさは [.claude/rules/](../rules/) の基準で人が見る

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

// 検査するドキュメント ── git 管理下の .md を全部（固定リストにすると足し忘れる）
//   除くのは ループが生成した成果物だけ＝実証の証拠なので直さない
const GENERATED = /^sample\/[^/]+\/(src|tests|articles)\//;
const DOCS = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => !GENERATED.test(f));

// 行末の句点は禁止、ただし次は例外
//   原文をそのまま載せる所（タスク文・ワーカーへ渡した文言の引用）と 句点の規約を説明している行
const KUTEN_OK = /原文|そのまま|`.*。.*`|句点/;

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

// ---------- .mjs の構文 ----------
// git 管理下の .mjs を全部（固定リストにすると足し忘れる ── 実際に
//   sample/python-pytest/mutate-py.mjs が対象から漏れていた）
const mjs = execFileSync("git", ["ls-files", "*.mjs"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => !GENERATED.test(f));
const broken = mjs.filter((f) => {
  try { execFileSync("node", ["--check", join(ROOT, f)], { stdio: "pipe" }); return false; } catch { return true; }
});
check(`.mjs の構文（${mjs.length}本）`, broken.length === 0, broken.join(", "));

// ---------- 改行コード（LF に統一）----------
const crlf = [...DOCS, ...mjs].filter((f) => readFileSync(join(ROOT, f)).includes(0x0d));
check("改行コードが LF か", crlf.length === 0, crlf.join(", "));

// ---------- 行末の句点 ----------
const kuten = [];
for (const f of DOCS) {
  const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
  lines.forEach((l, i) => {
    if (!l.includes("。")) return;
    // 行末・セルの末尾・閉じ括弧の直前で終わっているものだけを拾う
    if (!/。\s*$|。\s*\||。\s*[）)]/.test(l)) return;
    if (KUTEN_OK.test(l)) return;
    kuten.push(`${f}:${i + 1}`);
  });
}
check("行末に句点が無いか", kuten.length === 0, kuten.join(", "));

// コードブロックとインラインコードを外す（中の `[text](./x.md)` は記法の例であって本文のリンクではない）
const stripCode = (s) => s.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
// GitHub の見出しリンクと同じ形にそろえる（小文字化 → 文字と数字と空白以外を落とす → 空白をハイフンへ）
//   trim しない ── `### ② 将来（…）` は ② が落ちて先頭に空白が残り、GitHub では `-将来…` になる
//   `②` は Unicode では「数字」なので \p{N} だと残ってしまう、GitHub は落とすので ASCII の数字だけ残す
const slug = (h) => h.toLowerCase().replace(/[^\p{L}0-9\s-]/gu, "").replace(/\s+/g, "-");

// ---------- 相対リンクの飛び先が実在するか ----------
const deadLinks = [];
for (const f of DOCS) {
  const body = stripCode(readFileSync(join(ROOT, f), "utf8"));
  const base = dirname(join(ROOT, f));
  for (const m of body.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1];
    if (/^https?:|^#|^mailto:/.test(target)) continue;
    if (!existsSync(join(base, target.split("#")[0]))) deadLinks.push(`${f} → ${target}`);
  }
}
check("相対リンクの飛び先が実在するか", deadLinks.length === 0, deadLinks.join(" / "));

// ---------- 見出しへのリンク（アンカー）が実在するか ----------
//   他のファイルの見出しを指すリンク（`other.md#見出し`）も見る
//   実際に起きた: CLAUDE.md の節を rules へ移したあと、MAINTAINING.md から `CLAUDE.md#実走実験の進め方` を
//   指したままになっていた ── 同じファイル内しか見ていなかったので素通りした
const headsOf = (file) => {
  const p = join(ROOT, file);
  if (!existsSync(p)) return null;
  return new Set([...readFileSync(p, "utf8").matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1])));
};
const deadAnchors = [];
for (const f of DOCS) {
  const raw = readFileSync(join(ROOT, f), "utf8");
  const own = headsOf(f);
  for (const m of stripCode(raw).matchAll(/\]\(([^)]*)#([^)]+)\)/g)) {
    const [, target, anchor] = m;
    if (/^https?:/.test(target)) continue;
    const heads = target === "" ? own : headsOf(join(dirname(f), target).replace(/\\/g, "/"));
    if (heads && !heads.has(anchor)) deadAnchors.push(`${f} → ${target}#${anchor}`);
  }
}
check("見出しへのリンクが実在するか（他のファイル宛ても）", deadAnchors.length === 0, deadAnchors.join(" / "));

// ---------- 章と付録を番号で指した所が実在するか ----------
//   リンクではない裸の参照（`§4-8`・`付録5`）は上のアンカーの検査に掛からない
//   実際に起きた: 付録を1つ消して番号が 0/1/2/3/5 と飛んだ、当時は指している所が残っていて空振りしていた
//   §N-M は「章 N-M」が在ればそれ、無ければ「章 N の項目 M」として照合する（`## 7-2.` のような章があるため）
const badRefs = [];
for (const f of DOCS) {
  const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
  const chapters = new Set(), appendices = new Set(), items = {};
  let cur = null;
  for (const l of lines) {
    const ap = l.match(/^#{2,3} 付録([0-9]+)\. /);
    if (ap) { appendices.add(ap[1]); cur = null; continue; }
    const ch = l.match(/^#{2,3} ([0-9]+(?:-[0-9]+)?)\. /);
    if (ch) { chapters.add(ch[1]); cur = ch[1]; items[cur] = new Set(); continue; }
    if (/^#{2,3} /.test(l)) { cur = null; continue; }
    const it = cur && l.match(/^([0-9]+)\. /);
    if (it) items[cur].add(it[1]);
  }
  if (chapters.size === 0 && appendices.size === 0) continue;   // 番号付きの章を持たない文書は対象外
  const raw = readFileSync(join(ROOT, f), "utf8");
  for (const [full, ch, item] of raw.matchAll(/§([0-9]+)(?:-([0-9]+))?/g)) {
    if (item && chapters.has(`${ch}-${item}`)) continue;        // `## 7-2.` のような章そのもの
    if (!chapters.has(ch)) { badRefs.push(`${f}: ${full}（章 ${ch} が無い）`); continue; }
    if (item && !items[ch]?.has(item)) badRefs.push(`${f}: ${full}（§${ch} に項目 ${item} が無い）`);
  }
  for (const [full, n] of raw.matchAll(/付録([0-9]+)/g))
    if (!appendices.has(n)) badRefs.push(`${f}: ${full}（付録 ${n} が無い）`);
}
check("章と付録を番号で指した所が実在するか", badRefs.length === 0, [...new Set(badRefs)].join(" / "));

// ---------- 他のファイルの手順番号への参照（目で見る）----------
//   参照先で手順が1つ増減すると黙って壊れる、ただし「自分のファイルの手順」か「実験の記録」かは自動では決められない
//   → 落とさずに一覧だけ出す（`再現手順1回` のような数え方は除く）
const stepRefs = new Set();
for (const f of DOCS) {
  const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/手順\s*の?\s*[0-9]+\s*(.)?/g)) if (m[1] !== "回") stepRefs.add(`${f}:${i + 1}`);
  });
}

// ---------- ハーネスの防御が配線されているか ----------
//   規約「ゲートの判定材料をワーカーに触らせない」が実装から消えていないかを見る
const harness = readFileSync(join(ROOT, "harness/integrated.mjs"), "utf8");
const wiring = {
  "勝手なコミットの取り消し": /await undoWorkerCommits\(w, headBefore[12], log\)/g,
  "作業領域の外を戻す": /await revertOutsideWork\(w, log\)/g,
  "タスクの状態を戻す": /await restoreTasksChangedBy\(w, tasksBefore[12], log, task\.id\)/g,
};
//   ワーカーは1タスクにつき2回 呼ばれる（テストを書かせる時と実装を書かせる時）ので、
//   防御はその両方の直後に要る ── 片方だけだともう片方の呼び出しが無防備になる
const CALLS_PER_TASK = 2;
const unwired = Object.entries(wiring)
  .filter(([, re]) => (harness.match(re) || []).length !== CALLS_PER_TASK)
  .map(([k]) => k);
check(`ハーネスの防御が${CALLS_PER_TASK}箇所とも配線されているか`, unwired.length === 0, unwired.join(", "));
check("凍結が tests/ 全部を対象にしているか", /const frozen = Object\.fromEntries\(\(await allTests\(w\)\)/.test(harness));
check("変異チェックの無視の印を検出しているか", /await addedIgnoreMarks\(w, srcFiles\)/.test(harness));

// proof/ の昇格前の実証コード ── 当時の書き方をそのまま残す記録なので、用語と記号の検査から外す
//   proof/README.md の段階の表に step0〜3-e として並んでいる（実装は harness/integrated.mjs へ昇格済み）
//   stub-worker*.mjs と new-sandbox.mjs は今も回す道具なので含めない
const LEGACY_PROOF = /^proof\/(harness[0-9]*|integrate|integrated-real|selfcheck)\.mjs$/;

// ---------- 評価の記号と絵文字を使っていないか（ドキュメントもコードも）----------
//   英語圏では ○ は「ゼロ」・× は「掛ける」に読まれ、良し悪しが逆に伝わる
//   絵文字は指し先が消えても気づけない（実際に起きた: 本文の「表の 🟡」が指す記号が表に無かった）
//   ◎ ○ △ は評価にしか使わないので常に落とす、× は掛け算にも使うので
//   「表のセルに単独で置いた ×」と「箇条書きの先頭の ×」だけを落とす
//   除外は3ファイルだけ ── 規約を書いた2つと、この検査自身（禁止する記号を例として書く必要がある）
//   行の文言で除外すると、たまたまその語を含む本物の違反まで見逃す
//   除外は検査ごとに分ける ── 記号用の除外を他の検査へ流用すると、そのファイルが丸ごと素通りする（実際に起きた）
//   除外＝「禁止対象そのものを書かないと説明できない」文書（規約・レビュー手順・この検査自身）
const MARK_EXEMPT = (f) =>
  f === "CLAUDE.md" || f === ".claude/scripts/inspect.mjs" ||
  /^\.claude\/(rules|skills)\//.test(f);
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{2705}\u{274C}\u{2714}\u{2716}\u{FE0F}]/u;
// チェックマーク類（✓ ✔ ✕ ✖ ✗ ● ▲ ★ ☆）── 合否を記号で示さず言葉で書く
//   実際に起きた: ハーネスの合格ログが `✓ 合格` のままだった、絵文字の一覧に ✔(2714) はあったが ✓(2713) が無く素通りした
//   インラインコードの中だけは見ない ── ツールの画面出力をそのまま貼った所は、書き換えると実物と食い違う
const VERDICT_MARK = /[\u{2713}\u{2714}\u{2715}\u{2716}\u{2717}\u{25CF}\u{25B2}\u{2605}\u{2606}]/u;
const SCANNED = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean)
  .filter((f) => !GENERATED.test(f) && !/package-lock\.json$|^LICENSE$/.test(f));
const marks = [];
let markScanned = 0;
for (const f of SCANNED) {
  if (MARK_EXEMPT(f)) continue;
  markScanned++;
  const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
  lines.forEach((l, i) => {
    const bare = l.replace(/`[^`\n]*`/g, "");                          // 画面出力の写しを外す
    const verdict = !LEGACY_PROOF.test(f) && VERDICT_MARK.test(bare);   // 昇格前コードは当時の出力のまま残す
    if (EMOJI.test(l) || /[◎○△]/.test(l) || /\|\s*×|×\s*\||^\s*[-*]\s*×/.test(l) || verdict) marks.push(`${f}:${i + 1}`);
  });
}
check(`評価の記号（◎○△×✓）と絵文字が無いか（${markScanned}ファイル・掛け算の × は可）`, marks.length === 0, marks.join(", "));

// ---------- 「機械」を主語にしていないか ----------
//   1語で3つの別物（合否を出すもの／手順を進めるもの／人が判断しないという性質）を指していて、
//   しかもどこにも定義が無かった ── 読者が「機械って何？ AI じゃないの？」で止まった（実際に起きた）
//   → 合否は「ゲート」か実物名（`npm test`・Stryker）、進めるのは「ハーネス」、性質は「自動で」と書く
//   副詞の「機械的」と定型の「機械可読」は日本語として正しいので残す
//   この検査自身は 禁止する語を書く必要があるので対象外（記号の除外とは別に持つ）
//   規約とレビュー手順は「『機械』を主語にするな」を説明するために その語を書く必要がある＝除外
const KIKAI_EXEMPT = (f) =>
  LEGACY_PROOF.test(f) ||
  f === ".claude/scripts/inspect.mjs" || /^\.claude\/(rules|skills)\//.test(f);
const kikai = [];
for (const f of SCANNED) {
  if (KIKAI_EXEMPT(f)) continue;
  const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/機械(的|可読)?/g)) if (!m[1]) kikai.push(`${f}:${i + 1}`);
  });
}
check("「機械」を主語にしていないか（機械的・機械可読は可）", kikai.length === 0, kikai.join(", "));

// ---------- 実験の置き場所を指す語が統一されているか ----------
//   種類だけ言って場所を言わない語は、リポジトリの中でも外でも通ってしまう
//   実際に起きた: 同じものを「実験リポジトリ」「検証用リポジトリ」「使い捨てリポジトリ」「外の作業場所」の
//     4種類で呼んでいて24箇所に割れていた、しかも20箇所は場所が書かれていなかった
//   正しくは2つだけ ── 置き場所は `<リポジトリ外>`、そこに作るものは `リポジトリ外の検証用リポジトリ`
//   `検証用` 単体（`検証用のスタブ`・`制御フロー検証用`）は別の意味なので拾わない
//   この検査自身は 禁止する語を書く必要があるので対象外、規約は禁止語を書かず この検査を指している
const PLACE_BAN = /外の作業場所|実験リポジトリ|使い捨て(の)?リポジトリ|(?<!リポジトリ外の)検証用(の)?リポジトリ/g;
const place = [];
for (const f of SCANNED) {
  if (f === ".claude/scripts/inspect.mjs" || LEGACY_PROOF.test(f)) continue;
  readFileSync(join(ROOT, f), "utf8").split("\n").forEach((l, i) => {
    for (const m of l.matchAll(PLACE_BAN)) place.push(`${f}:${i + 1}（${m[0]}）`);
  });
}
check("実験の置き場所を指す語が統一されているか", place.length === 0, place.join(", "));

// ---------- README のツリーと実物の過不足 ----------
// なぜ要るか: ツリーは「リポジトリに何があるか」の一覧なので、足したファイルが載らないと
//   読者はその存在を知れない（実際に起きた: MAINTAINING.md がツリーに無く、6周のレビューで気づけなかった）
//   トップレベルだけ見る（下の階層は代表を載せる方針なので過不足を機械で決められない）
const treeBlock = (readFileSync(join(ROOT, "README.md"), "utf8").match(/```\nloop-engineering-playbook\/\n([\s\S]*?)```/) || [])[1] || "";
const treeTop = new Set(
  treeBlock.split("\n")
    .filter((l) => /^[├└]/.test(l))                      // トップレベルの行だけ（ネストは `│` で始まる）
    .map((l) => (l.match(/^[├└]─\s+(\S+)/) || [])[1])
    .filter(Boolean).map((s) => s.replace(/\/$/, "")),
);
const realTop = new Set(
  execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean)
    .map((f) => f.split("/")[0])
    .filter((f) => f !== ".gitignore"),   // .gitignore だけツリーに載せない（前方一致で除くと .github まで消える）
);
const treeGap = [
  ...[...realTop].filter((f) => !treeTop.has(f)).map((f) => `ツリーに無い: ${f}`),
  ...[...treeTop].filter((f) => !realTop.has(f)).map((f) => `実物に無い: ${f}`),
];
check("README のツリーが実物と過不足なく合っているか", treeGap.length === 0, treeGap.join(" / "));

// ---------- 「<ファイル> N行」が実物と一致するか ----------
// なぜ要るか: ファイルを1行 足すだけで黙って腐る（実際に起きた: 変異器を編集した日に 102行 の記述が残っていた）
//   拾うのは「パスらしき語 …… N行」が同じ行にある所だけ
//   掴むのはリンクの飛び先か バッククォートのパス（リンクのテキストを掴むと ROOT 直下を探して常に空振りする）
//   照合した件数を名前に出す ── 0件なら検査が効いていないと分かる（黙って通す検査は無いのと同じ）
const lineClaims = [];
let lineChecked = 0;
for (const f of DOCS) {
  const dir = dirname(join(ROOT, f));
  readFileSync(join(ROOT, f), "utf8").split("\n").forEach((l, i) => {
    for (const m of l.matchAll(/(?:\]\(([^)]+)\)|`([^`]+)`)[^`\n]{0,20}?(\d+)行/g)) {
      const rel = (m[1] || m[2]).split("#")[0];
      if (!/\.(mjs|js|ts|py|json|md)$/.test(rel)) continue;
      const p = join(dir, rel);
      if (!existsSync(p)) continue;                       // 実在しない綴りは相対リンクの検査の仕事
      lineChecked++;
      const real = readFileSync(p, "utf8").split("\n").length - 1;
      if (real !== Number(m[3])) lineClaims.push(`${f}:${i + 1} ${rel} は ${m[3]}行 と書いてあるが実物は ${real}行`);
    }
  });
}
check(`「<ファイル> N行」が実物と一致するか（${lineChecked}件 照合）`, lineClaims.length === 0, lineClaims.join(" / "));

// ---------- 結果 ----------
console.log(`--  他のファイルの手順番号を指していないか（自動では決められないので目で見る・${stepRefs.size}件）`);
if (stepRefs.size) console.log(`      ${[...stepRefs].join(", ")}`);
let ng = 0;
for (const r of results) {
  console.log(`${r.ok ? "OK  " : "NG  "}${r.name}${r.ok || !r.detail ? "" : `\n      ${r.detail}`}`);
  if (!r.ok) ng++;
}
console.log(ng === 0 ? `\n全${results.length}項目 合格` : `\n${ng}/${results.length} 項目が不合格`);
process.exit(ng === 0 ? 0 : 1);
