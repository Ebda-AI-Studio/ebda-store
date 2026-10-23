// Real captures of the live demo stores (all five demo stores) for the #looks
// section (Ruling TPL-4).
//   node scripts/looks/live-shots.mjs [qamar,souq,jasmine,lamma,dahab]     (default: all; DEMO_APEX overrides ebda.app)
// Writes public/looks/live/<template>-<look>-<ar|en>-780.{webp,avif}: the first screen
// at 390x844 @2x, kept at 780 px wide (2x). Needs Google Chrome + network. Nothing is clicked or typed:
// the demo bar and the cookie banner are hidden with a style rule (display only), so no consent is
// recorded and the page reads as a merchant's store does.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

// Template -> demo store host label and look ids; keep in step with DEMO_STORES in src/lib/site.ts.
const STORES = {
  qamar: { host: 'storedemo', looks: ['atelier', 'lookbook', 'vitrine'] },
  souq: { host: 'storedemo-souq', looks: ['catalogue', 'night', 'showroom'] },
  jasmine: { host: 'storedemo-jasmine', looks: ['apothecary', 'bloom', 'clinic'] },
  lamma: { host: 'storedemo-lamma', looks: ['table', 'notebook', 'market'] },
  dahab: { host: 'storedemo-dahab', looks: ['worn', 'workshop', 'giftbox'] },
};
const only = process.argv[2] ? process.argv[2].split(',') : Object.keys(STORES);
const apex = process.env.DEMO_APEX ?? 'ebda.app';
const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
  'looks',
  'live'
);
mkdirSync(out, { recursive: true });

const LANGS = ['ar', 'en'];
const HIDE =
  '[data-demo-look-bar], [aria-labelledby="cookie-banner-title"] { display: none !important; }';

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const tpl of only) {
    const { host, looks } = STORES[tpl];
    const base = `https://${host}.${apex}`;
    for (const lang of LANGS) {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        locale: lang === 'ar' ? 'ar-EG' : 'en-US',
        reducedMotion: 'reduce',
      });
      await ctx.addCookies([{ name: 'force-language', value: lang, url: base }]);
      for (const look of looks) {
        const page = await ctx.newPage();
        await page.goto(`${base}/?look=${tpl}.${look}`, { waitUntil: 'load', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await page.addStyleTag({ content: HIDE });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(1500);
        const shot = await page.screenshot({ type: 'png' });
        const img = sharp(shot);
        const stem = path.join(out, `${tpl}-${look}-${lang}-780`);
        await img.clone().webp({ quality: 74, effort: 6 }).toFile(`${stem}.webp`);
        await img.clone().avif({ quality: 50, effort: 6 }).toFile(`${stem}.avif`);
        await page.close();
        console.log('wrote', path.basename(stem));
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
