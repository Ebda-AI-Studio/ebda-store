#!/usr/bin/env node
// Layout proof for C-04 (Qamar taste audit 2026-10-15): on a phone there is at most ONE
// fixed-bottom layer (a task bar REPLACES the tab bar), and nothing the shopper must reach sits
// under it. jsdom has no layout, so this drives real Chromium.
//
//   npm run test:fixed-bars -- [--skins minimal,dahab] [--lang ar] [--width 390] [--label after] [--out <dir>]
//
// Same local stack + seed as scripts/visual/measure-card-overflow.mjs (seed-card-overflow.mjs,
// API, `next dev`, the host->store proxy on WEB_PORT, default 3150).
//
// Per skin, at <width>x844 in <lang>:
//   PDP (/products/linen-abaya, a sized product)
//     - fixed-bottom layers visible at first paint <= 1 (tab bar and buy bar never both);
//     - the first option group's first control is above that layer (B0-49 fold, chrome present);
//     - a keyboard Tab onto the last control of the page content lands it unobscured;
//     - C-02 end to end: a tap on the bottom buy bar focuses the first option group, unobscured.
//   Cart (after adding /products/cotton-kaftan, a plain product)
//     - fixed-bottom layers <= 1 (cart total bar and tab bar never both);
//     - a keyboard Tab onto the promo-code field lands it unobscured.
// Writes <out>/<label>-pdp-<w>-<lang>-fold-<skin>.png, <label>-cart-<w>-<lang>-<skin>.png and
// <out>/report-<label>.json. Exits 1 on any failed check.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, '../../package.json'))('playwright');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const SKINS = arg('skins', 'minimal,dahab').split(',');
const LANG = arg('lang', 'ar');
const WIDTH = Number(arg('width', '390'));
const LABEL = arg('label', 'run');
const OUT = resolve(arg('out', join(tmpdir(), 'fixed-bars')));
const PORT = process.env.WEB_PORT || '3150';

/** Visible full-width position:fixed bars in the bottom band of the viewport (on the bottom
 *  edge, or stacked on a bar that is). */
const layersProbe = () => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (el.closest('nextjs-portal')) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 24 || r.width < innerWidth * 0.6) continue; // a bar spans the width
    // a full-screen overlay (the closed menu sheet, a scrim) is not a bottom bar
    if (r.height > innerHeight * 0.4 || Number(cs.opacity) === 0) continue;
    // a bar in the bottom band: anchored at the bottom edge OR stacked on top of one
    if (r.bottom < innerHeight * 0.6 || r.bottom > innerHeight + 2) continue;
    if (r.top >= innerHeight - 1) continue; // translated off-screen
    // count the outermost fixed bar only
    if (out.some(o => o.el.contains(el))) continue;
    out.push({ el, top: r.top, h: r.height });
  }
  return out.map(o => ({
    top: Math.round(o.top),
    h: Math.round(o.h),
    id:
      o.el.getAttribute('data-testid') ??
      (o.el.hasAttribute('data-bottom-tab-bar') ? 'bottom-tab-bar' : o.el.tagName.toLowerCase()),
  }));
};

/** Is `el` fully above every bottom layer, inside the viewport, and the topmost hit? */
const unobscured = (sel, layers) => {
  const el = typeof sel === 'string' ? document.querySelector(sel) : document.activeElement;
  if (!el) return { ok: false, why: 'missing' };
  const r = el.getBoundingClientRect();
  const barTop = Math.min(innerHeight, ...layers.map(l => l.top));
  const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
  const cy = Math.min(innerHeight - 1, Math.max(0, r.top + Math.min(r.height, 40) / 2));
  const hit = document.elementFromPoint(cx, cy);
  const ok = r.top >= -0.5 && r.bottom <= barTop + 0.5 && !!hit && (hit === el || el.contains(hit));
  return {
    ok,
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    barTop: Math.round(barTop),
    hit: hit ? hit.tagName.toLowerCase() + (hit.id ? `#${hit.id}` : '') : null,
  };
};

/** Focus the control BEFORE `target` in tab order, then press Tab: a real keyboard landing. */
async function tabOnto(page, target) {
  return page.evaluate(sel => {
    const tabbable = [
      ...document.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex="0"]'
      ),
    ].filter(e => {
      if (e.closest('[inert],[aria-hidden="true"]')) return false;
      for (let p = e; p; p = p.parentElement)
        if (getComputedStyle(p).position === 'fixed') return false;
      return e.getClientRects().length > 0;
    });
    const t = sel ? document.querySelector(sel) : tabbable[tabbable.length - 1];
    const i = tabbable.indexOf(t);
    if (i < 1) return { ok: false, why: `target index ${i}` };
    window.scrollTo(0, 0);
    tabbable[i - 1].focus({ preventScroll: true });
    t.setAttribute('data-tab-target', '');
    return { ok: true };
  }, target);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const report = {};
let failures = 0;
const check = (key, name, pass, detail) => {
  report[key] ??= {};
  report[key][name] = { pass, ...detail };
  if (!pass) failures++;
};
try {
  for (const skin of SKINS) {
    const host = `fu-${skin}.localhost`;
    const base = `http://${host}:${PORT}`;
    const ctx = await browser.newContext({
      viewport: { width: WIDTH, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    await ctx.addCookies([
      { name: 'force-language', value: LANG, domain: host, path: '/' },
      {
        name: 'force-cookie-consent',
        value: encodeURIComponent(JSON.stringify({ v: 1, marketing: false, analytics: false })),
        domain: host,
        path: '/',
      },
    ]);
    // The probe helpers are this file's own functions, installed once per page load.
    await ctx.addInitScript({
      content: `window.__layers = ${layersProbe.toString()}; window.__unobscured = ${unobscured.toString()};`,
    });
    const page = await ctx.newPage();
    const hideDevOverlay = () =>
      page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });

    // ── PDP ────────────────────────────────────────────────────────────────
    const pdp = `${skin}/pdp`;
    try {
      await page.goto(`${base}/products/linen-abaya`, { waitUntil: 'networkidle', timeout: 90000 });
      await hideDevOverlay();
      await page.waitForTimeout(700);
      const layers = await page.evaluate(() => window.__layers());
      check(pdp, 'oneBottomLayer', layers.length <= 1, { layers });
      const first = await page.evaluate(
        l => window.__unobscured('[data-option-group] button', l),
        layers
      );
      check(pdp, 'firstSelectorAboveBar', first.ok, first);
      await page.screenshot({ path: join(OUT, `${LABEL}-pdp-${WIDTH}-${LANG}-fold-${skin}.png`) });

      // C-02 end to end: the bottom buy bar's tap goes to the first option group.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
      const barBtn = page.locator(
        '[data-testid="sticky-atc"] button, [data-testid="dahab-pinned-add"]'
      );
      if ((await barBtn.count()) > 0 && (await barBtn.first().isVisible())) {
        await barBtn.first().click();
        await page.waitForTimeout(900); // smooth scroll
        const nudged = await page.evaluate(() => {
          const focused = document.activeElement?.hasAttribute('data-option-group') ?? false;
          const u = window.__unobscured(null, window.__layers());
          return { ...u, ok: focused && u.ok, focused };
        });
        check(pdp, 'barTapFocusesFirstOptionUnobscured', nudged.ok, nudged);
      } else {
        check(pdp, 'barTapFocusesFirstOptionUnobscured', false, {
          why: 'no visible bottom buy bar',
        });
      }

      const prep = await tabOnto(page, null);
      await page.keyboard.press('Tab');
      await page.waitForTimeout(1500); // smooth scroll + the bars swapping as the page moves
      const last = await page.evaluate(() => {
        const u = window.__unobscured(null, window.__layers());
        const landed = document.activeElement?.hasAttribute('data-tab-target') ?? false;
        return { ...u, ok: landed && u.ok, landed };
      });
      check(pdp, 'lastControlUnobscured', prep.ok && last.ok, { ...prep, ...last });
    } catch (e) {
      check(pdp, 'error', false, { error: String(e).slice(0, 300) });
    }

    // ── Cart ───────────────────────────────────────────────────────────────
    const cart = `${skin}/cart`;
    try {
      await page.goto(`${base}/products/cotton-kaftan`, {
        waitUntil: 'networkidle',
        timeout: 90000,
      });
      await hideDevOverlay();
      const add = page.locator('[data-testid="pdp-add"]').first();
      await add.scrollIntoViewIfNeeded();
      await Promise.all([
        page.waitForResponse(
          r => /\/cart\/items/.test(r.url()) && r.request().method() === 'POST',
          {
            timeout: 30000,
          }
        ),
        add.click(),
      ]);
      await page.goto(`${base}/cart`, { waitUntil: 'networkidle', timeout: 90000 });
      await hideDevOverlay();
      await page.waitForTimeout(700);
      const layers = await page.evaluate(() => window.__layers());
      check(cart, 'oneBottomLayer', layers.length <= 1, { layers });
      const prep = await tabOnto(page, 'input[id^="cart-promo-code"]');
      await page.keyboard.press('Tab');
      await page.waitForTimeout(1500);
      const promo = await page.evaluate(() => {
        const u = window.__unobscured(null, window.__layers());
        const landed = document.activeElement?.id?.startsWith('cart-promo-code') ?? false;
        return { ...u, ok: landed && u.ok, landed };
      });
      check(cart, 'promoFieldUnobscured', prep.ok && promo.ok, { ...prep, ...promo });
      await page.screenshot({ path: join(OUT, `${LABEL}-cart-${WIDTH}-${LANG}-${skin}.png`) });
    } catch (e) {
      check(cart, 'error', false, { error: String(e).slice(0, 300) });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(OUT, `report-${LABEL}.json`), JSON.stringify(report, null, 1));
for (const [k, checks] of Object.entries(report)) {
  for (const [name, v] of Object.entries(checks)) {
    const { pass, ...rest } = v;
    console.log(pass ? 'ok  ' : 'FAIL', k.padEnd(14), name.padEnd(36), JSON.stringify(rest));
  }
}
console.log(`\n${failures} failing check(s); screenshots + report in ${OUT}`);
process.exit(failures ? 1 : 0);
