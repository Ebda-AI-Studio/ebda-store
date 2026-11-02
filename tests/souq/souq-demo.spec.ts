/**
 * The Souq showroom (`storedemo-souq`, Ruling B2-7): bar, ?look= preview, link persistence, template
 * switch to the Qamar demo host with its look, closed ordering, catalogue isolation, noindex.
 * Needs BOTH demo stores seeded locally (seed.mjs for storedemo, seed.mjs --template souq).
 */
import { test, expect } from '@playwright/test';
import { open, hostOf, fetchVia } from './helpers';

const SOUQ = 'storedemo-souq';

// SOUQ_HOST_BASE (see helpers.ts): the production build uses `localhost-b5.test`, not `.localhost`.
const HOST_BASE = (process.env.SOUQ_HOST_BASE ?? 'localhost').replace(/\./g, '\\.');

test('storedemo-souq: bar, look switch, persistence, template switch, closed checkout, noindex', async ({
  page,
}) => {
  const res = await open(page, SOUQ, 'ar', '/');
  expect(res.status()).toBe(200);
  const bar = page.getByRole('region', { name: /متجر تجريبي|Demo store/ });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('متجر تجريبي');
  await expect(bar).not.toContainText('Demo store');
  const template = page.locator('select[data-demo-template]');
  const look = page.locator('select[data-demo-look]');
  await expect(template).toHaveValue('souq');
  await expect(look.locator('option:not([value=""])')).toHaveCount(3);
  await look.selectOption('souq.night');
  await page.waitForURL(/look=souq\.night/);
  await expect(page.locator('body')).toHaveAttribute('data-look', 'souq.night');
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe(
    'noindex, nofollow'
  );
  // Link persistence across a product click.
  await page.locator('a[href*="/products/"]').first().click();
  await page.waitForURL(/\/products\//);
  expect(page.url()).toContain('look=souq.night');
  await expect(page.locator('body')).toHaveAttribute('data-look', 'souq.night');
  // Closed ordering: a cart line is fine, the checkout refuses.
  await page.goto(`${hostOf(SOUQ)}/products/power-bank-20000?look=souq.night`, {
    waitUntil: 'networkidle',
  });
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  await page.goto(`${hostOf(SOUQ)}/checkout?look=souq.night`, { waitUntil: 'networkidle' });
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
  const robots = await fetchVia(page, `${hostOf(SOUQ)}/robots.txt`);
  expect(robots.text).not.toMatch(/^Disallow: \/$/m);
});

test('template switch lands on the Qamar demo host with its look; each catalogue is absent from the other', async ({
  page,
}) => {
  await open(page, SOUQ, 'ar', '/');
  await page.locator('select[data-demo-template]').selectOption('qamar');
  await page.waitForURL(new RegExp(`//storedemo\\.${HOST_BASE}:\\d+/\\?look=qamar\\.`));
  await expect(page.locator('body')).toHaveAttribute('data-look', /^qamar\./);
  // The Qamar catalogue is not on the Souq demo, and the Souq catalogue is not on Qamar's.
  // a second page: the first must stay on the Qamar demo for the switch back
  const probe = await page.context().newPage();
  expect((await fetchVia(probe, `${hostOf(SOUQ)}/products/linen-abaya`)).status).toBe(404);
  expect((await fetchVia(probe, `${hostOf('storedemo')}/products/smartphone-6-7`)).status).toBe(
    404
  );
  // And back: Souq's first built look comes with the switch.
  await page.locator('select[data-demo-template]').selectOption('souq');
  await page.waitForURL(new RegExp(`//storedemo-souq\\.${HOST_BASE}:\\d+/\\?look=souq\\.`));
  await expect(page.locator('body')).toHaveAttribute('data-look', /^souq\./);
});
