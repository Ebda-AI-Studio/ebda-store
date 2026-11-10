/**
 * Pre-launch shopper journey against PRODUCTION (docs/testing/prelaunch-program.md).
 *
 * Read-only by default: home, search, PDP, add to cart, cart, checkout form (stops before submit).
 * PRELAUNCH_WRITE=1 (QA store only) also places ONE cash-on-delivery order per project+language,
 * checks it in the merchant API (what store.ebda.app and orders.ebda.app read), moves it
 * confirmed -> processing -> shipped, checks the shopper's view of the status, then cancels it.
 *
 * Env: PRELAUNCH_STORE_SLUG (storefront host <slug>.ebda.app), PRELAUNCH_WRITE=1,
 *      PRELAUNCH_EMAIL / PRELAUNCH_PASSWORD (QA merchant, only for the write journey).
 */
import { expect, test, type Page } from '@playwright/test';

const API = process.env.EBDA_API ?? 'https://api.ebda.app/api/v1';
const ACCOUNTS = process.env.EBDA_ACCOUNTS ?? 'https://accounts.ebda.app';
const WRITE = process.env.PRELAUNCH_WRITE === '1';
const SEARCH_TERM = process.env.PRELAUNCH_SEARCH ?? 'kaftan';

const LANGS = ['ar', 'en'] as const;
type Lang = (typeof LANGS)[number];

async function open(page: Page, lang: Lang, path: string) {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await page.context().addCookies([
    { name: 'force-language', value: lang, url: origin },
    {
      name: 'force-cookie-consent',
      value: encodeURIComponent(
        JSON.stringify({ marketing: false, v: 1, ts: '2026-11-10T00:00:00Z' })
      ),
      url: origin,
    },
  ]);
  const res = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  return res;
}

/** Console errors that are not ours to fix (browser extensions, aborted prefetches). */
const IGNORED_CONSOLE =
  /favicon|ERR_ABORTED|net::ERR_BLOCKED_BY_CLIENT|Failed to load resource.*(beacon|analytics)/i;

async function noHorizontalScroll(page: Page) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(over, 'page scrolls sideways').toBeLessThanOrEqual(1);
}

async function firstProductPath(page: Page): Promise<string> {
  const href = await page.locator('a[href*="/products/"]').first().getAttribute('href');
  expect(href, 'a product link on the page').toBeTruthy();
  return new URL(href!, page.url()).pathname;
}

async function chooseOptions(page: Page) {
  for (const g of await page.locator('[data-option-group]').all()) {
    const free = g.locator('button[aria-pressed="false"]:not([disabled])').first();
    if (await free.count()) await free.click();
  }
}

async function fillCheckout(page: Page) {
  await page.locator('input[autocomplete="given-name"]').fill('QA');
  await page.locator('input[autocomplete="family-name"]').fill('Prelaunch');
  // A test number pattern: the QA store's WhatsApp/SMS to shoppers is not wired to a real person.
  await page
    .locator('input[autocomplete="tel"]')
    .fill(process.env.PRELAUNCH_SHOPPER_PHONE ?? '01012345678');
  const email = page.locator('input[autocomplete="email"]');
  if (await email.count())
    await email
      .first()
      .fill(process.env.PRELAUNCH_SHOPPER_EMAIL ?? 'as.montaseer+qashopper@gmail.com');
  const combos = page.locator('input[role="combobox"]');
  for (let i = 0; i < (await combos.count()); i++) {
    await combos.nth(i).click();
    const opt = page.locator('[role="listbox"] [role="option"], li[role="option"]').first();
    await opt.waitFor({ timeout: 5_000 }).catch(() => {});
    if (await opt.count()) await opt.click();
  }
  await page
    .locator('input[autocomplete="address-line1"]')
    .fill('12 Abbas El Akkad, QA test address');
  const building = page.getByLabel(/Building no\.|رقم المبنى/);
  if (await building.count()) await building.first().fill('12');
}

async function merchantToken(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post(`${ACCOUNTS}/login`, {
    data: {
      email: process.env.PRELAUNCH_EMAIL,
      password: process.env.PRELAUNCH_PASSWORD,
      aud: 'store',
    },
  });
  expect(res.status(), 'QA merchant sign-in').toBe(200);
  return (await res.json()).data.access_token as string;
}

for (const lang of LANGS) {
  test.describe(`${lang}`, () => {
    test(`home renders (${lang})`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', m => {
        if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text()))
          errors.push(m.text().slice(0, 200));
      });
      const res = await open(page, lang, '/');
      expect(res?.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', new RegExp(`^${lang}`));
      await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
      await expect(page.locator('header').first()).toBeVisible();
      await expect(page.locator('main').first()).toBeVisible();
      await expect(page.locator('a[href*="/products/"]').first()).toBeVisible();
      await noHorizontalScroll(page);
      expect(errors, 'console errors').toEqual([]);
    });

    test(`search finds products (${lang})`, async ({ page }) => {
      const res = await open(page, lang, `/search?q=${encodeURIComponent(SEARCH_TERM)}`);
      expect(res?.status()).toBe(200);
      await expect(page.locator('a[href*="/products/"]').first()).toBeVisible();
    });

    test(`PDP -> cart -> checkout form (${lang})`, async ({ page }) => {
      await open(page, lang, '/');
      const pdp = await firstProductPath(page);
      const res = await open(page, lang, pdp);
      expect(res?.status()).toBe(200);
      await expect(page.locator('h1').first()).toBeVisible();
      await noHorizontalScroll(page);
      await chooseOptions(page);
      await page.getByTestId('pdp-add').first().click();
      await page.waitForTimeout(1500);
      const cart = await open(page, lang, '/cart');
      expect(cart?.status()).toBeLessThan(500);
      await expect(page.locator('a[href*="/products/"]').first()).toBeVisible();
      await noHorizontalScroll(page);
      await open(page, lang, '/checkout');
      await expect(page.locator('input[autocomplete="tel"]')).toBeVisible();
      await noHorizontalScroll(page);
      if (!WRITE) return;

      // ---- write journey: QA store only ----
      await fillCheckout(page);
      await page
        .getByRole('button', { name: /Continue to payment|المتابعة للدفع/ })
        .first()
        .click();
      await page.locator('input[name="paymentMethod"][value="cod"]').check();
      await page.getByRole('button', { name: /Place order|تأكيد الطلب/ }).click();
      await page.waitForURL(/checkout\/success\?orderId=/, { timeout: 45_000 });
      const orderId = new URL(page.url()).searchParams.get('orderId')!;
      await expect(page.getByTestId('success-cod-banner')).toBeVisible();
      test.info().annotations.push({ type: 'orderId', description: orderId });

      const token = await merchantToken(page.request);
      const auth = { authorization: `Bearer ${token}` };
      const stores = (await (await page.request.get(`${API}/stores`, { headers: auth })).json())
        .data.stores;
      const slug = new URL(test.info().project.use.baseURL!).hostname.split('.')[0];
      const store = stores.find((s: { slug: string }) => s.slug === slug);
      expect(store, 'QA store owned by the QA merchant').toBeTruthy();
      const base = `${API}/stores/${store.id}/orders`;
      try {
        // Merchant side: the order is in the list admin + the orders app read.
        const list = await page.request.get(`${base}?limit=20`, { headers: auth });
        expect(list.status()).toBe(200);
        expect(JSON.stringify(await list.json())).toContain(orderId);
        for (const status of ['confirmed', 'processing', 'shipped']) {
          const r = await page.request.put(`${base}/${orderId}/status`, {
            headers: auth,
            data: { status },
          });
          expect(r.status(), `status -> ${status}`).toBe(200);
        }
        // Shopper side: the same browser session reads its order's status.
        const mine = await page.request.get(`${API}/public/orders/${orderId}`, {
          headers: { 'x-store-id': store.id },
        });
        expect(mine.status()).toBe(200);
        expect((await mine.json()).data.order.status).toBe('shipped');
      } finally {
        // Clean up: the QA order never stays open (it would hold stock).
        await page.request.put(`${base}/${orderId}/status`, {
          headers: auth,
          data: { status: 'cancelled' },
        });
      }
    });
  });
}
