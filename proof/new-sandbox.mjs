// new-sandbox.mjs — ハーネスが回せる状態の空のリポジトリを1コマンドで作る（検証用）
//
// なぜ要るか:
//   回帰（MAINTAINING.md）と 迂回6通り・並列の再検証（proof/README.md）は、毎回まっさらなリポジトリが要る
//   自前で用意するとセットアップ10手順を踏むことになるので、それを1コマンドに畳んでいる
//   導入する側は使わない（読者向けの手順は ../README.md のセットアップ）
//
// 使い方:
//   node proof/new-sandbox.mjs <作る場所>        例: node proof/new-sandbox.mjs ../sandbox
//   作った後は  BASE=<作る場所> node harness/integrated.mjs  で回す
//
// 作るもの ── ../README.md の導入先の要件を全部 満たした最小のリポジトリ
//   package.json          {"type": "module", "scripts": {"test": "vitest run"}}
//   src/health.js         関数1個
//   tests/health.test.js  それを検証するテスト1本
//   stryker.config.json   ../harness/ からコピー
//   ＋ 依存（Vitest・Stryker）を入れて git init し、緑のベースをコミットして bd init まで
//
// 前提: Node.js 20 以上（Vitest と Stryker の要求）・npm・git・beads（`bd`）

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// 子プロセスへ渡すパスは絶対パスに直し、Windows のドライブレターは大文字に揃える
//   小文字（c:\...）のままだと Vitest がモジュールを二重に解決してテストを1つも収集できない
const norm = (p) => {
  const a = resolve(p);
  return /^[a-z]:/.test(a) ? a[0].toUpperCase() + a.slice(1) : a;
};
const dest = norm(process.argv[2] || "../sandbox");
const WIN = process.platform === "win32";

// npm/bd/npx は Windows では .cmd シム＝shell 必須、git は .exe＝shell 不要
//   （shell:true は引数を自動クォートしないので、日本語や空白入りの引数が壊れる）
const SHIM = new Set(["npm", "bd", "npx"]);
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: dest, stdio: "inherit", shell: WIN && SHIM.has(cmd) });
  if (r.error || r.status !== 0) {
    console.error(`\nリポジトリ外の検証用リポジトリの作成に失敗`);
    console.error(`  実行できなかったコマンド: ${cmd} ${args.join(" ")}${r.error ? `  (${r.error.message})` : ""}`);
    console.error(`  Node.js 20 以上・npm・git・beads（bd）がインストールされているか確認してください`);
    console.error(`  作成途中の ${dest} が残っています。削除してから再実行してください`);
    process.exit(1);
  }
};

if (existsSync(dest)) {
  console.error(`リポジトリ外の検証用リポジトリの作成に失敗`);
  console.error(`  指定されたパス: ${dest}`);
  console.error(`  このパスには既にファイルがあります。空のパスを指定するか、削除してから再実行してください`);
  console.error(`  （このスクリプトは新規作成のみを行い、既存のファイルは削除しません）`);
  process.exit(1);
}

console.log(`リポジトリ外の検証用リポジトリを作成: ${dest}\n`);
mkdirSync(resolve(dest, "src"), { recursive: true });
mkdirSync(resolve(dest, "tests"), { recursive: true });

writeFileSync(
  resolve(dest, "package.json"),
  JSON.stringify({ name: "lep-sandbox", version: "0.0.0", private: true, type: "module", scripts: { test: "vitest run" } }, null, 2) + "\n",
);
writeFileSync(resolve(dest, ".gitignore"), "node_modules/\nreports/\n.stryker-tmp/\n*.log\n");
writeFileSync(resolve(dest, "src/health.js"), 'export const health = () => "ok";\n');
writeFileSync(
  resolve(dest, "tests/health.test.js"),
  'import { test, expect } from "vitest";\nimport { health } from "../src/health.js";\ntest("health は ok を返す", () => expect(health()).toBe("ok"));\n',
);
// 変異チェック用の Stryker 設定はハーネスのものを流用（このファイルは proof/ にある）
copyFileSync(resolve(here, "../harness/stryker.config.json"), resolve(dest, "stryker.config.json"));

console.log("依存をインストール（Vitest / Stryker）\n");
// 版は実証に使ったもので固定（ツールの自動更新で挙動が変わる事故を避ける）
run("npm", ["install", "-D", "vitest@4.1.10", "@stryker-mutator/core@9.6.1", "@stryker-mutator/vitest-runner@9.6.1"]);

console.log("\ngit を初期化し、全テストが通る状態をコミット\n");
run("git", ["init", "-q"]);
run("git", ["config", "user.name", "sandbox"]);
run("git", ["config", "user.email", "sandbox@example.com"]);
run("git", ["config", "core.longpaths", "true"]);
run("git", ["add", "-A"]);
run("git", ["commit", "-q", "-m", "init: 緑のベース（ESM＋vitest＋Stryker）"]);

console.log("\nbeads（タスク管理）を初期化\n");
run("bd", ["init"]);

console.log(`\n作成完了: ${dest}`);
console.log(`  次のコマンドで実行できます（claude の呼び出しに課金されます）`);
console.log(`  BASE=${process.argv[2] || "../sandbox"} node harness/integrated.mjs`);
