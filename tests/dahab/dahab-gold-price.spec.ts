/**
 * Gold-rate pricing, end to end on a real local stack (Phase B5 Task 14): a shopper sees today's rate on a
 * gold piece, adds it, the MERCHANT changes the rate through the admin API (a real store_admin login), the
 * checkout shows "السعر اتحدّث" with old and new, "متابعة" lets the order through at the new price, and the
 * receipt and the admin order carry the frozen snapshot. Then the negative control (no rate change, no
 * notice) and the stale case (the PDP says it cannot be ordered, and the order is refused with the same
 * sentence). Store: `dahab-gold` (scripts/storedemo/scenario-stores.mjs --template dahab), whose owner can
 * log in. LOCAL ONLY: it writes rates, an order and backdates a rate row through the owner DB URL.
 *
 * Needs DAHAB_JWT_SECRET (the local API's JWT secret): merchants sign in at the identity service, so the spec mints the
 * owner's token instead of calling POST /auth/login (409 USE_IDENTITY_SERVICE).
 *
 * Runs at 390-ar and 1280-en (the phone and desktop projects of playwright.dahab.config.ts).
 */
import { test, expect } from '@playwright/test';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { open, runAxe, fillShipping, placeCodOrder, releaseOpenHolds, GOLD_PDP } from './helpers';

const STORE = 'dahab-gold';
const API = process.env.DAHAB_API ?? 'http://localhost:4000/api/v1';
const DB = process.env.DAHAB_DB_URL ?? process.env.TEST_DATABASE_URL ?? '';
const OWNER = { email: 'dahab-gold-owner@example.test' };
const BASE_RATE = 410_000; // 21 karat, piastres per gram: 4,100 EGP
const MOVED_RATE = 430_000; // +4.9 %, under the 5 % jump gate, so no confirmation is asked

test.describe.configure({ mode: 'serial' });

let token = '';
let storeId = '';

async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
/** The merchant sets the 21 karat rate (confirm: a reset to baseline may be a jump). */
const setRate = (ratePerGram: number) =>
  api(`/stores/${storeId}/gold-rates`, {
    method: 'PUT',
    json: { rates: [{ karat: 21, ratePerGram }], confirm: true },
  });

test.beforeAll(async () => {
  expect(DB, 'DAHAB_DB_URL or TEST_DATABASE_URL (a LOCAL owner URL) is required').toMatch(
    /127\.0\.0\.1|localhost|192\.168\.64\./
  );
  // Merchants sign in at the identity service now (POST /auth/login answers 409 USE_IDENTITY_SERVICE), so a
  // local run mints the owner's API token the way the integration tests do: the API's own JWT secret
  // (DAHAB_JWT_SECRET, the secret the local API was started with) over the seeded owner's id.
  const secret = process.env.DAHAB_JWT_SECRET;
  expect(secret, 'DAHAB_JWT_SECRET (the local API JWT secret) is required').toBeTruthy();
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  const owner = await db.query('select id from users where email = $1', [OWNER.email]);
  await db.end();
  expect(
    owner.rowCount,
    'the dahab-gold owner is seeded (scenario-stores.mjs --template dahab)'
  ).toBe(1);
  token = jwt.sign(
    { userId: owner.rows[0].id, email: OWNER.email, role: 'store_admin', tv: 0 },
    secret!,
    {
      expiresIn: '30m',
      issuer: 'ebda-api',
      audience: 'ebda-app',
    }
  );
  const resolved = await fetch(`${API}/public/store/resolve`, {
    headers: { 'x-store-domain': `${STORE}.${process.env.DAHAB_HOST_BASE ?? 'localhost-b5.test'}` },
  });
  storeId = (await resolved.json()).data.store.id;
  expect((await setRate(BASE_RATE)).status).toBe(200);
  await releaseOpenHolds(STORE);
});

test.afterAll(async () => {
  // leave the store fresh for the next run
  if (token && storeId) await setRate(BASE_RATE);
});

test('the shopper sees the rate, the merchant moves it, the checkout says "السعر اتحدّث", Continue lets the order through at the new price, and the receipt and the admin order carry the snapshot', async ({
  page,
}) => {
  test.setTimeout(420_000);
  // 1. the PDP: karat, weight, today's rate
  await open(page, STORE, 'ar', GOLD_PDP);
  const line = page.getByTestId('gold-rate-line').first();
  await expect(line).toContainText('سعر الجرام النهارده');
  await expect(line).toContainText('عيار 21');
  await expect(line).toContainText('4,100');
  // 2. add to cart
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  // 3. the merchant moves the rate through the admin API (a real store_admin token)
  const moved = await setRate(MOVED_RATE);
  expect(moved.status).toBe(200);
  expect(moved.body.data.repriced, 'the rate write repriced the gold rows').toBeGreaterThan(0);
  // 4. checkout: the notice, with the old price struck and the new one after it
  await open(page, STORE, 'ar', '/checkout');
  const notice = page.getByTestId('price-changed-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('السعر اتحدّث');
  expect(await notice.locator('.line-through').count(), 'old price struck').toBeGreaterThan(0);
  expect(
    (await runAxe(page)).filter(v => v.impact === 'serious' || v.impact === 'critical')
  ).toEqual([]);
  // payment is held until the shopper continues
  await fillShipping(page);
  await expect(
    page.getByRole('button', { name: /Continue to payment|المتابعة للدفع/ }).first()
  ).toBeDisabled();
  // 5. Continue -> the notice goes, the order is placed at the new price
  const cont = notice.getByRole('button', { name: 'متابعة' });
  expect((await cont.boundingBox())!.height, 'Continue is a 44px target').toBeGreaterThanOrEqual(
    44
  );
  await cont.click();
  await expect(page.getByTestId('price-changed-notice')).toHaveCount(0, { timeout: 20_000 });
  await placeCodOrder(page);
  // 6. the receipt shows the NEW rate and the snapshot line
  const receiptGold = page.getByTestId('receipt-gold-line');
  await expect(receiptGold).toContainText('4,300');
  await expect(receiptGold).toContainText('عيار 21');
  // 7. the admin order carries the frozen snapshot (and the customer view of it has no margin)
  const orderId = new URL(page.url()).searchParams.get('orderId');
  expect(orderId, 'the receipt URL names the order').toBeTruthy();
  const adminOrder = await api(`/stores/${storeId}/orders/${orderId}`);
  expect(adminOrder.status).toBe(200);
  const snap = adminOrder.body.data.order.items.find((i: any) => i.goldSnapshot)?.goldSnapshot;
  expect(snap, 'the admin order line carries the snapshot').toBeTruthy();
  expect(snap).toMatchObject({ karat: 21, ratePerGram: MOVED_RATE });
  expect(typeof snap.marginBps).toBe('number'); // the merchant sees the margin
  const guest = await fetch(`${API}/public/orders/${orderId}`, {
    headers: { 'x-store-id': storeId },
  });
  const guestBody = JSON.stringify(await guest.json());
  expect(
    guestBody,
    'the shopper never receives the margin, the making charge or the cost'
  ).not.toMatch(/marginBps|makingCharge|"rateId"|"costPrice"/);
});

test('negative control: no rate change, no notice', async ({ page }) => {
  test.setTimeout(240_000);
  await setRate(BASE_RATE);
  await open(page, STORE, 'ar', GOLD_PDP);
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  await open(page, STORE, 'ar', '/checkout');
  await expect(page.getByTestId('gold-rate-line').first()).toBeVisible();
  await expect(page.getByTestId('price-changed-notice')).toHaveCount(0);
  await open(page, STORE, 'ar', '/cart');
  await expect(page.getByTestId('price-changed-notice')).toHaveCount(0);
});

test('stale rate: the PDP says the piece cannot be ordered and disables buying; the order is refused with the same sentence', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  await setRate(BASE_RATE);
  // a shopper with a gold piece already in the cart, on a fresh rate
  await open(page, STORE, 'ar', GOLD_PDP);
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  // the rate goes 30 hours without an update: the SERVER row is backdated (the order gate reads it live)
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  try {
    await db.query(
      "update gold_rates_current set applied_at = now() - interval '30 hours' where store_id = $1 and karat = 21",
      [storeId]
    );
    // 1. the ORDER path refuses with the stale sentence (the gate reads the database, not a clock)
    await open(page, STORE, 'ar', '/checkout');
    await fillShipping(page);
    await page
      .getByRole('button', { name: /Continue to payment|المتابعة للدفع/ })
      .first()
      .click();
    await page.locator('input[type="radio"][value="cod"]').check();
    await page
      .getByRole('button', { name: /Place order|تأكيد الطلب/ })
      .first()
      .click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'مش هنقدر نكمّل الطلب دلوقتي' }).first()
    ).toBeVisible({ timeout: 30_000 });
    await expect(page).not.toHaveURL(/\/checkout\/success/);
    // 2. the PDP: the cached payload still says fresh, so the page turns stale by the BROWSER clock (by
    //    design: a cached page must go stale on time without a purge). A fresh context with a clock 30 h on.
    const ctx = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    try {
      const late = await ctx.newPage();
      await late.clock.install({ time: new Date(Date.now() + 30 * 3600_000) });
      await open(late, STORE, 'ar', GOLD_PDP);
      const stale = late.getByTestId('gold-stale');
      await expect(stale).toBeVisible({ timeout: 15_000 });
      await expect(stale).toContainText('مش هنقدر نكمّل الطلب دلوقتي');
      await expect(late.getByTestId('gold-last-price')).toContainText('آخر سعر');
      await expect(late.getByTestId('pdp-add').first()).toBeDisabled();
      expect(
        (await runAxe(late)).filter(v => v.impact === 'serious' || v.impact === 'critical')
      ).toEqual([]);
    } finally {
      await ctx.close();
    }
  } finally {
    await db.end();
    await setRate(BASE_RATE); // a fresh rate again (also proves a stale store recovers by a rate write)
  }
});
