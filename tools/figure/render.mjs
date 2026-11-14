// 図の HTML の <div class="page"> を、2倍の解像度の PNG に描き出す
//   cd tools/figure && npm install && npx playwright install chromium   （初回だけ）
//   node tools/figure/render.mjs figures/loop-dark.html figures/loop-dark.png
//
// Noto Sans JP（500・700・900）が読み込めなかった時は PNG を書かずに exit 1
//   読み込めないまま描き出すと代わりの書体で文字幅が変わり、文字と線が重なっても気づけない
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const [htmlArg, pngArg] = process.argv.slice(2);
if (!htmlArg || !pngArg) {
  console.error("使い方: node tools/figure/render.mjs <html> <png>");
  process.exit(1);
}
const html = path.resolve(htmlArg);
const png = path.resolve(pngArg);
console.log(`元: ${html}`);
console.log(`出力: ${png}`);
if (!existsSync(html)) {
  console.error("元の HTML が見つからない");
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1600 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(html).href, { waitUntil: "networkidle" });
  // 書体は図の本体がある文書で確かめる ── iframe で別の HTML を読み込む図（ogp.html）は、外側の文書に書体の宣言が無い
  //   宣言の無い書体は document.fonts.check が常に true を返すので、外側だけ見ると素通りする
  const frame = page.frames().find((f) => f !== page.mainFrame()) ?? page.mainFrame();
  await frame.evaluate(() => document.fonts.ready);
  const fonts = await frame.evaluate(() => {
    const declared = [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Noto Sans JP");
    return [500, 700, 900].map((w) => declared && document.fonts.check(`${w} 20px "Noto Sans JP"`));
  });
  console.log(`Noto Sans JP 500/700/900: ${fonts.join(" / ")}`);
  if (fonts.includes(false)) {
    console.error("書体が読み込めていないので描き出さない（ネットワークと HTML の <link> を確かめる）");
    process.exitCode = 1;
  } else {
    const el = page.locator(".page");
    if ((await el.count()) !== 1) {
      console.error('<div class="page"> が1つだけある HTML ではない');
      process.exitCode = 1;
    } else {
      const box = await el.boundingBox();
      await el.screenshot({ path: png });
      console.log(`大きさ: ${Math.round(box.width)} x ${Math.round(box.height)}（PNG はこの2倍）`);
    }
  }
} finally {
  await browser.close();
}
