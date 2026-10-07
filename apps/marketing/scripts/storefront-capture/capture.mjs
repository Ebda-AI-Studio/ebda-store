// Captures the REAL apps/web storefront (the five seeded example stores) at true device
// viewports, for the device frames on ebda.app. Raw PNGs go to <outDir>; encode.mjs turns
// them into the AVIF/WebP files in public/devices/.
//
//   WEB=http://127.0.0.1:3060 API=http://localhost:4861 IMG_DIR=<prepare-images out> \
//     node capture.mjs <outDir> [ids...]          (run from an ebda checkout with node_modules)
//
// apps/web runs as a PRODUCTION build (`next build && next start`) so its middleware resolves
// the store from the Host exactly as on Cloudflare. The browser asks for the real store URL
// (https://<slug>.ebda.app/); every request to it is answered by the local server with that
// Host. Photos (https://cdn.ebda.app/capture-demo/*) come from IMG_DIR and API calls from
// the local API, so the capture never touches production.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Resolved from the working directory (run it from an ebda checkout with node_modules).
const { chromium } = createRequire(path.join(process.cwd(), 'noop.js'))('@playwright/test');

const WEB = process.env.WEB || 'http://127.0.0.1:3060';
const API = process.env.API || 'http://localhost:4861';
const IMG_DIR = process.env.IMG_DIR;
if (!IMG_DIR) throw new Error('set IMG_DIR (prepare-images.mjs output)');
const out = process.argv[2];
const ids = process.argv.slice(3).length ? process.argv.slice(3) : ['dahab'];
mkdirSync(out, { recursive: true });

/** CSS viewport + DPR of each device, as a real screenshot would be taken. */
export const DEVICES = {
  phone: { width: 390, height: 844, dpr: 3, mobile: true },
  tablet: { width: 820, height: 1180, dpr: 2, mobile: true },
  laptop: { width: 1440, height: 900, dpr: 2, mobile: false },
};
// Arabic only: the storefront is Arabic-first and the device mocks show it on both locales of
// ebda.app (the English storefront switch is a visitor choice, not the default).
const LOCALES = (process.env.LOCALES || 'ar').split(',');

const meta = {};
const browser = await chromium.launch();
for (const id of ids) {
  for (const locale of LOCALES) {
    for (const [dev, v] of Object.entries(DEVICES)) {
      const ctx = await browser.newContext({
        viewport: { width: v.width, height: v.height },
        deviceScaleFactor: v.dpr,
        isMobile: v.mobile,
        hasTouch: v.mobile,
        locale: locale === 'ar' ? 'ar-EG' : 'en-US',
      });
      const host = `${id}-demo.ebda.app`;
      await ctx.route(`https://${host}/**`, async route => {
        const u = new URL(route.request().url());
        const resp = await route.fetch({
          url: WEB + u.pathname + u.search,
          headers: { ...route.request().headers(), host },
        });
        await route.fulfill({ response: resp });
      });
      await ctx.route('https://cdn.ebda.app/capture-demo/**', route =>
        route.fulfill({
          contentType: 'image/jpeg',
          body: readFileSync(
            path.join(IMG_DIR, path.basename(new URL(route.request().url()).pathname))
          ),
        })
      );
      await ctx.route(`${API}/**`, async route => route.fulfill({ response: await route.fetch() }));
      for (const name of ['NEXT_LOCALE', 'language', 'lang'])
        await ctx.addCookies([{ name, value: locale, url: `https://${id}-demo.ebda.app` }]);
      const page = await ctx.newPage();
      await page.goto(`https://${id}-demo.ebda.app/`, {
        waitUntil: 'networkidle',
        timeout: 120_000,
      });
      // The storefront reloads itself once after hydration (locale/store sync); let it settle.
      await page.waitForTimeout(4000);
      await page.waitForLoadState('networkidle');
      // Dismiss a cookie/consent prompt the way a returning visitor would have.
      for (const sel of [
        'button:has-text("قبول")',
        'button:has-text("Accept")',
        'button:has-text("موافق")',
      ]) {
        const b = page.locator(sel).first();
        if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
      }
      // Scroll through once so lazy images load, then back to the top.
      // The storefront may reload itself once after hydration; wait until the document is stable.
      let H = 0;
      for (let tries = 0; tries < 10 && !H; tries++) {
        await page.waitForLoadState('networkidle').catch(() => {});
        H = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
        if (!H) await page.waitForTimeout(1000);
      }
      for (let y = 0; y < H; y += v.height / 2) {
        await page.evaluate(y => window.scrollTo(0, y), y).catch(() => {});
        await page.waitForTimeout(120);
      }
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForLoadState('networkidle');
      // Every image in view must be decoded before the shot (no half-loaded tiles).
      await page
        .waitForFunction(
          () =>
            [...document.images]
              .filter(i => i.getBoundingClientRect().top < innerHeight * 6)
              .every(i => i.complete && i.naturalWidth > 0),
          null,
          { timeout: 20_000 }
        )
        .catch(() => console.warn('  some images did not finish loading'));
      await page.waitForTimeout(800);
      const base = `${out}/${id}-${locale}-${dev}`;
      await page.screenshot({ path: `${base}.png` });
      if (dev === 'phone') {
        // Full-page strip for the scroll story: the fixed bottom tab bar would be painted in the
        // middle of a full-page shot, so hide it there and record its height; the frame overlays
        // the bar (cropped from the viewport shot) at the bottom of the phone instead.
        const barH = await page.evaluate(() => {
          let h = 0;
          for (const e of document.querySelectorAll('body *')) {
            if (getComputedStyle(e).position !== 'fixed') continue;
            const r = e.getBoundingClientRect();
            if (r.height > 0 && r.height < 200 && r.bottom >= innerHeight - 2) {
              h = Math.max(h, r.height);
              e.style.visibility = 'hidden';
            }
          }
          return h;
        });
        await page.screenshot({ path: `${base}-full.png`, fullPage: true });
        meta[`${id}-${locale}`] = { bottomBarCss: barH };
      }
      console.log('captured', base);
      await ctx.close();
    }
  }
}
await browser.close();
writeFileSync(`${out}/meta.json`, JSON.stringify(meta, null, 2));
