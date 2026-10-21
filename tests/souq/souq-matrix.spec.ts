/**
 * Souq scenario matrix (Phase B2 Task 7): the three looks plus the scenario stores
 * (scripts/storedemo/scenario-stores.mjs --template souq) x ar/en x the page list, per viewport
 * project. SOUQ_STORES / SOUQ_PAGES (comma lists) narrow a run; unset runs the full matrix.
 */
import { test, expect } from '@playwright/test';
import { open, runAxe, hostOf } from './helpers';

const LOOK_STORES = ['souq-catalogue', 'souq-night', 'souq-showroom'];
const PDP = '/products/smartphone-6-7';
const ALL_PAGES = [
  '/',
  '/products',
  '/products?category=phones',
  PDP,
  '/cart',
  '/checkout',
  '/search?q=سماعة',
  '/compare',
  '/account',
  '/account/orders',
  '/this-page-does-not-exist',
];
// Focused layouts: checkout and the account/login pages carry no footer by design.
const NO_FOOTER = /^\/(checkout|account)/;
// Products a scenario store does not carry: the PDP is a 404, correctly.
const ABSENT: Record<string, string[]> = { 'souq-empty': [PDP] };
// Ruling B1-111: a merchant primaryColor at the extremes is honoured verbatim, so text-primary
// can fail contrast on those stores; every other axe rule still applies.
const EXTREME_PRIMARY = /^souq-edge-/;
const csv = (v?: string) => (v ? v.split(',').filter(Boolean) : null);
const PAGES = csv(process.env.SOUQ_PAGES) ?? ALL_PAGES;
const STORES = csv(process.env.SOUQ_STORES) ?? [
  ...LOOK_STORES,
  'souq-empty',
  'souq-one',
  'souq-500',
  'souq-noimg',
  'souq-longnames',
  'souq-edge-light',
  'souq-edge-dark',
  'souq-logo-wide',
  'souq-logo-tall',
  'souq-logo-none',
  'souq-white-photos',
  'souq-cod',
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
    for (const p of ['/', PDP]) {
      await open(page, store, 'en', p);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(over, `${store} ${p}`).toBeLessThanOrEqual(0);
    }
});

test('keyboard only: header search, then the category rail, a card and add-to-cart, each with a visible focus ring', async ({
  page,
}) => {
  await open(page, 'souq-catalogue', 'en', '/');
  const seen: Array<{ tag: string; type: string; rail: boolean; card: boolean; ring: boolean }> =
    [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const e = document.activeElement as HTMLElement;
        const s = getComputedStyle(e);
        return {
          tag: e.tagName,
          type: e.getAttribute('type') ?? '',
          rail: !!e.closest('[data-section="category-rail"], [data-section="category-grid"]'),
          card:
            !!e.closest('[data-product-card], [data-part="card"]') ||
            /\/products\//.test(e.getAttribute('href') ?? ''),
          ring: !(s.outlineStyle === 'none' && s.boxShadow === 'none'),
        };
      })
    );
  }
  expect(
    seen.some(s => s.tag === 'INPUT' && s.type === 'search'),
    'header search reached'
  ).toBe(true);
  expect(
    seen.some(s => s.rail),
    'category rail reached'
  ).toBe(true);
  expect(
    seen.some(s => s.card),
    'a product card reached'
  ).toBe(true);
  expect(
    seen.filter(s => s.tag !== 'BODY' && s.tag !== 'NEXTJS-PORTAL' && !s.ring),
    'focused elements without a visible ring'
  ).toEqual([]);
  await open(page, 'souq-catalogue', 'en', PDP);
  const pdp: string[] = [];
  for (let i = 0; i < 70; i++) {
    await page.keyboard.press('Tab');
    pdp.push(
      await page.evaluate(() =>
        ((document.activeElement as HTMLElement).textContent ?? '').trim().slice(0, 40)
      )
    );
  }
  expect(
    pdp.some(t => /add to (cart|bag)|أضف/i.test(t)),
    'add-to-cart reached'
  ).toBe(true);
});

test('PDP: variants, OOS combination, sale, instalment line, backorder, compare toggle', async ({
  page,
}) => {
  await open(page, 'souq-catalogue', 'en', PDP);
  // Black / 512GB is sold out: a struck-through unavailable option appears.
  await page
    .getByRole('button', { name: /^black$/i })
    .first()
    .click();
  const struck = await page.evaluate(() =>
    [...document.querySelectorAll('[data-option-group] button')].some(
      b =>
        (b as HTMLButtonElement).disabled &&
        getComputedStyle(b).textDecorationLine.includes('line-through')
    )
  );
  expect(struck, 'a struck-through unavailable option').toBe(true);
  // Instalment line: PDP only, named approximate, never on a card.
  await expect(page.getByTestId('instalment-line')).toHaveCount(1);
  await open(page, 'souq-catalogue', 'en', '/products');
  await expect(page.getByTestId('instalment-line')).toHaveCount(0);
  // Backorder CTA on the sold-out speaker.
  await open(page, 'souq-catalogue', 'en', '/products/portable-speaker');
  await expect(
    page.getByRole('button', { name: /pre-?order|backorder|اطلب مسبق|طلب مسبق|order now/i }).first()
  ).toBeVisible();
  // A sale product shows a crossed price.
  await open(page, 'souq-catalogue', 'en', '/products/power-bank-20000');
  const crossed = await page.evaluate(
    () =>
      [...document.querySelectorAll('body *')].filter(
        e =>
          [...e.childNodes].some(n => n.nodeType === 3 && /\d/.test(n.textContent ?? '')) &&
          getComputedStyle(e).textDecorationLine.includes('line-through')
      ).length
  );
  expect(crossed, 'crossed price').toBeGreaterThan(0);
});

test('Night souq on white-background merchant photos: no white rectangle on the green', async ({
  page,
}) => {
  await open(page, 'souq-white-photos', 'en', '/');
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    for (const img of document.querySelectorAll<HTMLImageElement>('img[src*="white-photo"]')) {
      // Walk up to the first ancestor with a painted background: that is the ground the photo sits on.
      let e: HTMLElement | null = img.parentElement;
      let bg = 'rgba(0, 0, 0, 0)';
      while (e && /rgba\(0, 0, 0, 0\)|transparent/.test((bg = getComputedStyle(e).backgroundColor)))
        e = e.parentElement;
      const m = /rgba?\((\d+), (\d+), (\d+)/.exec(bg);
      if (m && Number(m[1]) + Number(m[2]) + Number(m[3]) < 3 * 200) out.push(`${img.alt}: ${bg}`);
    }
    return out;
  });
  expect(bad, 'white photos sitting on a dark ground').toEqual([]);
});
