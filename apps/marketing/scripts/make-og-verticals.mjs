// Renders the five per-vertical OG images (1200x630 PNG, <300 KB) for /for/<vertical>/ from the real demo-store
// look photos (public/looks/img, CC0, see public/demo/CREDITS.md), on the same light canvas as og.png.
// The Arabic headline is each vertical's own h1 (src/lib/verticals.ts), so the card never says more than the page.
//   node apps/marketing/scripts/make-og-verticals.mjs   (from the repo root; Chromium + network for the Cairo font)
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const req = createRequire(path.join(root, 'noop.js'));
const { chromium } = req('@playwright/test');
const sharp = req('sharp');
const out = path.join(here, '..', 'public', 'og');
mkdirSync(out, { recursive: true });

const PHOTOS = {
  fashion: ['qa__hero', 'qb__dress', 'qc__window'],
  electronics: ['sa__laptop', 'sa__headphones', 'sc__watch'],
  beauty: ['ja__hero', 'jb__hero', 'jc__hero'],
  food: ['la__hero', 'lb__feteer', 'lc__tomatoes'],
  jewellery: ['da__hero', 'db__hero', 'dc__hero'],
};
const src = readFileSync(path.join(here, '..', 'src', 'lib', 'verticals.ts'), 'utf8');
const h1 = slug => {
  const block = src.slice(src.indexOf(`  ${slug}: {`));
  return block.match(/ar: \{\s*h1: '([^']+)'/)[1];
};
const lockup = readFileSync(path.join(root, 'brand/logo/svg/04a-product-store.svg'), 'utf8');
const lockupUri = 'data:image/svg+xml;base64,' + Buffer.from(lockup).toString('base64');
const uri = f =>
  'data:image/webp;base64,' +
  readFileSync(path.join(here, '..', 'public', 'looks', 'img', f + '.webp')).toString('base64');

const html = (slug, photos) => `<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@700&display=block" rel="stylesheet">
<style>
  *{margin:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:#FAFAFA;position:relative;overflow:hidden;font-family:'Cairo',sans-serif}
  .lock{position:absolute;right:56px;bottom:88px;height:118px}
  .h{position:absolute;right:72px;top:104px;width:540px;direction:rtl;text-align:right;color:#121314;font-weight:700;font-size:58px;line-height:1.5;text-wrap:balance}
  .rule{position:absolute;right:72px;top:70px;width:96px;height:4px;background:#B08D57}
  .url{position:absolute;right:72px;bottom:44px;direction:ltr;color:#4A4338;font-size:22px;font-weight:700;letter-spacing:.2px}
  .ph{position:absolute;width:168px;height:356px;border-radius:34px;background:#1C1C1E;padding:3px;box-shadow:0 14px 28px rgba(18,19,20,.12);outline:1px solid rgba(176,141,87,.45)}
  .ph div{width:100%;height:100%;border-radius:30px;background-size:cover;background-position:center}
</style>
<div class="rule"></div><div class="h">${h1(slug)}</div>
${photos.map((p, i) => `<div class="ph" style="left:${60 + i * 192}px;top:${i === 1 ? 56 : 138}px"><div style="background-image:url(${uri(p)})"></div></div>`).join('')}
<img class="lock" src="${lockupUri}" alt="">
<div class="url">ebda.app/for/${slug}</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const [slug, photos] of Object.entries(PHOTOS)) {
  await page.setContent(html(slug, photos), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.load('700 58px Cairo'));
  const png = await page.screenshot();
  const file = path.join(out, `${slug}.png`);
  await sharp(png)
    .png({ palette: true, quality: 90, effort: 10, colours: 128, dither: 0.6 })
    .toFile(file);
  console.log(slug, Math.round(statSync(file).size / 1024) + ' KB');
}
await browser.close();
