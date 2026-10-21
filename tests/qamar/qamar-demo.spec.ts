/** The showroom (`storedemo`): bar, ?look= preview, link persistence, closed ordering, noindex. */
import { test, expect } from '@playwright/test';
import { open, hostOf } from './helpers';

test('storedemo: bar, look switch, persistence, no-store, closed checkout, noindex', async ({
  page,
}) => {
  const res = await open(page, 'storedemo', 'ar', '/');
  expect(res.status()).toBe(200);
  const bar = page.getByRole('region', { name: /متجر تجريبي|Demo store/ });
  await expect(bar).toBeVisible();
  // The bar reads one language at a time (Arabic here).
  await expect(bar).toContainText('متجر تجريبي');
  await expect(bar).not.toContainText('Demo store');
  const template = page.locator('select[data-demo-template]');
  const look = page.locator('select[data-demo-look]');
  await expect(template).toHaveValue('qamar');
  await expect(look.locator('option:not([value=""])')).toHaveCount(3);
  await look.selectOption('qamar.lookbook');
  await page.waitForURL(/look=qamar\.lookbook/);
  await expect(page.locator('[data-presentation="collage"]').first()).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-look', 'qamar.lookbook');
  const nav = await page.goto(page.url(), { waitUntil: 'networkidle' });
  // middleware.ts sets `private, no-store`; `next dev` behind the local proxy never runs it, so a
  // local run sets QAMAR_NO_MIDDLEWARE=1 and this one assertion is NOT VERIFIED there.
  if (!process.env.QAMAR_NO_MIDDLEWARE)
    expect(nav!.headers()['cache-control'] ?? '').toContain('no-store');
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe(
    'noindex, nofollow'
  );
  // Link persistence.
  await page.locator('a[href*="/products/"]').first().click();
  await page.waitForURL(/\/products\//);
  expect(page.url()).toContain('look=qamar.lookbook');
  await expect(page.locator('body')).toHaveAttribute('data-look', 'qamar.lookbook');
  // Closed ordering: put a piece in the cart (the demo store takes cart lines, not orders).
  await page.goto(`${hostOf('storedemo')}/products/modal-scarf-no-image?look=qamar.lookbook`, {
    waitUntil: 'networkidle',
  });
  for (const g of await page.locator('[data-option-group]').all()) {
    await g.locator('button[aria-pressed="false"]:not([disabled])').first().click();
  }
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(1500);
  await page.goto(`${hostOf('storedemo')}/checkout?look=qamar.lookbook`, {
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
  // No pay action on a demo store. The API's own 403 DEMO_STORE refusal needs a valid cart and
  // body; it is proved by tests/integration/demo-store.test.ts (every order path), not here.
  await expect(page.locator('button[type="submit"]')).toHaveCount(0);
  const robots = await page.request.get(`${hostOf('storedemo')}/robots.txt`);
  expect(await robots.text()).toContain('Disallow: /');
});
