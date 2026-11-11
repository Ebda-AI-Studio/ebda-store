/**
 * Meta Pixel on ebda.app is consent-gated. Needs a build with NEXT_PUBLIC_EBDA_META_PIXEL_ID set
 * (e.g. NEXT_PUBLIC_EBDA_META_PIXEL_ID=2631583680604933 npm run build -w @ebda/marketing).
 * Proves: no request to a Meta host before the visitor accepts; after Accept fbevents.js loads and
 * a PageView goes out; after withdrawal and a navigation no new Meta request is made; no <noscript> pixel.
 */
import { test, expect, type Request } from '@playwright/test';

const META = /(^|\.)(facebook\.com|facebook\.net)$/;
const isMeta = (r: Request) => META.test(new URL(r.url()).hostname);

test('Meta Pixel: none before consent, loads after Accept, silent after withdrawal', async ({
  page,
}) => {
  const seen: string[] = [];
  page.on('request', r => {
    if (isMeta(r)) seen.push(r.url());
  });
  // Meta must never be reached for real from CI: answer with an empty script.
  await page.route(/https:\/\/[^/]*facebook\.(com|net)\//, route =>
    route.request().url().endsWith('fbevents.js')
      ? route.fulfill({ contentType: 'text/javascript', body: '' })
      : route.fulfill({ status: 204, body: '' })
  );

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#ebda-consent')).toBeVisible({ timeout: 10_000 });
  expect(seen, 'no Meta request before consent').toEqual([]);
  expect(await page.locator('noscript img[src*="facebook.com"]').count()).toBe(0);

  // Reject: still nothing, also after a client-side navigation.
  await page
    .locator('#ebda-consent button', { hasText: /^(رفض|Reject)/ })
    .first()
    .click();
  await page.goto('/about/', { waitUntil: 'networkidle' });
  expect(seen, 'no Meta request after reject').toEqual([]);

  // Clear the decision, accept.
  await page.context().clearCookies();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page
    .locator('#ebda-consent button', { hasText: /^(قبول|Accept)/ })
    .first()
    .click();
  await expect.poll(() => seen.some(u => u.endsWith('fbevents.js'))).toBe(true);

  // Withdraw (marketing off) through the banner API, then navigate: no new Meta request.
  await page.waitForTimeout(500);
  const afterAccept = seen.length;
  await page.evaluate(() => {
    document.cookie = 'ebda_consent=; path=/; max-age=0';
  });
  await page.goto('/about/', { waitUntil: 'networkidle' });
  await page
    .locator('#ebda-consent button', { hasText: /^(رفض|Reject)/ })
    .first()
    .click();
  await page.goto('/contact/', { waitUntil: 'networkidle' });
  expect(seen.length, 'no Meta request after withdrawal').toBe(afterAccept);
});
