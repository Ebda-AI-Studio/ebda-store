/**
 * File links (marketing). A link to a file (security.txt, sitemap.xml, llms.txt, ...) must be a full page load, never
 * a client-router navigation: with `trailingSlash: true` Next's <Link> turned the footer's `/.well-known/security.txt`
 * into `/.well-known/security/`, a 404 (live on ebda.app until the fix). Clicks the footer link on the home page in
 * both languages and requires the browser to land on the file itself with 200.
 * Needs a static build: npm run build -w @ebda/marketing && npx playwright test -c playwright.marketing.config.ts file-links
 */
import { test, expect } from '@playwright/test';

for (const page0 of ['/', '/en/']) {
  test(`footer security.txt link on ${page0} lands on the file`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(page0, { waitUntil: 'networkidle' });
    const link = page.locator('footer a[href$="/.well-known/security.txt"]').first();
    await expect(link).toBeVisible();
    const nav = page.waitForResponse(r => r.request().isNavigationRequest(), { timeout: 15_000 });
    await link.click();
    const res = await nav;
    expect(new URL(page.url()).pathname).toBe('/.well-known/security.txt');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toContain('text/plain');
  });
}
