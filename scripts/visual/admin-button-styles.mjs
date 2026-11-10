#!/usr/bin/env node
/**
 * Measure every rendered button in the merchant admin and screenshot the pages
 * (ruling docs/rulings/2026-11-10-admin-button-system.md).
 *
 * Needs the builder-e2e mock API and an admin dev server pointed at it:
 *   MOCK_API_PORT=4510 node tests/builder-e2e/mock-api.mjs &
 *   (cd apps/admin && NEXT_PUBLIC_API_URL=http://localhost:4510 npx next dev -p 3101) &
 *   node scripts/visual/admin-button-styles.mjs --base http://localhost:3101 --out /tmp/after
 *
 * Writes <out>/<page>-<locale>-<width>-<theme>.png and <out>/styles.json: each distinct
 * style (height | font | radius | filled | bordered) with its count and three example labels.
 * A style is a visible <button>, [role=button], or an <a> dressed as a button (fill or border + padding).
 * `rpill` marks a fully round control (radius >= half its height).
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('base', 'http://localhost:3101');
const OUT = arg('out', 'admin-button-styles');
const STORE = '0a0b0c0d-0000-4000-8000-00000000e2e0';
const S = `/stores/${STORE}`;
const SHOT_PAGES = {
  dashboard: S,
  products: `${S}/products`,
  'product-edit': `${S}/products/new`,
  orders: `${S}/orders`,
  settings: `${S}/settings`,
  shipping: `${S}/shipping`,
};
const MEASURE_ONLY = {
  categories: `${S}/categories`,
  coupons: `${S}/coupons`,
  'payment-settings': `${S}/payment-settings`,
  seo: `${S}/seo`,
  domain: `${S}/domain`,
  stock: `${S}/stock`,
  finance: `${S}/finance/dashboard`,
  analytics: `${S}/analytics`,
};
const shots = arg('shots', 'all'); // all | none
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const styles = new Map();
const combos = [];
for (const locale of ['ar', 'en'])
  for (const width of [390, 1440])
    for (const theme of ['light', 'dark']) combos.push({ locale, width, theme });

async function measure(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      // A link counts only when it is dressed as a button (a fill or a border, and padding).
      if (el.tagName === 'A' && !el.hasAttribute('data-ui')) {
        const dressed =
          (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderTopWidth) > 0) &&
          parseFloat(cs.paddingInlineStart) > 0;
        if (!dressed) continue;
      }
      const exemptRole =
        /^(switch|menuitem|menuitemradio|menuitemcheckbox|option|radio|tab|gridcell)$/.test(
          el.getAttribute('role') || ''
        );
      const kind = el.getAttribute('data-ui');
      if (exemptRole || kind) {
        out.push({ key: `exempt:${kind || el.getAttribute('role')}`, label: '' });
        continue;
      }
      const filled =
        cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      const bordered = parseFloat(cs.borderTopWidth) > 0;
      const radius = Math.round(parseFloat(cs.borderTopLeftRadius));
      // A pill: the radius reaches half the height (the ends are fully round).
      const pill = radius >= Math.floor(r.height / 2);
      out.push({
        key: `${Math.round(r.height)}px|${cs.fontSize}|r${pill ? 'pill' : radius}|${filled ? 'fill' : 'ghost'}|b${bordered ? 1 : 0}`,
        label: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24),
      });
    }
    return out;
  });
}

for (const { locale, width, theme } of combos) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    locale: locale === 'ar' ? 'ar-EG' : 'en-US',
  });
  await ctx.addCookies([{ name: 'admin-lang', value: locale, url: BASE }]);
  await ctx.addInitScript(t => {
    localStorage.setItem('accessToken', 'e2e');
    localStorage.setItem('admin-theme', t);
  }, theme);
  const page = await ctx.newPage();
  const pages =
    locale === 'ar' && width === 1440 && theme === 'light'
      ? { ...SHOT_PAGES, ...MEASURE_ONLY }
      : SHOT_PAGES;
  for (const [name, path] of Object.entries(pages)) {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 120_000 }).catch(() => {});
    await page.waitForTimeout(800);
    for (const b of await measure(page)) {
      const s = styles.get(b.key) ?? { count: 0, examples: new Set() };
      s.count++;
      if (s.examples.size < 3 && b.label) s.examples.add(`${name}:${b.label}`);
      styles.set(b.key, s);
    }
    if (shots !== 'none' && name in SHOT_PAGES)
      await page.screenshot({
        path: join(OUT, `${name}-${locale}-${width}-${theme}.png`),
        fullPage: false,
      });
  }
  await ctx.close();
}
await browser.close();

const list = [...styles]
  .map(([key, s]) => ({ key, count: s.count, examples: [...s.examples] }))
  .sort((a, b) => b.count - a.count);
writeFileSync(join(OUT, 'styles.json'), JSON.stringify(list, null, 2));
const real = list.filter(s => !s.key.startsWith('exempt:'));
console.log(
  `${real.length} distinct button styles (+ exempt non-button controls listed as exempt:<kind>)`
);
for (const s of list)
  console.log(`${String(s.count).padStart(4)}  ${s.key}  ${s.examples.join(' / ')}`);
