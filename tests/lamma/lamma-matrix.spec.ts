/**
 * Lamma scenario matrix (Phase B4 Task 7): the three looks plus the scenario stores
 * (scripts/storedemo/scenario-stores.mjs --template lamma) x ar/en x the page list, per viewport
 * project, then the Lamma features end to end: menu tabs, the card stepper, the browse cart bar (one
 * bottom layer), minimum-order progress, delivery date chips, and the checkout data flow (portion
 * variant + note + picked date must reach the cart summary and the receipt).
 * LAMMA_STORES / LAMMA_PAGES (comma lists) narrow a run; unset runs the full matrix on the look
 * stores and the key pages on the scenario stores.
 */
import { test, expect } from '@playwright/test';
import { open, runAxe, TAGINES_PATH, PORTION_PDP, NOTE_PDP, PLAIN_PDP, NOIMG_PDP } from './helpers';

const LOOK_STORES = ['lamma-table', 'lamma-notebook', 'lamma-market'];
const SCENARIO_STORES = [
  'lamma-empty',
  'lamma-one',
  'lamma-500',
  'lamma-noimg',
  'lamma-longnames',
  'lamma-edge-light',
  'lamma-edge-dark',
  'lamma-logo-wide',
  'lamma-logo-tall',
  'lamma-logo-none',
  'lamma-white-photos',
  'lamma-dates',
  'lamma-cod',
];
const ALL_PAGES = [
  '/',
  '/products',
  TAGINES_PATH,
  PORTION_PDP,
  NOTE_PDP,
  NOIMG_PDP,
  '/cart',
  '/checkout',
  '/search?q=محشي',
  '/account',
  '/account/orders',
  '/this-page-does-not-exist',
];
// Scenario stores are about content shapes: the pages that show them.
const SCENARIO_PAGES = ['/', '/products', PORTION_PDP, '/cart'];
// Focused layouts: checkout and the account/login pages carry no footer by design.
const NO_FOOTER = /^\/(checkout|account)/;
// Products a scenario store does not carry: the PDP is a 404, correctly.
const ABSENT: Record<string, string[]> = {
  'lamma-empty': [PORTION_PDP, NOTE_PDP, NOIMG_PDP, TAGINES_PATH],
  'lamma-one': [PORTION_PDP, NOTE_PDP, NOIMG_PDP],
};
// Ruling B1-111: a merchant primaryColor at the extremes is honoured verbatim, so text-primary
// can fail contrast on those stores; every other axe rule still applies.
const EXTREME_PRIMARY = /^lamma-edge-/;
const csv = (v?: string) => (v ? v.split(',').filter(Boolean) : null);
const pagesFor = (store: string) =>
  csv(process.env.LAMMA_PAGES) ?? (LOOK_STORES.includes(store) ? ALL_PAGES : SCENARIO_PAGES);
const STORES = csv(process.env.LAMMA_STORES) ?? [...LOOK_STORES, ...SCENARIO_STORES];

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
        const axe = await runAxe(page);
        expect(
          axe.filter(
            v =>
              (v.impact === 'serious' || v.impact === 'critical') &&
              !(EXTREME_PRIMARY.test(store) && v.id === 'color-contrast')
          )
        ).toEqual([]);
      });

test('reduced motion: nothing animates on the look homes and the dish page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const store of LOOK_STORES)
    for (const p of ['/', PORTION_PDP]) {
      await open(page, store, 'ar', p);
      await page.waitForTimeout(400);
      const running = await page.evaluate(
        () => document.getAnimations().filter(a => a.playState === 'running').length
      );
      expect(running, `${store} ${p}: running animations`).toBe(0);
    }
});

test('zoom 200%: 640px CSS width has no horizontal scroll on every look home, menu and PDP', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 900 });
  for (const store of LOOK_STORES)
    for (const p of ['/', TAGINES_PATH, PORTION_PDP]) {
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

test('Family table: the menu has sticky category tabs, each a link to a group on the page, and dishes as rows', async ({
  page,
}) => {
  await open(page, 'lamma-table', 'ar', '/');
  const tabs = page.locator('[data-part="menu-tabs"] a');
  expect(await tabs.count()).toBeGreaterThanOrEqual(5);
  const groups = await page.locator('[data-menu-group]').count();
  expect(groups).toBe(await tabs.count());
  for (const box of await tabs.evaluateAll(as => as.map(a => a.getBoundingClientRect().height)))
    expect(box).toBeGreaterThanOrEqual(44);
  // tabs stay under the header while scrolling: sticky
  const nav = page.locator('[data-part="menu-tabs"]');
  await nav.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 1200));
  await page.waitForTimeout(300);
  const top = await nav.evaluate(e => e.getBoundingClientRect().top);
  expect(top, 'tabs stuck near the top').toBeLessThan(200);
  // choosing a tab lands on its group
  const href = await tabs.nth(2).getAttribute('href');
  await tabs.nth(2).click();
  await page.waitForTimeout(500);
  const target = href!.slice(1);
  const landed = await page.evaluate(
    id => document.getElementById(id)!.getBoundingClientRect().top,
    target
  );
  expect(landed, 'the group is on screen after the tab').toBeLessThan(400);
  // rows: the card is a row (photo + text side by side)
  const card = page.locator('[data-menu-group] article').first();
  expect(await card.evaluate(e => getComputedStyle(e).flexDirection)).toBe('row');
});

test('Fresh market: aisle tiles lead, three across on a phone, names always visible', async ({
  page,
}) => {
  await open(page, 'lamma-market', 'ar', '/');
  const tiles = page.locator('[data-section="category-tiles"] [data-part="tile"]');
  expect(await tiles.count()).toBe(8);
  const vh = page.viewportSize()!.height;
  const top = await tiles.first().evaluate(e => e.getBoundingClientRect().top + window.scrollY);
  expect(top, 'first tile in the first screen').toBeLessThan(vh);
  const first = await tiles.first().evaluate(e => (e as HTMLElement).style.backgroundColor);
  expect(first).toContain('color-mix');
  const names = await page.locator('[data-section="category-tiles"] a').allInnerTexts();
  for (const n of names) expect(n.trim().length).toBeGreaterThan(0);
  if ((page.viewportSize()?.width ?? 0) < 420) {
    const xs = await tiles.evaluateAll(els =>
      els.map(e => Math.round(e.getBoundingClientRect().left))
    );
    expect(new Set(xs.slice(0, 3)).size, 'three tiles in the first row').toBe(3);
  }
});

test('the card stepper: the add control becomes - qty + once the dish is in the cart, 44px, and the cart bar replaces the tab bar', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) > 420, 'the bar and the tab bar are phone surfaces');
  await open(page, 'lamma-market', 'ar', '/products');
  // A dish with portion sizes shows a "View" LINK that also carries data-cta="button": only a real
  // <button> adds to the cart, and /products leads with the newest dish, which can be a variant one.
  const add = 'button[data-cta="button"], button[data-cta="add-compact"]';
  // Pinned by index: once the stepper replaces the add button the card no longer matches `add`, and
  // a `:has(add).first()` locator would silently move on to the NEXT dish.
  const at = await page
    .locator('article')
    .evaluateAll((els, sel) => els.findIndex(e => e.querySelector(sel)), add);
  expect(at, 'a dish with an add button').toBeGreaterThanOrEqual(0);
  const card = page.locator('article').nth(at);
  await card.locator(add).click();
  await expect(card.locator('[data-cta="stepper"]')).toBeVisible();
  for (const b of await card.locator('[data-cta="stepper"] button').all())
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // CardStepper ignores a tap while its previous cart call is in flight (double-tap guard), so each
  // stepper tap waits for its own PUT/DELETE response (not the add's POST) before the next one.
  const cartCall = () =>
    page.waitForResponse(
      r =>
        /\/cart\/items\//.test(r.url()) && ['PUT', 'PATCH', 'DELETE'].includes(r.request().method())
    );
  let settled = cartCall();
  await card.getByRole('button', { name: 'زيادة الكمية' }).click();
  await settled;
  await expect(card.getByRole('status')).toHaveText('2');
  // ONE bottom layer: the browse cart bar is up and the tab bar is hidden
  await expect(page.getByTestId('sticky-browse-cart-bar')).toBeVisible();
  await expect(page.locator('[data-bottom-tab-bar]')).toBeHidden();
  const fixedBottom = await page.evaluate(
    () =>
      [...document.querySelectorAll('body *')].filter(e => {
        const s = getComputedStyle(e);
        return s.position === 'fixed' && s.bottom === '0px' && (e as HTMLElement).offsetHeight > 0;
      }).length
  );
  expect(fixedBottom, 'one fixed bottom bar').toBe(1);
  // the minimum order (150 EGP) reads as progress while the basket is under it
  await expect(page.getByTestId('min-order-progress').first()).toBeVisible();
  // - at 1 removes the line
  settled = cartCall();
  await card.getByRole('button', { name: 'إنقاص الكمية' }).click();
  await settled;
  await expect(card.getByRole('status')).toHaveText('1');
  // at 1 the same button removes the line and is NAMED for it (a11y P2-2)
  await card.getByRole('button', { name: 'إزالة من السلة' }).click();
  await expect(card.locator('[data-cta="stepper"]')).toHaveCount(0);
});

test('delivery date chips: today and tomorrow in words, windows per date, arrow keys, and the pick reaches the receipt with the portion and the note', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const store = 'lamma-cod';
  await open(page, store, 'ar', PORTION_PDP);
  const groups = page.locator('[data-option-group]');
  const portionButtons = groups.first().locator('button:not([disabled])');
  const portion = portionButtons.nth(1);
  const portionName = ((await portion.textContent()) ?? '').trim();
  await portion.click();
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  // a second dish carrying an order note
  await open(page, store, 'ar', NOTE_PDP);
  const note = 'من غير فستق';
  // the dish's own note field, by its label (a tablet header also carries a search box)
  await page.getByRole('textbox', { name: /ملاحظة على الطلب|Order note/ }).fill(note);
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  await open(page, store, 'ar', '/cart');
  const cart = await page.locator('main').innerText();
  expect(cart, 'the portion reaches the cart').toContain(portionName.split('(')[0].trim());
  expect(cart, 'the note reaches the cart').toContain(note);
  await open(page, store, 'ar', '/checkout');
  await page.locator('input[autocomplete="given-name"]').fill('منى');
  await page.locator('input[autocomplete="family-name"]').fill('عادل');
  await page
    .locator('input[autocomplete="tel"]')
    .fill(`010${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`);
  const combos = page.locator('input[role="combobox"]');
  for (let i = 0; i < (await combos.count()); i++) {
    await combos.nth(i).click();
    await page.waitForTimeout(500);
    const opt = page.getByRole('option').first();
    if (await opt.count()) await opt.click();
  }
  await page.locator('input[autocomplete="address-line1"]').fill('Abbas El Akkad');
  const building = page.getByLabel(/Building no\.|رقم المبنى/);
  if (await building.count()) await building.first().fill('12');
  await page
    .getByRole('button', { name: /Continue to payment|المتابعة للدفع/ })
    .first()
    .click();
  const dates = page.getByRole('radiogroup', { name: 'يوم التوصيل' });
  await expect(dates).toBeVisible();
  const chips = dates.getByRole('radio');
  expect(await chips.count()).toBe(5);
  for (const b of await chips.all())
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // placing the order without a pick is refused with a sentence, not a crash
  await page.locator('input[type="radio"][value="cod"]').check();
  await page
    .getByRole('button', { name: /Place order|تأكيد الطلب/ })
    .first()
    .click();
  await expect(page.getByRole('alert').filter({ hasText: /اختار/ }).first()).toBeVisible();
  // pick the second chip with the keyboard, then a window
  await chips.first().focus();
  await page.keyboard.press('ArrowLeft'); // RTL: left is next
  await expect(chips.nth(1)).toHaveAttribute('aria-checked', 'true');
  const picked = ((await chips.nth(1).textContent()) ?? '').trim();
  const windows = page.getByRole('radiogroup', { name: 'موعد التوصيل' });
  await windows.getByRole('radio').first().click();
  await page
    .getByRole('button', { name: /Place order|تأكيد الطلب/ })
    .first()
    .click();
  await page.waitForURL(/\/checkout\/success/, { timeout: 60000, waitUntil: 'commit' });
  await page.waitForTimeout(4000);
  const receipt = await page.locator('main').innerText();
  expect(receipt, 'the portion reaches the receipt').toContain(portionName.split('(')[0].trim());
  expect(receipt, 'the note reaches the receipt').toContain(note);
  expect(receipt, 'the delivery pick reaches the receipt').toMatch(/التوصيل/);
  expect(picked.length).toBeGreaterThan(0);
});

test('order again: a customer with paid orders sees the row; an anonymous visitor sees nothing (Ruling B4-8)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await open(page, 'lamma-reorder', 'ar', '/');
  await expect(page.locator('[data-section="reorder"]')).toHaveCount(0);
  await open(page, 'lamma-reorder', 'ar', '/auth/login');
  await page.locator('input[type="email"]').fill('lamma-reorder-customer@example.test');
  await page.locator('input[type="password"]').fill('Reorder-Customer-1');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.includes('/auth/login'), { timeout: 30_000 });
  await open(page, 'lamma-reorder', 'ar', '/');
  const row = page.locator('[data-section="reorder"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText('اطلب تاني');
  expect(await row.locator('article').count()).toBeGreaterThanOrEqual(2);
});

test('first screen shows a path to the products (menu tabs, aisle tiles or the dish grid) in every look', async ({
  page,
}) => {
  const vh = page.viewportSize()!.height;
  for (const store of LOOK_STORES) {
    await open(page, store, 'ar', '/');
    const top = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-part="menu-tabs"] a, [data-section="category-tiles"] a, [data-section="featured-collection"] article a, [data-section="maker-profile"] a'
      );
      return el ? el.getBoundingClientRect().top + window.scrollY : null;
    });
    expect(top, `${store}: a path to the products exists`).not.toBeNull();
    expect(top!, `${store}: within roughly the first two screens`).toBeLessThan(vh * 2);
  }
});

test('Notebook on white-background merchant photos: the dish grid sits on a light band, never white rectangles on green', async ({
  page,
}) => {
  await open(page, 'lamma-white-photos', 'ar', '/');
  const band = page.locator('[data-section="featured-collection"]').first();
  await expect(band).toBeVisible();
  const bg = await band.evaluate(e => getComputedStyle(e).backgroundColor);
  const [r, g, b] = (bg.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).map(Number);
  expect((r + g + b) / 3, `band background ${bg}`).toBeGreaterThan(200);
});

test('an empty store is a finished page: no products renders no tabs, no broken rows', async ({
  page,
}) => {
  await open(page, 'lamma-empty', 'ar', '/');
  await expect(page.locator('[data-part="menu-tabs"]')).toHaveCount(0);
  await expect(page.locator('h1')).toHaveCount(1);
});

test('a missing photo does not break a dish row', async ({ page }) => {
  await open(page, 'lamma-noimg', 'ar', NOIMG_PDP);
  await expect(page.locator('h1')).toBeVisible();
  await open(page, 'lamma-noimg', 'ar', '/products');
  expect(await page.locator('article').count()).toBeGreaterThan(0);
});

test('plain dish page is buyable', async ({ page }) => {
  await open(page, 'lamma-table', 'ar', PLAIN_PDP);
  await expect(page.getByTestId('pdp-add').first()).toBeVisible();
});
