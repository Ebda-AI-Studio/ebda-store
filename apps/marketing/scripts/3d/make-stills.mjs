// Renders the live 3D viewer (from the built site) to transparent stills: one per sneaker
// colourway and one for the lantern. They are the poster shown before the model loads and the
// whole picture for reduced motion, Save-Data and no-WebGL visitors.
//   npm run build -w apps/marketing && npm run start -w apps/marketing   (serves out/ on :3005)
//   BASE=http://localhost:3005 node apps/marketing/scripts/3d/make-stills.mjs   (from the repo root)
// CHROME_PATH points at a Chrome/Chromium binary when Playwright's own browser is not installed.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const req = createRequire(path.join(process.cwd(), 'noop.js'));
const { chromium } = req('@playwright/test');
const sharp = req('sharp');
const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
  '3d',
  'stills'
);
mkdirSync(out, { recursive: true });
const BASE = process.env.BASE || 'http://localhost:3005';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
// Reduced motion: no idle spin, so every still is the same deterministic three-quarter view.
const ctx = await browser.newContext({
  viewport: { width: 1100, height: 1000 },
  deviceScaleFactor: 2,
  reducedMotion: 'reduce',
});
const page = await ctx.newPage();
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('model3d').scrollIntoView({ block: 'center' }));
await page.click('.m3d-load');
await page.waitForSelector('.m3d-media[data-ready]', { timeout: 60_000 });
// Only the canvas is painted: transparent page, every other element hidden.
await page.addStyleTag({
  content: `html,body,.m3d-media,.m3d-screen,.m3d-phone{background:transparent!important;box-shadow:none!important}
  body *{visibility:hidden!important}
  .m3d canvas{visibility:visible!important}`,
});

async function shoot(name) {
  const png = await page.locator('.m3d canvas').screenshot({ omitBackground: true });
  const img = sharp(png).resize(720, 720, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  await img
    .clone()
    .webp({ quality: 84, alphaQuality: 90 })
    .toFile(path.join(out, `${name}.webp`));
  await img
    .clone()
    .avif({ quality: 58 })
    .toFile(path.join(out, `${name}.avif`));
  console.log('still', name);
}

for (const v of ['midnight', 'beach', 'street']) {
  await page.evaluate(id => {
    const i = ['midnight', 'beach', 'street'].indexOf(id);
    document.querySelectorAll('.m3d-swatch')[i].click();
  }, v);
  await page.waitForTimeout(900);
  await shoot(`qamar-${v}`);
}
await page.evaluate(() => document.getElementById('m3d-tab-souq').click());
await page.waitForTimeout(400); // the chip drops data-ready; the new model sets it again on load
await page.waitForSelector('.m3d-media[data-ready]', { state: 'attached', timeout: 60_000 });
await page.waitForTimeout(900);
await shoot('lantern');
await page.evaluate(() => document.getElementById('m3d-tab-lamma').click());
await page.waitForTimeout(400);
await page.waitForSelector('.m3d-media[data-ready]', { state: 'attached', timeout: 60_000 });
await page.waitForTimeout(900);
await shoot('clay-pot');
await browser.close();
