/**
 * The Lamma showroom (`storedemo-lamma`, Ruling B4-10): bar, ?look= preview, link persistence,
 * template switch to the other demo hosts with their looks, closed ordering, catalogue isolation,
 * noindex, and the reorder row that can never show on a demo store (Ruling B4-9). Needs ALL FOUR
 * demo stores seeded locally (seed.mjs, --template souq, lamma, lamma) and carrying a domain for
 * the stack's host base (scripts/lamma-demo/seed-local-hosts.sh).
 */
import { test, expect } from '@playwright/test';
import { open, hostOf, fetchVia } from './helpers';

const LAMMA = 'storedemo-lamma';

test('storedemo-lamma: bar, look switch, persistence, closed checkout, noindex', async ({
  page,
}) => {
  const res = await open(page, LAMMA, 'ar', '/');
  expect(res.status()).toBe(200);
  const bar = page.getByRole('region', { name: /متجر تجريبي|Demo store/ });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('متجر تجريبي');
  const template = page.locator('select[data-demo-template]');
  const look = page.locator('select[data-demo-look]');
  await expect(template).toHaveValue('lamma');
  await expect(look.locator('option:not([value=""])')).toHaveCount(3);
  await look.selectOption('lamma.notebook');
  await page.waitForURL(/look=lamma\.notebook/);
  await expect(page.locator('body')).toHaveAttribute('data-look', 'lamma.notebook');
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe(
    'noindex, nofollow'
  );
  // Link persistence across a product click.
  await page.locator('a[href*="/products/"]').first().click();
  await page.waitForURL(/\/products\//);
  expect(page.url()).toContain('look=lamma.notebook');
  await expect(page.locator('body')).toHaveAttribute('data-look', 'lamma.notebook');
  // Closed ordering: a cart line is fine, the checkout refuses.
  await page.goto(`${hostOf(LAMMA)}/products/baladi-bread?look=lamma.notebook`, {
    waitUntil: 'networkidle',
  });
  // The demo store carries a 150 EGP minimum order (scripts/storedemo/seed.mjs) and the checkout's
  // Continue button stays disabled below it (dcc6751176), so the line must reach the minimum
  // (6 x 25 EGP) before the closed-ordering notice can be reached.
  for (let i = 0; i < 5; i++)
    await page
      .getByRole('button', { name: /زيادة الكمية|Increase quantity/ })
      .first()
      .click();
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  await page.goto(`${hostOf(LAMMA)}/checkout?look=lamma.notebook`, {
    waitUntil: 'networkidle',
  });
  await page.locator('input[autocomplete="given-name"]').fill('Mona');
  await page.locator('input[autocomplete="family-name"]').fill('Adel');
  await page.locator('input[autocomplete="tel"]').fill('01012345678');
  const combos = page.locator('input[role="combobox"]');
  for (let i = 0; i < (await combos.count()); i++) {
    await combos.nth(i).click();
    await page.waitForTimeout(500);
    const opt = page.locator('[role="listbox"] [role="option"], li[role="option"]').first();
    if (await opt.count()) await opt.click();
  }
  await page.locator('input[autocomplete="address-line1"]').fill('Abbas El Akkad');
  const building = page.getByLabel(/Building no\.|رقم المبنى/);
  if (await building.count()) await building.first().fill('12');
  await page
    .getByRole('button', { name: /Continue to payment|المتابعة للدفع/ })
    .first()
    .click();
  await expect(page.locator('[data-demo-checkout-notice]').first()).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toHaveCount(0);
  const robots = await fetchVia(page, `${hostOf(LAMMA)}/robots.txt`);
  expect(robots.text).not.toMatch(/^Disallow: \/$/m);
});

test('the bar switches to the other demo hosts and back, each landing on its own first built look', async ({
  page,
}) => {
  await open(page, LAMMA, 'ar', '/');
  const hostBase = process.env.LAMMA_HOST_BASE ?? 'localhost';
  const host = (label: string) =>
    new RegExp(`//${label}\\.${hostBase.replace(/\./g, '\\.')}:\\d+/`);
  await page.locator('select[data-demo-template]').selectOption('souq');
  await page.waitForURL(new RegExp(`${host('storedemo-souq').source}\\?look=souq\\.`));
  await expect(page.locator('body')).toHaveAttribute('data-look', /^souq\./);
  await page.locator('select[data-demo-template]').selectOption('lamma');
  await page.waitForURL(new RegExp(`${host(LAMMA).source}\\?look=lamma\\.`));
  await expect(page.locator('body')).toHaveAttribute('data-look', /^lamma\./);
  await page.locator('select[data-demo-template]').selectOption('qamar');
  await page.waitForURL(new RegExp(`${host('storedemo').source}\\?look=qamar\\.`));
  await expect(page.locator('body')).toHaveAttribute('data-look', /^qamar\./);
});

test('each demo catalogue is absent from the other demo stores (isolation by construction)', async ({
  page,
}) => {
  const status = async (host: string, p: string) =>
    (await fetchVia(page, `${hostOf(host)}${p}`)).status;
  expect(await status(LAMMA, '/products/smartphone-6-7')).toBe(404);
  expect(await status(LAMMA, '/products/linen-abaya')).toBe(404);
  expect(await status(LAMMA, '/products/matte-lipstick')).toBe(404);
  expect(await status('storedemo-souq', '/products/mahshi-koronb')).toBe(404);
  expect(await status('storedemo', '/products/mahshi-koronb')).toBe(404);
  expect(await status(LAMMA, '/products/mahshi-koronb')).toBe(200);
});

test('the order-again row never shows on a demo store (a demo refuses customers, Ruling B4-9)', async ({
  page,
}) => {
  await open(page, LAMMA, 'ar', '/?look=lamma.market');
  await expect(page.locator('[data-section="reorder"]')).toHaveCount(0);
  await expect(page.getByText('اطلب تاني')).toHaveCount(0);
});
