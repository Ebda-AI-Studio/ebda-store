import { test, expect } from '@playwright/test';

test.describe('admin smoke @prod', () => {
  test('login page renders with email + password inputs', async ({ page }) => {
    const response = await page.goto('/login', {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.ok(), 'login route returned non-OK status').toBeTruthy();

    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('dashboard redirects unauthenticated visitors to /login', async ({ page }) => {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

    await expect
      .poll(() => new URL(page.url()).pathname, {
        timeout: 10_000,
        message: 'expected /dashboard to redirect to /login when unauth',
      })
      .toMatch(/\/login/);

    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });
});
