/**
 * The Dahab showroom (`storedemo-dahab`, Ruling B5-10): bar, ?look= preview, link persistence, template
 * switch to another demo host and back, closed ordering, catalogue isolation, noindex, and the gold line
 * on the demo (its rate is a manual one the seed re-stamps). Needs `storedemo-dahab` and the Qamar
 * `storedemo` seeded locally and carrying a domain for the stack's host base
 * (scripts/dahab-demo/seed-local-hosts.sh; `DAHAB_ALL_SHOWROOMS=1` also seeds the other three).
 */
import { test, expect } from '@playwright/test';
import { open, hostOf, fetchVia, GOLD_PDP } from './helpers';

const DAHAB = 'storedemo-dahab';

test('storedemo-dahab: bar, look switch, persistence, closed checkout, noindex', async ({
  page,
}) => {
  const res = await open(page, DAHAB, 'ar', '/');
  expect(res.status()).toBe(200);
  const bar = page.getByRole('region', { name: /متجر تجريبي|Demo store/ });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('متجر تجريبي');
  const template = page.locator('select[data-demo-template]');
  const look = page.locator('select[data-demo-look]');
  await expect(template).toHaveValue('dahab');
  await expect(look.locator('option:not([value=""])')).toHaveCount(3);
  await look.selectOption('dahab.workshop');
  await page.waitForURL(/look=dahab\.workshop/);
  await expect(page.locator('body')).toHaveAttribute('data-look', 'dahab.workshop');
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe(
    'noindex, nofollow'
  );
  // Link persistence across a product click.
  await page.locator('a[href*="/products/"]').first().click();
  await page.waitForURL(/\/products\//);
  expect(page.url()).toContain('look=dahab.workshop');
  await expect(page.locator('body')).toHaveAttribute('data-look', 'dahab.workshop');
  // Closed ordering: a cart line is fine, the checkout refuses.
  await page.goto(`${hostOf(DAHAB)}/products/pearl-necklace?look=dahab.workshop`, {
    waitUntil: 'networkidle',
  });
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  await page.goto(`${hostOf(DAHAB)}/checkout?look=dahab.workshop`, { waitUntil: 'networkidle' });
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
  const robots = await fetchVia(page, `${hostOf(DAHAB)}/robots.txt`);
  expect(robots.text).not.toMatch(/^Disallow: \/$/m);
});

test('the bar switches to the Qamar demo host and back, each landing on its own first built look', async ({
  page,
}) => {
  await open(page, DAHAB, 'ar', '/');
  const hostBase = process.env.DAHAB_HOST_BASE ?? 'localhost';
  const host = (label: string) =>
    new RegExp(`//${label}\\.${hostBase.replace(/\./g, '\\.')}:\\d+/`);
  await page.locator('select[data-demo-template]').selectOption('qamar');
  await page.waitForURL(new RegExp(`${host('storedemo').source}\\?look=qamar\\.`));
  await expect(page.locator('body')).toHaveAttribute('data-look', /^qamar\./);
  await page.locator('select[data-demo-template]').selectOption('dahab');
  await page.waitForURL(new RegExp(`${host(DAHAB).source}\\?look=dahab\\.`));
  await expect(page.locator('body')).toHaveAttribute('data-look', 'dahab.worn');
});

test('the Dahab catalogue is absent from the Qamar showroom and the reverse (isolation by construction)', async ({
  page,
}) => {
  const status = async (host: string, p: string) =>
    (await fetchVia(page, `${hostOf(host)}${p}`)).status;
  expect(await status(DAHAB, '/products/linen-abaya')).toBe(404);
  expect(await status('storedemo', GOLD_PDP)).toBe(404);
  expect(await status(DAHAB, GOLD_PDP)).toBe(200);
});

test('the demo prices its gold pieces: the rate line and the metal / making split show on a gold piece', async ({
  page,
}) => {
  await open(page, DAHAB, 'ar', GOLD_PDP);
  const line = page.getByTestId('gold-rate-line');
  await expect(line).toBeVisible();
  await expect(line).toContainText('سعر الجرام النهارده');
  await expect(line).toContainText('عيار 21');
  await expect(page.getByTestId('gold-breakdown')).toBeVisible();
  // never the margin or where the rate came from
  expect(await line.innerText()).not.toMatch(/هامش|margin|مصدر|source/i);
});
