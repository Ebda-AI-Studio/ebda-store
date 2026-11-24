/**
 * Visual editor Task 13: performance budgets. Numbers are MEASURED here and printed as
 * `PERF <name> <value>`; nothing is asserted from a guess.
 *
 *   keystroke -> canvas paint   p95 < 100 ms (laptop, 1280)   p95 < 250 ms (CPU 4x throttle, 390)
 *   admin JS heap after 200 edits   < 150 MB (after a forced GC)
 *   initial editor interactive      < 2.5 s on throttled Fast 4G
 *
 * ADMIN-SIDE BUDGET ONLY: this cannot regress on a storefront memoization change (that is covered by
 * tests/unit/builder-perf-*.test.tsx render counts). The canvas here is the contract fake (fake-canvas.html), so "paint" is the fake's next animation
 * frame after the `render` message: it measures the admin side (edit -> reducer -> coalesced post)
 * plus one frame, NOT the real storefront's React render. The interactive budget runs against
 * `next dev` locally (compiles on demand, slower than production) - run it with `next start` in CI.
 * A skipped frame (coalesced edit) has no paint of its own; only painted values are timed.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API = `http://localhost:${process.env.MOCK_API_PORT || 4510}/api/v1`;
const STORE_ID = '0a0b0c0d-0000-4000-8000-00000000e2e0';
const CANVAS_ORIGIN = 'https://e2e-store.ebda.app';
const FAKE_CANVAS = readFileSync(join(__dirname, 'fake-canvas.html'), 'utf8');

const isArabic = () => test.info().project.name.startsWith('ar');
const width = () => test.info().project.use.viewport!.width;
const narrow = () => width() < 1024;

async function open(page: Page) {
  await page.request.post(`${API}/__test/reset`);
  await page
    .context()
    .addCookies([
      { name: 'admin-lang', value: isArabic() ? 'ar' : 'en', url: 'http://localhost:3101' },
    ]);
  await page.addInitScript(() => localStorage.setItem('accessToken', 'e2e'));
  await page.route(`${CANVAS_ORIGIN}/**`, r =>
    r.fulfill({ contentType: 'text/html', body: FAKE_CANVAS })
  );
}

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
};

async function selectCategories(page: Page) {
  const button = (name: string) => page.getByRole('button', { name }).first();
  if (narrow()) await button(isArabic() ? 'الهيكل' : 'Structure').click();
  await page.getByTestId('tree-select-categories').click();
  // picking a row on a narrow screen already swaps the drawer to the settings pane
  if (narrow() && !(await page.getByTestId('field-title').isVisible()))
    await button(isArabic() ? 'الإعدادات' : 'Settings').click();
  await expect(page.getByTestId('field-title')).toBeVisible();
}

/** Type `text` one key at a time; returns keystroke -> painted latencies in ms. */
async function typeAndMeasure(page: Page, text: string, delay: number): Promise<number[]> {
  await page.evaluate(() => {
    (window as any).__t0 = {};
    document.addEventListener(
      'input',
      e => {
        const t = e.target as HTMLInputElement;
        if (
          t?.dataset?.testid === 'field-title' ||
          (t as any)?.closest?.('[data-testid="field-title"]')
        )
          (window as any).__t0[t.value] = performance.timeOrigin + performance.now();
      },
      true
    );
  });
  const field = page.getByTestId('field-title');
  await field.fill('');
  await field.pressSequentially(text, { delay });
  await expect
    .poll(
      () =>
        page
          .frameLocator('[data-testid="builder-canvas"]')
          .locator('body')
          .evaluate((_b, t) => (window as any).__paints?.[t] !== undefined, text),
      { timeout: 15_000 }
    )
    .toBe(true);
  const paints: Record<string, number> = await page
    .frameLocator('[data-testid="builder-canvas"]')
    .locator('body')
    .evaluate(() => (window as any).__paints);
  const t0: Record<string, number> = await page.evaluate(() => (window as any).__t0);
  return Object.keys(t0)
    .filter(v => paints[v] !== undefined)
    .map(v => paints[v] - t0[v]);
}

test('keystroke -> canvas paint stays inside the budget', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium');
  const phone = width() === 390;
  const laptop = width() === 1280;
  test.skip(!phone && !laptop, 'budgets are defined for the laptop and the 390 phone profile');
  await open(page);
  await page.goto(`/stores/${STORE_ID}/builder`);
  await expect(page.getByTestId('builder')).toBeVisible({ timeout: 60_000 });
  await selectCategories(page);
  const cdp = await page.context().newCDPSession(page);
  if (phone) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const lat = await typeAndMeasure(page, 'x'.repeat(40), 45);
  const value = p95(lat);
  console.log(
    `PERF keystroke-to-paint ${phone ? 'phone4x' : 'laptop'} n=${lat.length} p95=${value.toFixed(1)}ms`
  );
  expect(lat.length).toBeGreaterThan(5);
  expect(value).toBeLessThan(phone ? 250 : 100);
});

test('admin JS heap after 200 edits stays under 150 MB', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium' || width() !== 1280);
  await open(page);
  await page.goto(`/stores/${STORE_ID}/builder`);
  await expect(page.getByTestId('builder')).toBeVisible({ timeout: 60_000 });
  await selectCategories(page);
  const field = page.getByTestId('field-title');
  await field.fill('');
  await field.pressSequentially('ab'.repeat(100), { delay: 5 }); // 200 edits
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const heap = metrics.find(m => m.name === 'JSHeapUsedSize')!.value / 1024 / 1024;
  console.log(`PERF heap-after-200-edits ${heap.toFixed(1)}MB`);
  expect(heap).toBeLessThan(150);
});

test('initial editor interactive on throttled Fast 4G', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium' || width() !== 390);
  test.skip(
    !process.env.PERF_INTERACTIVE_PROD,
    'run against `next start` (PERF_INTERACTIVE_PROD=1): `next dev` compiles on demand and says nothing about production'
  );
  await open(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  const t0 = Date.now();
  await page.goto(`/stores/${STORE_ID}/builder`);
  await expect(page.getByTestId('builder')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('publish-open')).toBeEnabled();
  const ms = Date.now() - t0;
  console.log(`PERF interactive-fast4g ${ms}ms (next dev: compiles on demand)`);
  expect(ms).toBeLessThan(2500);
});
