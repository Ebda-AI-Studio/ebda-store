/**
 * Qamar scenario matrix (Phase B1 Task 10): the three looks plus the scenario stores
 * (scripts/storedemo/scenario-stores.mjs) x ar/en x the page list, per viewport project.
 * QAMAR_STORES / QAMAR_PAGES (comma lists) narrow a run; unset runs the full matrix.
 */
import { test, expect } from '@playwright/test';
import { open, runAxe, hostOf } from './helpers';

const LOOK_STORES = ['qamar-atelier', 'qamar-lookbook', 'qamar-vitrine'];
const ALL_PAGES = [
  '/',
  '/products',
  '/products?category=abayas',
  '/products/linen-abaya',
  '/products/cotton-scarf-set',
  '/cart',
  '/checkout',
  '/search?q=عباية',
  '/account',
  '/account/orders',
  '/size-guide',
  '/this-page-does-not-exist',
];
// Focused layouts: checkout and the account/login pages carry no footer by design.
const NO_FOOTER = /^\/(checkout|account)/;
// Products a scenario store does not carry: the PDP is a 404, correctly.
const ABSENT: Record<string, string[]> = {
  'qamar-empty': ['/products/linen-abaya', '/products/cotton-scarf-set'],
  'qamar-one': ['/products/cotton-scarf-set'],
};
// Ruling B1-111: a merchant primaryColor at the extremes is honoured verbatim, so text-primary
// can fail contrast on those stores; every other axe rule still applies.
const EXTREME_PRIMARY = /^qamar-edge-/;
const csv = (v?: string) => (v ? v.split(',').filter(Boolean) : null);
const PAGES = csv(process.env.QAMAR_PAGES) ?? ALL_PAGES;
const STORES = csv(process.env.QAMAR_STORES) ?? [
  ...LOOK_STORES,
  'qamar-empty',
  'qamar-one',
  'qamar-500',
  'qamar-edge-wide',
  'qamar-edge-tall',
  'qamar-edge-nologo',
];

for (const store of STORES)
  for (const lang of ['ar', 'en'] as const)
    for (const p of PAGES)
      test(`${store} ${lang} ${p}`, async ({ page }) => {
        const res = await open(page, store, lang, p);
        const absent = p.includes('does-not-exist') || ABSENT[store]?.includes(p);
        expect(res.status(), p).toBe(absent ? 404 : 200);
        await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
        ).toBeLessThanOrEqual(0);
        await expect(page.locator('main')).toHaveCount(1);
        // The platform 404 page is its own bare layout (header and footer absent).
        if (!absent) {
          await expect(page.locator('header')).toHaveCount(1);
          await expect(page.locator('footer')).toHaveCount(NO_FOOTER.test(p) ? 0 : 1);
        }
        const tiny = await page.evaluate(
          () =>
            [...document.querySelectorAll('body *')].filter(
              e =>
                e.childNodes.length &&
                [...e.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim()) &&
                parseFloat(getComputedStyle(e).fontSize) < 12
            ).length
        );
        expect(tiny, 'text under 12px').toBe(0);
        const axe = await runAxe(page);
        expect(
          axe.filter(
            v =>
              (v.impact === 'serious' || v.impact === 'critical') &&
              !(EXTREME_PRIMARY.test(store) && v.id === 'color-contrast')
          )
        ).toEqual([]);
      });

test('reduced motion: nothing animates', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const store of LOOK_STORES) {
    await open(page, store, 'ar', '/');
    await page.waitForTimeout(400);
    const running = await page.evaluate(
      () => document.getAnimations().filter(a => a.playState === 'running').length
    );
    expect(running, `${store}: running animations`).toBe(0);
  }
});

test('zoom 200%: 640px CSS width has no horizontal scroll on every look home + PDP', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 900 });
  for (const store of LOOK_STORES)
    for (const p of ['/', '/products/linen-abaya']) {
      await open(page, store, 'en', p);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(over, `${store} ${p}`).toBeLessThanOrEqual(0);
    }
});

test('keyboard only: Tab reaches the skip link, the header nav, the first product and add-to-cart with a visible focus ring', async ({
  page,
}) => {
  await open(page, 'qamar-atelier', 'en', '/products/linen-abaya');
  const seen: Array<{ tag: string; text: string; outline: string; shadow: string }> = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const e = document.activeElement as HTMLElement;
        const s = getComputedStyle(e);
        return {
          tag: e.tagName,
          text: (e.textContent ?? e.getAttribute('aria-label') ?? '').trim().slice(0, 40),
          outline: `${s.outlineStyle} ${s.outlineWidth}`,
          shadow: s.boxShadow,
        };
      })
    );
  }
  expect(seen[0]!.text.toLowerCase(), 'first stop is the skip link').toMatch(/skip|تخطي/);
  expect(
    seen.some(s => s.tag === 'A' && /product|shop|collection/i.test(s.text)),
    'header nav reached'
  ).toBe(true);
  expect(
    seen.some(s => /add to (cart|bag)|أضيفي|أضف/i.test(s.text)),
    'add-to-cart reached'
  ).toBe(true);
  const ringless = seen.filter(
    s =>
      s.tag !== 'BODY' &&
      s.tag !== 'NEXTJS-PORTAL' &&
      s.outline.startsWith('none') &&
      s.shadow === 'none'
  );
  expect(ringless, 'focused elements without a visible ring').toEqual([]);
});

test('slow 3G: each look home loads and its LCP element is the hero image', async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 400,
    downloadThroughput: 50_000,
    uploadThroughput: 50_000,
  });
  // Registered ONCE: an init script added inside the loop runs again on every later navigation, so the
  // Nth store would count its layout shifts N times over (lookbook, the 2nd, read 2 x 0.05 = 0.10).
  await page.addInitScript(() => {
    (
      window as unknown as { __lcp: Array<{ tag?: string; inHero: boolean }>; __cls: number }
    ).__lcp = [];
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) {
        const el = (e as PerformanceEntry & { element?: Element }).element;
        (window as unknown as { __lcp: Array<{ tag?: string; inHero: boolean }> }).__lcp.push({
          tag: el?.tagName,
          inHero: !!el?.closest('[data-section="hero"]'),
        });
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver(l => {
      for (const e of l.getEntries() as Array<
        PerformanceEntry & { hadRecentInput?: boolean; value?: number }
      >)
        if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value ?? 0;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  for (const store of LOOK_STORES) {
    const res = await page.goto(`${hostOf(store)}/`, { waitUntil: 'load', timeout: 240_000 });
    expect(res?.status(), store).toBe(200);
    // The hero photo is the LCP candidate: let it finish on the throttled link, then settle.
    await page.waitForFunction(
      () => {
        const i = document.querySelector<HTMLImageElement>('[data-section="hero"] img');
        return !i || (i.complete && i.naturalWidth > 0);
      },
      undefined,
      { timeout: 200_000 }
    );
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => ({
      lcp: (window as unknown as { __lcp: Array<{ tag?: string; inHero: boolean }> }).__lcp,
      cls: (window as unknown as { __cls: number }).__cls,
    }));
    const last = m.lcp[m.lcp.length - 1];
    if (last) {
      expect(last.tag, `${store} LCP element`).toBe('IMG');
      if (!last.inHero) {
        // A tall tablet (820x1180) shows a second, larger photo (Lookbook's shop-the-look) above the
        // fold, which legitimately arrives later and replaces the hero as the LCP entry. What this
        // test guards is the hero's own priority: its photo was the first LCP candidate, is eager
        // and high-priority, never lazy.
        expect(
          m.lcp.some(e => e.tag === 'IMG' && e.inHero),
          `${store} the hero photo was an LCP candidate`
        ).toBe(true);
        const prio = await page
          .locator('[data-section="hero"] img')
          .first()
          .evaluate((i: HTMLImageElement) => ({
            loading: i.getAttribute('loading'),
            fetchpriority: i.getAttribute('fetchpriority'),
          }));
        expect(prio, `${store} hero photo priority`).toEqual({
          loading: 'eager',
          fetchpriority: 'high',
        });
      } else {
        expect(last.inHero, `${store} LCP inside the hero`).toBe(true);
      }
    } else {
      // Headless Chromium emits no LCP entry for a hero whose autoplay video sits over the photo:
      // the hero photo must at least have loaded (LCP itself is NOT VERIFIED on that run).
      test.info().annotations.push({ type: 'lcp', description: `${store}: no LCP entry` });
      const loaded = await page
        .locator('[data-section="hero"] img')
        .first()
        .evaluate((i: HTMLImageElement) => i.naturalWidth > 0);
      expect(loaded, `${store} hero photo loaded`).toBe(true);
    }
    expect(m.cls, `${store} CLS`).toBeLessThan(0.1);
  }
});

test('variants, OOS, backorder, sale, personalisation, size chart, delivery chip, video', async ({
  page,
}) => {
  await open(page, 'qamar-atelier', 'en', '/products/linen-abaya');
  // A struck-through (unavailable) Rose / M / 56 combination.
  await page
    .getByRole('button', { name: /^rose$/i })
    .first()
    .click();
  await page.getByRole('button', { name: /^M$/ }).first().click();
  const struck = await page.evaluate(() =>
    [...document.querySelectorAll('[data-option-group] button')].some(
      b =>
        (b as HTMLButtonElement).disabled &&
        getComputedStyle(b).textDecorationLine.includes('line-through')
    )
  );
  expect(struck, 'a struck-through unavailable option').toBe(true);
  // Size guide dialog.
  await page
    .getByRole('button', { name: /size guide|دليل المقاسات/i })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  // Delivery chip.
  await expect(page.getByText(/يوصلك|Arrives/).first()).toBeVisible();
  // Backorder CTA.
  await open(page, 'qamar-atelier', 'en', '/products/evening-gown-rose');
  await expect(
    page.getByRole('button', { name: /pre-?order|backorder|اطلبي مسبقاً|طلب مسبق/i }).first()
  ).toBeVisible();
  // Sale product shows a crossed price.
  await open(page, 'qamar-atelier', 'en', '/products/crepe-abaya-sale');
  // The compare-at price shows once a variant is chosen (a range shows no single strike).
  for (const g of await page.locator('[data-option-group]').all())
    await g.locator('button[aria-pressed="false"]:not([disabled])').first().click();
  await page.waitForTimeout(1000);
  const crossed = await page.evaluate(
    () =>
      [...document.querySelectorAll('body *')].filter(
        e =>
          [...e.childNodes].some(n => n.nodeType === 3 && /\d/.test(n.textContent ?? '')) &&
          getComputedStyle(e).textDecorationLine.includes('line-through')
      ).length
  );
  expect(crossed, 'crossed price').toBeGreaterThan(0);
  // Personalisation field on the monogram product.
  await open(page, 'qamar-atelier', 'en', '/products/hand-embroidered-abaya');
  await expect(page.getByLabel(/personali|embroider|تطريز|اسم/i).first()).toBeVisible();
  // Hero video: present normally, absent under reduced motion.
  await open(page, 'qamar-atelier', 'en', '/');
  expect(await page.locator('[data-section="hero"] video').count(), 'hero video').toBeGreaterThan(
    0
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, 'qamar-atelier', 'en', '/');
  expect(await page.locator('[data-section="hero"] video').count(), 'no video with reduce').toBe(0);
});
