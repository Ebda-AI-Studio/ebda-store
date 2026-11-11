/**
 * Meta Pixel on ebda.app is consent-gated and our tracker is its ONLY sender.
 * Needs a build with NEXT_PUBLIC_EBDA_META_PIXEL_ID set
 * (NEXT_PUBLIC_EBDA_META_PIXEL_ID=2631583680604933 npm run build -w @ebda/marketing).
 *
 * A STUB fbevents.js (not Meta's file) mimics the two behaviours that matter: it flushes the queued
 * calls to facebook.com/tr, and it auto-fires PageView on history.pushState unless the page set
 * fbq.disablePushState (the real library does this). Every request carries `dl` (document.location),
 * `rl` (referrer) like the real one, so a leak of ?email= would be visible.
 */
import { test, expect, type Page, type Request } from '@playwright/test';

const META = /(^|\.)(facebook\.com|facebook\.net)$/;
const isMeta = (r: Request) => META.test(new URL(r.url()).hostname);

const STUB = `(function(){
  var f = window.fbq; if (!f) return;
  var id = null;
  function send(ev){ var i = new Image(); i.src = 'https://www.facebook.com/tr?id='+id+'&ev='+ev+'&dl='+encodeURIComponent(location.href)+'&rl='+encodeURIComponent(document.referrer); }
  function run(a){ var m=a[0]; if(m==='init') id=a[1]; else if(m==='track'||m==='trackCustom') send(a[1]); }
  var q = f.queue.slice(); f.callMethod = function(){ run([].slice.call(arguments)); };
  q.forEach(run);
  var push = history.pushState;
  history.pushState = function(){ var r = push.apply(this, arguments); if (!f.disablePushState && id) send('PageView'); return r; };
})();`;

async function arm(page: Page) {
  const seen: string[] = [];
  page.on('request', r => {
    if (isMeta(r)) seen.push(r.url());
  });
  await page.route(/https:\/\/[^/]*facebook\.(com|net)\//, route =>
    route.request().url().endsWith('fbevents.js')
      ? route.fulfill({ contentType: 'text/javascript', body: STUB })
      : route.fulfill({ status: 204, body: '' })
  );
  return seen;
}
const answer = (page: Page, re: RegExp) =>
  page.locator('#ebda-consent button', { hasText: re }).first().click();
const pageViews = (seen: string[]) => seen.filter(u => u.includes('ev=PageView'));

test('no Meta request before consent, none after reject, no noscript pixel', async ({ page }) => {
  const seen = await arm(page);
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#ebda-consent')).toBeVisible({ timeout: 10_000 });
  expect(seen).toEqual([]);
  expect(await page.locator('noscript img[src*="facebook.com"]').count()).toBe(0);
  await answer(page, /^(رفض|Reject)/);
  await page.goto('/about/', { waitUntil: 'networkidle' });
  expect(seen).toEqual([]);
});

test('after Accept: fbevents loads, one PageView per client-side route, never two', async ({
  page,
}) => {
  const seen = await arm(page);
  await page.goto('/', { waitUntil: 'networkidle' });
  await answer(page, /^(قبول|Accept)/);
  await expect.poll(() => seen.some(u => u.endsWith('fbevents.js'))).toBe(true);
  await expect.poll(() => pageViews(seen).length).toBe(1);
  const before = pageViews(seen).length;
  // client-side navigation (Next Link -> history.pushState): the stub would auto-fire a 2nd one if allowed
  await page.locator('a[href^="/about"], a[href^="/en/about"]').first().click();
  await page.waitForURL(/about/);
  await page.waitForTimeout(2500);
  expect(pageViews(seen).length - before, 'exactly one PageView for the route change').toBe(1);
});

test('sensitive query after consent: no Meta request carries email or @', async ({ page }) => {
  const seen = await arm(page);
  await page.goto('/', { waitUntil: 'networkidle' });
  await answer(page, /^(قبول|Accept)/);
  await expect.poll(() => seen.some(u => u.endsWith('fbevents.js'))).toBe(true);
  const n = seen.length;
  await page.goto('/contact/?email=a@b.com&phone=01001234567&q=shoes', {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(2500);
  for (const u of seen) {
    const d = decodeURIComponent(u);
    expect(d, u).not.toMatch(/email|@|phone|01001234567|shoes/i);
  }
  expect(seen.length, 'nothing new sent on the sensitive URL').toBe(n);
});

test('withdraw through the on-page cookie settings, then navigate client-side: zero Meta requests', async ({
  page,
}) => {
  const seen = await arm(page);
  await page.goto('/', { waitUntil: 'networkidle' });
  await answer(page, /^(قبول|Accept)/);
  await expect.poll(() => pageViews(seen).length).toBe(1);
  // reopen via the footer "Cookie settings" control, then Reject all
  await page
    .getByRole('button', { name: /إعدادات الكوكيز|Cookie settings/i })
    .first()
    .click();
  await expect(page.locator('#ebda-consent')).toBeVisible();
  await answer(page, /^(رفض|Reject)/);
  await page.waitForTimeout(500);
  const n = seen.length;
  await page.locator('a[href^="/about"], a[href^="/en/about"]').first().click(); // client-side
  await page.waitForURL(/about/);
  await page.waitForTimeout(2500);
  expect(seen.length, 'no Meta request after withdrawal').toBe(n);
});
