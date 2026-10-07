// Renders the live three.js ring (from the built site) to transparent stills, one per
// metal x stone, for the poster shown before WebGL loads and for reduced motion.
//   BASE=http://localhost:3006 node scripts/ring/make-posters.mjs   (run from the repo root)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(path.join(process.cwd(), 'noop.js'))('@playwright/test');
const sharp = createRequire(path.join(process.cwd(), 'noop.js'))('sharp');
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'ring');
mkdirSync(out, { recursive: true });
const BASE = process.env.BASE || 'http://localhost:3006';

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1.5 });
await p.goto(BASE + '/', { waitUntil: 'networkidle' });
await p.evaluate(() => document.getElementById('dahab').scrollIntoView({ block: 'center' }));
await p.waitForSelector('.ring-stage[data-live]', { timeout: 60_000 });
// Only the canvas is painted: transparent page, every other element hidden.
await p.addStyleTag({
  content: `html,body,.dahab,main{background:transparent!important}
  body *:not(:has(.ring-canvas)):not(.ring-canvas){visibility:hidden!important}
  .ring-canvas{visibility:visible!important;opacity:1!important}
  .ring-poster{display:none!important}`,
});
for (const metal of ['gold', 'white', 'rose']) {
  for (const stone of ['diamond', 'emerald', 'ruby']) {
    await p.evaluate(
      ([m, s]) => {
        document.querySelector(`.swatch[data-metal="${m}"]`).click();
        document.querySelector(`.swatch[data-stone="${s}"]`).click();
      },
      [metal, stone]
    );
    await p.waitForTimeout(700);
    const png = await p.locator('.ring-canvas').screenshot({ omitBackground: true });
    const img = sharp(png).resize(900, 900, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
    await img
      .clone()
      .webp({ quality: 82, alphaQuality: 90 })
      .toFile(path.join(out, `ring-${metal}-${stone}.webp`));
    await img
      .clone()
      .avif({ quality: 55 })
      .toFile(path.join(out, `ring-${metal}-${stone}.avif`));
    console.log('poster', metal, stone);
  }
}
await b.close();
