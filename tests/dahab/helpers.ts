import { expect, type Page } from '@playwright/test';
import path from 'node:path';
import pg from 'pg';

const AXE = path.join(process.cwd(), 'node_modules/axe-core/axe.min.js');
const PORT = process.env.DAHAB_PORT ?? '3400';
const HOST_BASE = process.env.DAHAB_HOST_BASE ?? 'localhost';

export const hostOf = (store: string) => `http://${store}.${HOST_BASE}:${PORT}`;

/** Open `p` on `store` in `lang` with the consent banner already accepted. */
export async function open(page: Page, store: string, lang: 'ar' | 'en', p: string) {
  const origin = hostOf(store);
  await page.context().addCookies([
    { name: 'force-language', value: lang, url: origin },
    {
      name: 'force-cookie-consent',
      value: encodeURIComponent(
        JSON.stringify({ marketing: false, v: 1, ts: '2026-10-07T00:00:00Z' })
      ),
      url: origin,
    },
  ]);
  const res = await page.goto(`${origin}${p}`, { waitUntil: 'networkidle' });
  expect(res, p).not.toBeNull();
  return res!;
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  targets: string[];
}

export async function runAxe(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    // @ts-expect-error injected
    const r = await window.axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
    return r.violations.map(
      (v: { id: string; impact: string; nodes: Array<{ target: string[] }> }) => ({
        id: v.id,
        impact: v.impact,
        targets: v.nodes.map(n => n.target.join(' ')).slice(0, 3),
      })
    );
  });
}

/** The category the manifest category screen uses. */
export const RINGS_PATH = '/products?category=rings';
/** The Metal x Size ring: the checkout-data-flow variant case (both names must reach the receipt). */
export const RING_PDP = '/products/silver-band-ring';
/** A ring with REQUIRED engraving: the personalised line (its letters must reach the receipt). */
export const ENGRAVE_PDP = '/products/engraved-ring';
/** A 21 karat chain priced from the gold rate (per-gram making charge). */
export const GOLD_PDP = '/products/gold-chain-21';
/** The 18 karat solitaire whose size variants weigh differently. */
export const GOLD_RING_PDP = '/products/gold-solitaire-18';
/** An option-less, in-stock piece (second cart line, no-option PDP). */
export const PLAIN_PDP = '/products/pearl-necklace';

/**
 * Status and body of a URL through the BROWSER (its host resolver maps the store hosts to the local
 * stack; Playwright's Node-side request context cannot resolve them).
 */
export async function fetchVia(page: Page, url: string) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { status: res!.status(), text: await res!.text() };
}

/** Fill the shipping step like a shopper (a fresh phone number per call: the API caps orders per phone). */
export async function fillShipping(page: Page) {
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
}

/** Continue to payment and place a cash-on-delivery order; resolves on the receipt page. */
export async function placeCodOrder(page: Page) {
  await page
    .getByRole('button', { name: /Continue to payment|المتابعة للدفع/ })
    .first()
    .click();
  await page.locator('input[type="radio"][value="cod"]').check();
  await page
    .getByRole('button', { name: /Place order|تأكيد الطلب/ })
    .first()
    .click();
  try {
    await page.waitForURL(/\/checkout\/success/, { timeout: 60000, waitUntil: 'commit' });
  } catch (e) {
    // say WHY the order was not placed (the checkout's own alert), not just that the URL never changed
    const why = await page
      .getByRole('alert')
      .allInnerTexts()
      .catch(() => []);
    throw new Error(`order not placed; alerts: ${JSON.stringify(why)}; ${String(e).slice(0, 120)}`);
  }
  await page.waitForTimeout(4000); // the receipt's print-in feed
}

/**
 * The checkout caps open unpaid orders per phone, email and IP (stock-hold-cap). A suite that places cash-on-
 * delivery orders from one machine hits the IP cap after a few runs, so the specs that order cancel the open
 * holds of their own scenario store first. LOCAL database only (the URL is checked).
 */
export async function releaseOpenHolds(storeSlug: string) {
  const url = process.env.DAHAB_DB_URL ?? process.env.TEST_DATABASE_URL ?? '';
  if (!/127\.0\.0\.1|localhost|192\.168\.64\./.test(url))
    throw new Error(
      'releaseOpenHolds needs DAHAB_DB_URL or TEST_DATABASE_URL pointing at a LOCAL database'
    );
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(
      `update orders set status = 'cancelled'
        where store_id = (select id from stores where slug = $1)
          and status in ('pending', 'awaiting_payment_confirmation') and payment_status = 'unpaid'`,
      [storeSlug]
    );
  } finally {
    await db.end();
  }
}
