#!/usr/bin/env node
// Review captures of the Dahab demo store: home, collection, product, cart at
// 390 (DPR 3), 820 (DPR 2) and 1440 (DPR 2), Arabic and English.
//   BASE=https://dahab-preview.ebda.app OUT=<dir> node scripts/dahab-demo/capture.mjs
//   (local: BASE=http://dahab-preview.ebda.app:3071 MAP=127.0.0.1 — maps the host to loopback)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'https://dahab-preview.ebda.app';
const OUT = process.env.OUT ?? 'dahab-captures';
const ONLY = process.env.ONLY?.split(',');
mkdirSync(OUT, { recursive: true });
const host = new URL(BASE).hostname;
const browser = await chromium.launch({
  args: [
    ...(process.env.MAP
      ? [`--host-resolver-rules=MAP ${host} ${process.env.MAP}`, '--disable-web-security']
      : []),
  ],
});
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, dpr: 3, mobile: true },
  { name: '820', width: 820, height: 1180, dpr: 2, mobile: true },
  { name: '1440', width: 1440, height: 900, dpr: 2, mobile: false },
];
const PAGES = [
  { name: 'home', path: '/' },
  { name: 'collection', path: '/products?category=necklaces' },
  { name: 'pdp', path: '/products/solitaire-ring' },
  { name: 'cart', path: '/cart', addFirst: '/products/drop-earrings' },
];
const report = [];
for (const lang of ['ar', 'en']) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dpr,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      locale: lang === 'ar' ? 'ar-EG' : 'en-US',
    });
    await ctx.addCookies([
      { name: 'force-language', value: lang, url: BASE },
      // Consent already given, so the banner does not cover the pages under review.
      {
        name: 'force-cookie-consent',
        value: encodeURIComponent(
          JSON.stringify({ marketing: false, v: 1, ts: '2026-10-07T00:00:00Z' })
        ),
        url: BASE,
      },
    ]);
    const page = await ctx.newPage();
    for (const pg of PAGES) {
      if (ONLY && !ONLY.includes(pg.name)) continue;
      if (pg.addFirst) {
        // The preview can be cold (scale-to-zero database): retry the product page.
        for (let attempt = 1; attempt <= 3; attempt++) {
          await page.goto(BASE + pg.addFirst, { waitUntil: 'load', timeout: 90_000 });
          const add = page
            .getByRole('button', {
              name: lang === 'ar' ? 'إضافة للسلة' : 'Add to bag',
              exact: true,
            })
            .first();
          if (await add.isVisible({ timeout: 20_000 }).catch(() => false)) {
            await add.click();
            await page.waitForTimeout(1500);
            await page.keyboard.press('Escape');
            break;
          }
        }
      }
      await page.goto(BASE + pg.path, { waitUntil: 'load', timeout: 90_000 });
      // Walk the page so lazy images load, then return to the top.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 500) {
          window.scrollTo(0, y);
          await new Promise(r => setTimeout(r, 120));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(2500);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      const file = `${OUT}/${pg.name}-${lang}-${vp.name}.png`;
      await page.screenshot({ path: file, fullPage: true });
      report.push({ page: pg.name, lang, viewport: vp.name, horizontalOverflowPx: overflow });
    }
    await ctx.close();
  }
}
await browser.close();
console.log(JSON.stringify(report));
