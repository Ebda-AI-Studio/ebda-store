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

/**
 * A TRUE client-side navigation: the Next app router pushes the route (history.pushState), no document is
 * requested, and a window marker set before survives. Fails the test if the navigation was a full load.
 */
async function clientNav(page: Page, path: string) {
  await page.evaluate(() => {
    (window as unknown as { __alive: boolean }).__alive = true;
  });
  let documents = 0;
  const onReq = (r: Request) => {
    if (r.resourceType() === 'document') documents++;
  };
  page.on('request', onReq);
  const ok = await page.evaluate(p => {
    const w = window as unknown as { next?: { router?: { push(u: string): void } } };
    if (!w.next?.router) return false;
    w.next.router.push(p);
    return true;
  }, path);
  expect(ok, 'window.next.router is available').toBe(true);
  await page.waitForURL(u => u.pathname === path.split('?')[0], { timeout: 10_000 });
  await page.waitForTimeout(2500);
  page.off('request', onReq);
  expect(documents, 'client-side: no document request').toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive)).toBe(
    true
  );
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
  await clientNav(page, '/about/');
  expect(pageViews(seen).length - before, 'exactly one PageView for the route change').toBe(1);
});

test('sensitive query after consent: no Meta request carries email, a number or @', async ({
  page,
}) => {
  const seen = await arm(page);
  await page.goto('/', { waitUntil: 'networkidle' });
  await answer(page, /^(قبول|Accept)/);
  await expect.poll(() => seen.some(u => u.endsWith('fbevents.js'))).toBe(true);
  await expect.poll(() => pageViews(seen).length).toBe(1); // initial PageView settled
  await page.waitForLoadState('networkidle');
  const n = seen.length;
  // value-only leaks and key leaks, client-side from a clean page
  for (const q of ['?email=a@b.com&phone=01001234567&q=shoes', '?ref=a@b.com', '?x=01012345678']) {
    await clientNav(page, '/contact/' + q);
    await clientNav(page, '/about/');
    await page.goto('/contact/' + q, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.goto('/', { waitUntil: 'networkidle' });
  }
  for (const u of seen) {
    expect(decodeURIComponent(u), u).not.toMatch(/email|@|phone|01001234567|01012345678|shoes/i);
  }
  // the only new requests are PageViews of clean routes, never one for a sensitive URL
  expect(seen.slice(n).filter(u => /[?&]dl=[^&]*(%3F|\?)/.test(u))).toEqual([]);
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
  await clientNav(page, '/about/');
  expect(seen.length, 'no Meta request after withdrawal').toBe(n);
});
