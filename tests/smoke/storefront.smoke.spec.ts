import { test, expect } from '@playwright/test';

test.describe('storefront smoke @prod', () => {
  test('home page loads with no critical console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (
          /failed to fetch|cors|csp|chunkloaderror|hydration/i.test(text) &&
          !/google-analytics|gtag|onesignal/i.test(text)
        ) {
          errors.push(text);
        }
      }
    });

    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response?.ok(), 'home page returned non-OK status').toBeTruthy();

    await expect(page).toHaveTitle(/.+/);
    await expect(page.locator('header').first()).toBeVisible();
    await expect(page.locator('main').first()).toBeVisible();
    await expect(page.locator('footer').first()).toBeVisible();

    expect(errors, `console errors on home: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('clicking a product card navigates to a PDP', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const productLink = page.locator('a[href*="/products/"]').first();
    await expect(productLink, 'no product links visible on home').toBeVisible({
      timeout: 15_000,
    });

    await productLink.click();
    await page.waitForURL(/\/products\//, { timeout: 15_000 });

    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page.locator('main').first()).toBeVisible();

    const url = new URL(page.url());
    expect(url.pathname.startsWith('/products/')).toBeTruthy();
  });

  test('cart page is reachable and renders shell', async ({ page }) => {
    const response = await page.goto('/cart', { waitUntil: 'domcontentloaded' });
    expect(response?.status(), 'cart route returned 5xx').toBeLessThan(500);

    await expect(page.locator('header').first()).toBeVisible();
    await expect(page.locator('main').first()).toBeVisible();
  });
});
