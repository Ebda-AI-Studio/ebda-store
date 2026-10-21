// Real captures of the live Qamar showroom (storedemo.ebda.app) for the #looks section (Ruling TPL-4).
//   node scripts/looks/live-shots.mjs [baseUrl]
// Writes public/looks/live/qamar-<atelier|lookbook|vitrine>-<ar|en>-780.{webp,avif}: the first screen
// at 390x844 @2x, kept at 780 px wide (2x). Needs Google Chrome + network. Nothing is clicked or typed:
// the demo bar and the cookie banner are hidden with a style rule (display only), so no consent is
// recorded and the page reads as a merchant's store does.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const base = (process.argv[2] ?? 'https://storedemo.ebda.app').replace(/\/$/, '');
const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
  'looks',
  'live'
);
mkdirSync(out, { recursive: true });

const LOOKS = ['atelier', 'lookbook', 'vitrine'];
const LANGS = ['ar', 'en'];
const HIDE =
  '[data-demo-look-bar], [aria-labelledby="cookie-banner-title"] { display: none !important; }';

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const lang of LANGS) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      locale: lang === 'ar' ? 'ar-EG' : 'en-US',
      reducedMotion: 'reduce',
    });
    await ctx.addCookies([{ name: 'force-language', value: lang, url: base }]);
    for (const look of LOOKS) {
      const page = await ctx.newPage();
      await page.goto(`${base}/?look=qamar.${look}`, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: HIDE });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1500);
      const shot = await page.screenshot({ type: 'png' });
      const img = sharp(shot);
      const stem = path.join(out, `qamar-${look}-${lang}-780`);
      await img.clone().webp({ quality: 74, effort: 6 }).toFile(`${stem}.webp`);
      await img.clone().avif({ quality: 50, effort: 6 }).toFile(`${stem}.avif`);
      await page.close();
      console.log('wrote', path.basename(stem));
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
