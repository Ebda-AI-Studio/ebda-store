/**
 * The Jasmine showroom (`storedemo-jasmine`, Ruling B3-8): bar, ?look= preview, link persistence,
 * template switch to the other demo hosts with their looks, closed ordering, catalogue isolation,
 * noindex. Needs ALL THREE demo stores seeded locally (seed.mjs, --template souq, --template
 * jasmine) and carrying a domain for the stack's host base.
 */
import { test, expect } from '@playwright/test';
import { open, hostOf, fetchVia } from './helpers';

const JASMINE = 'storedemo-jasmine';

test('storedemo-jasmine: bar, look switch, persistence, closed checkout, noindex', async ({
  page,
}) => {
  const res = await open(page, JASMINE, 'ar', '/');
  expect(res.status()).toBe(200);
  const bar = page.getByRole('region', { name: /متجر تجريبي|Demo store/ });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('متجر تجريبي');
  const template = page.locator('select[data-demo-template]');
  const look = page.locator('select[data-demo-look]');
  await expect(template).toHaveValue('jasmine');
  await expect(look.locator('option:not([value=""])')).toHaveCount(3);
  await look.selectOption('jasmine.apothecary');
  await page.waitForURL(/look=jasmine\.apothecary/);
  await expect(page.locator('body')).toHaveAttribute('data-look', 'jasmine.apothecary');
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe(
    'noindex, nofollow'
  );
  // Link persistence across a product click.
  await page.locator('a[href*="/products/"]').first().click();
  await page.waitForURL(/\/products\//);
  expect(page.url()).toContain('look=jasmine.apothecary');
  await expect(page.locator('body')).toHaveAttribute('data-look', 'jasmine.apothecary');
  // Closed ordering: a cart line is fine, the checkout refuses.
  await page.goto(`${hostOf(JASMINE)}/products/sunscreen-spf50?look=jasmine.apothecary`, {
    waitUntil: 'networkidle',
  });
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  await page.goto(`${hostOf(JASMINE)}/checkout?look=jasmine.apothecary`, {
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
  const robots = await fetchVia(page, `${hostOf(JASMINE)}/robots.txt`);
  expect(robots.text).not.toMatch(/^Disallow: \/$/m);
});

test('the bar switches to the other demo hosts and back, each landing on its own first built look', async ({
  page,
}) => {
  await open(page, JASMINE, 'ar', '/');
  const hostBase = process.env.JASMINE_HOST_BASE ?? 'localhost';
  const host = (label: string) =>
    new RegExp(`//${label}\\.${hostBase.replace(/\./g, '\\.')}:\\d+/`);
  await page.locator('select[data-demo-template]').selectOption('souq');
  await page.waitForURL(new RegExp(`${host('storedemo-souq').source}\\?look=souq\\.`));
  await expect(page.locator('body')).toHaveAttribute('data-look', /^souq\./);
  await page.locator('select[data-demo-template]').selectOption('jasmine');
  await page.waitForURL(new RegExp(`${host(JASMINE).source}\\?look=jasmine\\.`));
  await expect(page.locator('body')).toHaveAttribute('data-look', /^jasmine\./);
  await page.locator('select[data-demo-template]').selectOption('qamar');
  await page.waitForURL(new RegExp(`${host('storedemo').source}\\?look=qamar\\.`));
  await expect(page.locator('body')).toHaveAttribute('data-look', /^qamar\./);
});

test('each demo catalogue is absent from the other demo stores (isolation by construction)', async ({
  page,
}) => {
  const status = async (host: string, p: string) =>
    (await fetchVia(page, `${hostOf(host)}${p}`)).status;
  expect(await status(JASMINE, '/products/smartphone-6-7')).toBe(404);
  expect(await status(JASMINE, '/products/linen-abaya')).toBe(404);
  expect(await status('storedemo-souq', '/products/matte-lipstick')).toBe(404);
  expect(await status('storedemo', '/products/matte-lipstick')).toBe(404);
  expect(await status(JASMINE, '/products/matte-lipstick')).toBe(200);
});
