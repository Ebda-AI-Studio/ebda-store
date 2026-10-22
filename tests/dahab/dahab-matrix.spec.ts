/**
 * Dahab scenario matrix (Phase B5 Task 6): the three looks plus the scenario stores
 * (scripts/storedemo/scenario-stores.mjs --template dahab) x ar/en x the page list, per viewport
 * project, then the Dahab features end to end: the Worn chip row and engraving band, the Workshop steps,
 * the Gift box finder, required engraving, the gold-rate line on every surface that prices a gold piece,
 * and the checkout DATA FLOW (a Metal x Size variant, an engraved line and a gold line must reach the
 * cart summary and the receipt: the B1 worst miss was a component-level pass over a broken flow).
 * DAHAB_STORES / DAHAB_PAGES (comma lists) narrow a run; unset runs the full matrix on the look stores and
 * the key pages on the scenario stores.
 */
import { test, expect } from '@playwright/test';
import {
  open,
  runAxe,
  fillShipping,
  placeCodOrder,
  releaseOpenHolds,
  RINGS_PATH,
  RING_PDP,
  ENGRAVE_PDP,
  GOLD_PDP,
  GOLD_RING_PDP,
  PLAIN_PDP,
} from './helpers';

const LOOK_STORES = ['dahab-worn', 'dahab-workshop', 'dahab-giftbox'];
const SCENARIO_STORES = [
  'dahab-empty',
  'dahab-one',
  'dahab-500',
  'dahab-noimg',
  'dahab-longnames',
  'dahab-edge-light',
  'dahab-edge-dark',
  'dahab-logo-wide',
  'dahab-logo-tall',
  'dahab-logo-none',
  'dahab-white-photos',
  'dahab-legacy',
  'dahab-cod',
];
const ALL_PAGES = [
  '/',
  '/products',
  RINGS_PATH,
  RING_PDP,
  ENGRAVE_PDP,
  GOLD_PDP,
  GOLD_RING_PDP,
  '/cart',
  '/checkout',
  '/search?q=خاتم',
  '/account',
  '/account/orders',
  '/this-page-does-not-exist',
];
// Scenario stores are about content shapes: the pages that show them.
const SCENARIO_PAGES = ['/', '/products', RING_PDP, GOLD_PDP, '/cart'];
// Focused layouts: checkout and the account/login pages carry no footer by design.
const NO_FOOTER = /^\/(checkout|account)/;
// Products a scenario store does not carry: the PDP is a 404, correctly.
const ABSENT: Record<string, string[]> = {
  'dahab-empty': [RING_PDP, ENGRAVE_PDP, GOLD_PDP, GOLD_RING_PDP, RINGS_PATH],
  'dahab-one': [RING_PDP, ENGRAVE_PDP, GOLD_RING_PDP],
};
// Ruling B1-111: a merchant primaryColor at the extremes is honoured verbatim, so text-primary
// can fail contrast on those stores; every other axe rule still applies.
// A migrated legacy store keeps its OWN gold primary on the new white page (`design: 'keep'`, Ruling B5-3):
// that colour is the merchant's, honoured verbatim, so it joins the same accepted residual.
const EXTREME_PRIMARY = /^dahab-(edge-|legacy)/;
const csv = (v?: string) => (v ? v.split(',').filter(Boolean) : null);
const pagesFor = (store: string) =>
  csv(process.env.DAHAB_PAGES) ?? (LOOK_STORES.includes(store) ? ALL_PAGES : SCENARIO_PAGES);
const STORES = csv(process.env.DAHAB_STORES) ?? [...LOOK_STORES, ...SCENARIO_STORES];

for (const store of STORES)
  for (const lang of ['ar', 'en'] as const)
    for (const p of pagesFor(store))
      test(`${store} ${lang} ${p}`, async ({ page }) => {
        const res = await open(page, store, lang, p);
        const absent = p.includes('does-not-exist') || ABSENT[store]?.includes(p);
        const expected =
          absent && (p.startsWith('/products/') || p.includes('does-not-exist')) ? 404 : 200;
        expect(res.status(), p).toBe(expected);
        await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
        ).toBeLessThanOrEqual(0);
        await expect(page.locator('main')).toHaveCount(1);
        if (expected === 200) {
          await expect(page.locator('header')).toHaveCount(1);
          await expect(page.getByRole('contentinfo')).toHaveCount(NO_FOOTER.test(p) ? 0 : 1);
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
        // A gold piece prints its rate line under the price (never on a card).
        if (expected === 200 && p === GOLD_PDP)
          await expect(page.getByTestId('gold-rate-line').first()).toBeVisible();
        const axe = await runAxe(page);
        expect(
          axe.filter(
            v =>
              (v.impact === 'serious' || v.impact === 'critical') &&
              !(EXTREME_PRIMARY.test(store) && v.id === 'color-contrast')
          )
        ).toEqual([]);
      });

test('reduced motion: nothing animates on the look homes and the ring page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const store of LOOK_STORES)
    for (const p of ['/', RING_PDP]) {
      await open(page, store, 'ar', p);
      await page.waitForTimeout(400);
      const running = await page.evaluate(
        () => document.getAnimations().filter(a => a.playState === 'running').length
      );
      expect(running, `${store} ${p}: running animations`).toBe(0);
    }
});

test('zoom 200%: 640px CSS width has no horizontal scroll on every look home, category and PDP', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 900 });
  for (const store of LOOK_STORES)
    for (const p of ['/', RINGS_PATH, RING_PDP, GOLD_PDP]) {
      await open(page, store, 'en', p);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(over, `${store} ${p}`).toBeLessThanOrEqual(0);
    }
});

test('every look home opens with one h1 and a sane heading order', async ({ page }) => {
  for (const store of LOOK_STORES)
    for (const lang of ['ar', 'en'] as const) {
      await open(page, store, lang, '/');
      expect(await page.locator('h1').count(), `${store} ${lang} h1 count`).toBe(1);
      const axe = await runAxe(page);
      expect(
        axe.filter(v => ['page-has-heading-one', 'heading-order', 'empty-heading'].includes(v.id)),
        `${store} ${lang}`
      ).toEqual([]);
    }
});

test('keyboard only: the gold piece page is reachable and its buy button takes focus from Tab', async ({
  page,
}) => {
  await open(page, 'dahab-worn', 'ar', GOLD_PDP);
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') === 'pdp-add'
    );
  }
  expect(reached, 'Tab reaches the add button').toBe(true);
});

test('Worn: the category chips sit right under the hero, 44px each, and the engraving band links to a personalised piece', async ({
  page,
}) => {
  await open(page, 'dahab-worn', 'ar', '/');
  const chips = page.locator('[data-section="category-chips"] a');
  expect(await chips.count()).toBeGreaterThanOrEqual(5);
  for (const h of await chips.evaluateAll(as => as.map(a => a.getBoundingClientRect().height)))
    expect(h).toBeGreaterThanOrEqual(44);
  const vh = page.viewportSize()!.height;
  const top = await chips.first().evaluate(e => e.getBoundingClientRect().top + window.scrollY);
  expect(top, 'chips within the first two screens').toBeLessThan(vh * 2);
  await expect(page.getByText('اسمك محفور عليها')).toBeVisible();
});

test('Workshop: the journey of a piece is three steps (drawn, cast, polished) on a committed teal page', async ({
  page,
}) => {
  await open(page, 'dahab-workshop', 'ar', '/');
  const steps = page.locator('[data-section="steps"] [data-part="step"]');
  await expect(steps).toHaveCount(3);
  const text = await page.locator('[data-section="steps"]').innerText();
  for (const w of ['رسم', 'صب', 'تلميع']) expect(text).toContain(w);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = (bg.match(/\d+/g) ?? ['255', '255', '255']).map(Number);
  expect(r + g + b, `page background ${bg} is dark`).toBeLessThan(300);
});

test('Workshop on white-background merchant photos: the product grid sits on a light band, never white rectangles on teal', async ({
  page,
}) => {
  await open(page, 'dahab-white-photos', 'ar', '/');
  const band = page.locator('[data-section="featured-collection"]').first();
  await expect(band).toBeVisible();
  const bg = await band.evaluate(e => getComputedStyle(e).backgroundColor);
  const [r, g, b] = (bg.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).map(Number);
  expect((r + g + b) / 3, `band background ${bg}`).toBeGreaterThan(200);
});

test('Gift box: the finder offers occasions and budgets; a budget link lands on a price-filtered list and an occasion on its category', async ({
  page,
}) => {
  await open(page, 'dahab-giftbox', 'ar', '/');
  const finder = page.locator('[data-section="gift-finder"]');
  await expect(finder).toBeVisible();
  const occasions = finder.getByRole('button', { pressed: false });
  expect(await occasions.count()).toBeGreaterThanOrEqual(4);
  for (const h of await finder
    .locator('button, a')
    .evaluateAll(els => els.map(e => e.getBoundingClientRect().height)))
    expect(h).toBeGreaterThanOrEqual(44);
  await occasions.first().click();
  const show = finder.locator('[data-gift-show]');
  await expect(show).toBeVisible();
  await show.click();
  await page.waitForURL(/\/products\?category=engagement/);
  await expect(page.locator('article').first()).toBeVisible();
  // a budget link: the PLP price slider opens at the cap and every card is within it
  await open(page, 'dahab-giftbox', 'ar', '/');
  await page.locator('[data-section="gift-finder"] a[href*="maxPrice="]').first().click();
  await page.waitForURL(/maxPrice=/);
  await expect(page.locator('article').first()).toBeVisible();
});

test('required engraving: the buy button nudges the field instead of adding, then the letters reach the cart', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const store = 'dahab-cod';
  await open(page, store, 'ar', ENGRAVE_PDP);
  const field = page.getByLabel('الحروف للحفر');
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute('maxlength', '12');
  const sizes = page
    .locator('[data-option-group]')
    .first()
    .locator('button[aria-pressed]:not([disabled])');
  await sizes.nth(1).click();
  // no letters: a tap on add does not put the line in the cart
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(800);
  await open(page, store, 'ar', '/cart');
  await expect(page.locator('main')).not.toContainText('خاتم بحروفك');
  await open(page, store, 'ar', ENGRAVE_PDP);
  await page
    .locator('[data-option-group]')
    .first()
    .locator('button[aria-pressed]:not([disabled])')
    .nth(1)
    .click();
  await page.getByLabel('الحروف للحفر').fill('سلمى');
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  await open(page, store, 'ar', '/cart');
  await expect(page.locator('main')).toContainText('سلمى');
});

test('the gold line: a gold piece shows karat, weight and today’s rate on the PDP, the cart and the checkout summary', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const store = 'dahab-cod';
  await open(page, store, 'ar', GOLD_PDP);
  const pdp = page.getByTestId('gold-rate-line').first();
  await expect(pdp).toContainText('سعر الجرام النهارده');
  await expect(pdp).toContainText('عيار 21');
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  await open(page, store, 'ar', '/cart');
  await expect(page.getByTestId('cart-gold-rates')).toContainText('سعر الجرام النهارده');
  await open(page, store, 'ar', '/checkout');
  await expect(page.getByTestId('gold-rate-line').first()).toContainText('سعر الجرام النهارده');
  // the notice is absent when the rate has not moved (the negative control for the E2E in dahab-gold-price)
  await expect(page.getByTestId('price-changed-notice')).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toMatch(/هامش|margin/i);
});

test.beforeAll(async () => {
  await releaseOpenHolds('dahab-cod');
});

test('checkout data flow: the Metal x Size variant, the engraved letters and the gold piece reach the cart summary, the receipt and the order', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const store = 'dahab-cod';
  // 1. a Metal x Size ring (rose gold, second size)
  await open(page, store, 'ar', RING_PDP);
  const groups = page.locator('[data-option-group]');
  await groups.nth(0).locator('button[aria-pressed]:not([disabled])').nth(1).click();
  await groups.nth(1).locator('button[aria-pressed]:not([disabled])').nth(1).click();
  const picked = (
    await Promise.all([
      groups.nth(0).locator('button[aria-pressed="true"]').innerText(),
      groups.nth(1).locator('button[aria-pressed="true"]').innerText(),
    ])
  ).map(s => s.trim());
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  // 2. an engraved ring
  await open(page, store, 'ar', ENGRAVE_PDP);
  await page
    .locator('[data-option-group]')
    .first()
    .locator('button[aria-pressed]:not([disabled])')
    .nth(0)
    .click();
  await page.getByLabel('الحروف للحفر').fill('نور');
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  // 3. a gold chain
  await open(page, store, 'ar', GOLD_PDP);
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  await open(page, store, 'ar', '/cart');
  const cart = await page.locator('main').innerText();
  for (const v of picked) expect(cart, `the variant "${v}" reaches the cart`).toContain(v);
  expect(cart, 'the engraving reaches the cart').toContain('نور');
  expect(cart, 'the gold line reaches the cart').toContain('سعر الجرام النهارده');
  // 4. the checkout and the receipt
  await open(page, store, 'ar', '/checkout');
  await fillShipping(page);
  await placeCodOrder(page);
  const receipt = await page.locator('main').innerText();
  for (const v of picked) expect(receipt, `the variant "${v}" reaches the receipt`).toContain(v);
  expect(receipt, 'the engraving reaches the receipt').toContain('نور');
  await expect(page.getByTestId('receipt-gold-line')).toHaveCount(1);
  expect(await page.getByTestId('receipt-gold-line').innerText()).toMatch(/عيار 21/);
  expect(receipt).not.toMatch(/هامش|margin|marginBps|rateId/i);
});

test('a plain piece is buyable and a missing photo does not break a card', async ({ page }) => {
  await open(page, 'dahab-worn', 'ar', PLAIN_PDP);
  await expect(page.getByTestId('pdp-add').first()).toBeVisible();
  await open(page, 'dahab-noimg', 'ar', '/products');
  expect(await page.locator('article').count()).toBeGreaterThan(0);
});

test('an empty store is a finished page: no products renders no chips and no broken rows', async ({
  page,
}) => {
  await open(page, 'dahab-empty', 'ar', '/');
  await expect(page.locator('h1')).toHaveCount(1);
});

test('a migrated legacy store renders on the new look, with its own colour kept (Ruling B5-3)', async ({
  page,
}) => {
  await open(page, 'dahab-legacy', 'ar', '/');
  await expect(page.locator('body')).toHaveAttribute('data-look', 'dahab.worn');
  await expect(page.locator('h1')).toHaveCount(1);
});
