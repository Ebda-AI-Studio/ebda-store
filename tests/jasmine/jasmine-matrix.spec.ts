/**
 * Jasmine scenario matrix (Phase B3 Task 6): the three looks plus the scenario stores
 * (scripts/storedemo/scenario-stores.mjs --template jasmine) x ar/en x the page list, per viewport
 * project. JASMINE_STORES / JASMINE_PAGES (comma lists) narrow a run; unset runs the full matrix on
 * the look stores and the key pages on the scenario stores.
 */
import { test, expect } from '@playwright/test';
import { open, runAxe, TAG, TAG_PATH, SHADE_PDP, PLAIN_PDP, NOIMG_PDP } from './helpers';

const LOOK_STORES = ['jasmine-apothecary', 'jasmine-bloom', 'jasmine-clinic'];
const SCENARIO_STORES = [
  'jasmine-empty',
  'jasmine-one',
  'jasmine-500',
  'jasmine-noimg',
  'jasmine-longnames',
  'jasmine-edge-light',
  'jasmine-edge-dark',
  'jasmine-logo-wide',
  'jasmine-logo-tall',
  'jasmine-logo-none',
  'jasmine-white-photos',
  'jasmine-cod',
];
const ALL_PAGES = [
  '/',
  '/products',
  '/products?category=serums',
  TAG_PATH,
  SHADE_PDP,
  NOIMG_PDP,
  '/cart',
  '/checkout',
  '/search?q=سيروم',
  '/compare',
  '/account',
  '/account/orders',
  '/this-page-does-not-exist',
];
// Scenario stores are about content shapes: the pages that show them.
const SCENARIO_PAGES = ['/', '/products', SHADE_PDP, '/cart'];
// Focused layouts: checkout and the account/login pages carry no footer by design.
const NO_FOOTER = /^\/(checkout|account)/;
// Products a scenario store does not carry: the PDP is a 404, correctly.
const ABSENT: Record<string, string[]> = {
  'jasmine-empty': [SHADE_PDP, NOIMG_PDP, TAG_PATH],
  'jasmine-one': [SHADE_PDP, NOIMG_PDP],
};
// Ruling B1-111: a merchant primaryColor at the extremes is honoured verbatim, so text-primary
// can fail contrast on those stores; every other axe rule still applies.
const EXTREME_PRIMARY = /^jasmine-edge-/;
const csv = (v?: string) => (v ? v.split(',').filter(Boolean) : null);
const pagesFor = (store: string) =>
  csv(process.env.JASMINE_PAGES) ?? (LOOK_STORES.includes(store) ? ALL_PAGES : SCENARIO_PAGES);
const STORES = csv(process.env.JASMINE_STORES) ?? [...LOOK_STORES, ...SCENARIO_STORES];

for (const store of STORES)
  for (const lang of ['ar', 'en'] as const)
    for (const p of pagesFor(store))
      test(`${store} ${lang} ${p}`, async ({ page }) => {
        const res = await open(page, store, lang, p);
        const absent = p.includes('does-not-exist') || ABSENT[store]?.includes(p);
        // an unknown tag is an empty PLP (200), a missing product is a 404
        const expected =
          absent && p.startsWith('/products/')
            ? 404
            : absent && p.includes('does-not-exist')
              ? 404
              : 200;
        expect(res.status(), p).toBe(expected);
        await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
        ).toBeLessThanOrEqual(0);
        await expect(page.locator('main')).toHaveCount(1);
        // The platform 404 page is its own bare layout (header and footer absent).
        if (expected === 200) {
          await expect(page.locator('header')).toHaveCount(1);
          // the page-level footer only: a testimonial's attribution <footer> is not a landmark
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

test('reduced motion: the playful details resolve static, nothing animates', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const store of LOOK_STORES)
    for (const p of ['/', SHADE_PDP]) {
      await open(page, store, 'ar', p);
      await page.waitForTimeout(400);
      const running = await page.evaluate(
        () => document.getAnimations().filter(a => a.playState === 'running').length
      );
      expect(running, `${store} ${p}: running animations`).toBe(0);
    }
});

test('zoom 200%: 640px CSS width has no horizontal scroll on every look home, PLP and PDP', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 900 });
  for (const store of LOOK_STORES)
    for (const p of ['/', TAG_PATH, SHADE_PDP]) {
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

test('first screen shows a path to the products (chips, rail or categories) in every look', async ({
  page,
}) => {
  const vh = page.viewportSize()!.height;
  for (const store of LOOK_STORES) {
    await open(page, store, 'ar', '/');
    const top = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-section="tag-chips"] a, [data-section="category-rail"] a, [data-section="category-grid"] a'
      );
      return el ? el.getBoundingClientRect().top + window.scrollY : null;
    });
    expect(top, `${store}: a category / tag link exists`).not.toBeNull();
    expect(top!, `${store}: first path link within the first screen`).toBeLessThan(vh);
  }
});

test('skin-type chips do real work: each chip lands on a non-empty PLP filtered by that tag and shows the count', async ({
  page,
}) => {
  for (const store of ['jasmine-apothecary', 'jasmine-clinic'])
    for (const lang of ['ar', 'en'] as const) {
      await open(page, store, lang, '/');
      const n = await page.locator('[data-section="tag-chips"] a').count();
      expect(n, `${store}: chips`).toBeGreaterThanOrEqual(5);
      const hrefs = await page
        .locator('[data-section="tag-chips"] a')
        .evaluateAll(as => as.map(a => (a as HTMLAnchorElement).href));
      for (const href of hrefs) {
        await page.goto(href, { waitUntil: 'networkidle' });
        expect(new URL(href).searchParams.get('tag'), href).toBeTruthy();
        const cards = await page.locator('article[itemtype]').count();
        expect(cards, `${store} ${href}: a chip is never a dead end`).toBeGreaterThan(0);
        await expect(page.locator('[data-zone="tagFilter"] [role="status"]')).toBeVisible();
        await expect(page.locator('[data-zone="tagFilter"] button')).toBeVisible();
      }
    }
});

test('the tag filter has a clear control and an unknown tag is an empty list, not everything', async ({
  page,
}) => {
  await open(page, 'jasmine-clinic', 'ar', TAG_PATH);
  const filtered = await page.locator('article[itemtype]').count();
  await page.locator('[data-zone="tagFilter"] button').click();
  await expect.poll(() => page.locator('article[itemtype]').count()).toBeGreaterThan(filtered);
  await open(page, 'jasmine-clinic', 'ar', `/products?tag=${encodeURIComponent('مش موجود')}`);
  expect(await page.locator('article[itemtype]').count()).toBe(0);
});

test('Clinic routine: ordered steps, "add all" adds the real bundle with its live saving', async ({
  page,
}) => {
  await open(page, 'jasmine-clinic', 'ar', '/');
  const steps = page.locator('[data-section="steps"] ol > li');
  await expect(steps).toHaveCount(3);
  await expect(page.locator('[data-section="steps"] ol')).toHaveCount(1);
  const add = page.getByRole('button', { name: /إضافة الكل للسلة/ });
  await expect(add).toBeVisible();
  // the saving is the bundle's (15%), fetched live
  await expect(page.locator('[data-section="steps"]')).toContainText('وفّر 15%');
  const box = await add.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await add.click();
  await open(page, 'jasmine-clinic', 'ar', '/cart');
  // one bundle row, not three loose lines
  await expect(page.locator('[data-part="bundle-line"], [data-bundle-line]').first()).toBeVisible();
  // and the steps tick once their products are in the cart
  await open(page, 'jasmine-clinic', 'ar', '/');
  await expect(
    page.locator('[data-section="steps"] [data-part="step"][data-done="true"]')
  ).toHaveCount(3);
});

test('PDP: rating line and bundle saving render and link to their targets; a product with neither shows neither', async ({
  page,
}) => {
  await open(page, 'jasmine-clinic', 'ar', '/products/niacinamide-serum');
  const rating = page.locator('[data-zone="ratingSummary"]');
  await expect(rating).toHaveCount(1);
  await expect(rating).toContainText('4.7');
  expect((await rating.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(rating).toHaveAttribute('href', '#reviews');
  const saving = page.locator('[data-zone="bundleSaving"]');
  await expect(saving).toContainText('وفّر 15%');
  // a product with no review and no bundle shows neither line
  await open(page, 'jasmine-clinic', 'ar', NOIMG_PDP);
  await expect(page.locator('[data-zone="ratingSummary"]')).toHaveCount(0);
  await expect(page.locator('[data-zone="bundleSaving"]')).toHaveCount(0);
});

test('PDP fold at 390: with the rating line, the bundle line and the instalment line on, the buy path stays in the first screen', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) > 420, 'fold is a phone measurement');
  await open(page, 'jasmine-clinic', 'ar', '/products/niacinamide-serum');
  await expect(page.locator('[data-zone="ratingSummary"]')).toHaveCount(1);
  await expect(page.locator('[data-zone="bundleSaving"]')).toHaveCount(1);
  await expect(page.getByTestId('instalment-line')).toHaveCount(1);
  const vh = page.viewportSize()!.height;
  const bottoms = await page.evaluate(() => {
    const b = (sel: string) => {
      const e = document.querySelector(sel);
      return e ? e.getBoundingClientRect().bottom : null;
    };
    return {
      title: b('[data-zone="productName"]'),
      price: b('[data-zone="productPrice"]'),
      add: b('[data-testid="pdp-add"]'),
    };
  });
  expect(bottoms.title, 'title in the fold').toBeLessThan(vh);
  expect(bottoms.price, 'price in the fold').toBeLessThan(vh);
  // the add action in the first screen is the sticky bar (the inline button sits below the fold)
  await expect(page.getByTestId('sticky-atc')).toBeInViewport();
  await expect(page.getByTestId('sticky-atc-cart')).toBeInViewport();
});

test('checkout data flow: a Shade x Size lipstick placed as a COD order, the variant names reach the cart summary and the receipt', async ({
  page,
}) => {
  test.setTimeout(240_000);
  for (const store of LOOK_STORES) {
    await open(page, store, 'ar', SHADE_PDP);
    // pick a shade and a size through the real selector
    const groups = page.locator('[data-option-group]');
    await expect(groups).toHaveCount(2);
    const shade = groups.nth(0).locator('button:not([disabled])').nth(1);
    const shadeName = (await shade.getAttribute('aria-label')) ?? '';
    await shade.click();
    const size = groups.nth(1).locator('button:not([disabled])').last();
    const sizeName = ((await size.textContent()) ?? '').trim();
    await size.click();
    expect(shadeName.length, 'shade has a name').toBeGreaterThan(0);
    await page.getByTestId('pdp-add').first().click();
    await page.waitForTimeout(1500);
    await open(page, store, 'ar', '/cart');
    const cart = await page.locator('main').innerText();
    expect(cart, `${store}: shade in the cart`).toContain(shadeName.split(',')[0].trim());
    expect(cart, `${store}: size in the cart`).toContain(sizeName);
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
    await page.locator('input[autocomplete="address-line1"]').fill('عباس العقاد');
    const building = page.getByLabel(/Building no\.|رقم المبنى/);
    if (await building.count()) await building.first().fill('12');
    await page
      .getByRole('button', { name: /Continue to payment|المتابعة للدفع/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    const summary = await page.locator('main').innerText();
    expect(summary, `${store}: shade in the checkout summary`).toContain(
      shadeName.split(',')[0].trim()
    );
    const cod = page.locator('input[type="radio"][value="cod"]');
    if (await cod.count()) await cod.check();
    await page
      .getByRole('button', { name: /Place order|تأكيد الطلب/ })
      .first()
      .click();
    await page.waitForURL(/\/checkout\/success/, { timeout: 60000, waitUntil: 'commit' });
    await page.waitForTimeout(4000);
    const receipt = await page.locator('main').innerText();
    expect(receipt, `${store}: shade on the receipt`).toContain(shadeName.split(',')[0].trim());
    expect(receipt, `${store}: size on the receipt`).toContain(sizeName);
  }
});

test('Apothecary on white-background merchant photos: no white rectangle on the olive ground', async ({
  page,
}) => {
  await open(page, 'jasmine-white-photos', 'en', '/products');
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    for (const img of document.querySelectorAll<HTMLImageElement>('img[src*="white-photo"]')) {
      // Walk up to the first ancestor with a painted background: the ground the photo sits on.
      let e: HTMLElement | null = img.parentElement;
      let bg = 'rgba(0, 0, 0, 0)';
      while (e && /rgba\(0, 0, 0, 0\)|transparent/.test((bg = getComputedStyle(e).backgroundColor)))
        e = e.parentElement;
      const m = /rgba?\((\d+), (\d+), (\d+)/.exec(bg);
      // a photo on a LIGHT ground (the paper matte, or the light band's card) reads as intended;
      // on the dark olive it is a white box
      const lum = m ? Number(m[1]) + Number(m[2]) + Number(m[3]) : 0;
      if (lum < 3 * 200) out.push(`${img.alt}: ${bg}`);
    }
    return out;
  });
  expect(bad, 'white photos sitting on a dark ground without a matte').toEqual([]);
  // the page itself stays olive (page #24291C = rgb(36, 41, 28))
  const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // hsl rounding: within 2 of #24291C
  const [r, g, b] = body.match(/\d+/g)!.slice(0, 3).map(Number);
  expect(
    [Math.abs(r! - 36), Math.abs(g! - 41), Math.abs(b! - 28)].every(d => d <= 2),
    body
  ).toBe(true);
});

test('Arabic-Indic numerals pass: a store that opts in shows Arabic-Indic digits on the PDP price', async ({
  page,
}) => {
  await open(page, 'jasmine-edge-light', 'ar', SHADE_PDP);
  const price = (await page.locator('[data-zone="productPrice"]').first().innerText()).trim();
  expect(price, 'Arabic-Indic digits').toMatch(/[٠-٩]/);
  await open(page, 'jasmine-clinic', 'ar', SHADE_PDP);
  const western = (await page.locator('[data-zone="productPrice"]').first().innerText()).trim();
  expect(western, 'Western digits by default').toMatch(/[0-9]/);
});

test('slow 3G: the Clinic home paints its content with no layout shift', async ({
  page,
  context,
}) => {
  await open(page, 'jasmine-clinic', 'ar', '/');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 400,
    downloadThroughput: (400 * 1024) / 8,
    uploadThroughput: (400 * 1024) / 8,
  });
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver(list => {
      for (const e of list.getEntries() as Array<
        PerformanceEntry & { value: number; hadRecentInput: boolean }
      >)
        if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(`${await page.evaluate(() => location.origin)}/`, {
    waitUntil: 'load',
    timeout: 120_000,
  });
  const lcp = await page.evaluate(
    () =>
      new Promise<number>(resolve => {
        new PerformanceObserver(l => {
          const e = l.getEntries().at(-1);
          if (e) resolve(e.startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        setTimeout(() => resolve(-1), 20_000);
      })
  );
  expect(lcp, 'an LCP entry exists').toBeGreaterThan(0);
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  expect(cls, 'cumulative layout shift').toBeLessThan(0.1);
});

test('keyboard only on Clinic: header, a concern chip, then a product card, each with a visible focus ring', async ({
  page,
}) => {
  await open(page, 'jasmine-clinic', 'en', '/');
  const seen: Array<{ tag: string; chip: boolean; card: boolean; ring: boolean }> = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const e = document.activeElement as HTMLElement;
        const s = getComputedStyle(e);
        return {
          tag: e.tagName,
          chip: !!e.closest('[data-section="tag-chips"]'),
          card:
            !!e.closest('[data-product-card], [data-part="card"]') ||
            /\/products\//.test(e.getAttribute('href') ?? ''),
          ring: !(s.outlineStyle === 'none' && s.boxShadow === 'none'),
        };
      })
    );
  }
  expect(
    seen.some(s => s.chip),
    'a concern chip reached'
  ).toBe(true);
  expect(
    seen.some(s => s.card),
    'a product card reached'
  ).toBe(true);
  expect(
    seen.filter(s => s.tag !== 'BODY' && s.tag !== 'NEXTJS-PORTAL' && !s.ring),
    'focused elements without a visible ring'
  ).toEqual([]);
});

test('PDP: shade dots, a struck-through sold-out size, a sale, the instalment line (PDP only), backorder', async ({
  page,
}) => {
  await open(page, 'jasmine-bloom', 'en', SHADE_PDP);
  // Plum / Mini 2 g is sold out: pick Plum then a disabled, struck size appears
  await page.locator('[data-option-group] button[aria-label*="Plum"]').first().click();
  const struck = await page.evaluate(() =>
    [...document.querySelectorAll('[data-option-group] button')].some(
      b =>
        (b as HTMLButtonElement).disabled &&
        (getComputedStyle(b).textDecorationLine.includes('line-through') ||
          !!b.querySelector('svg line'))
    )
  );
  expect(struck, 'an unavailable option is struck').toBe(true);
  await expect(page.getByTestId('instalment-line')).toHaveCount(1);
  await open(page, 'jasmine-bloom', 'en', '/products');
  await expect(page.getByTestId('instalment-line')).toHaveCount(0);
  // backorder CTA on the sold-out spot patches
  await open(page, 'jasmine-bloom', 'en', '/products/acne-spot-patches');
  await expect(
    page.getByRole('button', { name: /pre-?order|backorder|اطلب مسبق|طلب مسبق|order now/i }).first()
  ).toBeVisible();
  // a sale shows a crossed price
  await open(page, 'jasmine-bloom', 'en', '/products/vitamin-c-serum');
  const crossed = await page.evaluate(
    () =>
      [...document.querySelectorAll('body *')].filter(
        e =>
          [...e.childNodes].some(n => n.nodeType === 3 && /\d/.test(n.textContent ?? '')) &&
          getComputedStyle(e).textDecorationLine.includes('line-through')
      ).length
  );
  expect(crossed, 'crossed price').toBeGreaterThan(0);
  void TAG;
  void PLAIN_PDP;
});
