/**
 * Lamma fix wave 1 (Phase B4, audits of 2026-10-22), driven in a real browser:
 *  - P1 PLP grid: three dishes are never five 160px cells (Ruling B4-PLP-1, every template);
 *  - P1 a11y 2.4.11: Shift+Tab never parks focus under the sticky header OR the sticky menu tabs
 *    (with a negative control that restores the old offset and must be caught);
 *  - P1 taste: no Arabic text under 12px on the Kitchen notebook (Ruling B4-16);
 *  - P2 a11y 2.4.3 / 4.1.2: the add <-> stepper swap keeps keyboard focus, and `-` at 1 is named for
 *    what it does.
 */
import { test, expect, type Page } from '@playwright/test';
import { open, TAGINES_PATH } from './helpers';

test('PLP: three dishes fill the row, each card at least 180px wide (never five 160px cells)', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1100, 'the auto-fill grid is the lg+ layout');
  for (const store of ['lamma-table', 'lamma-notebook', 'lamma-market']) {
    await open(page, store, 'en', TAGINES_PATH);
    const widths = await page
      .locator('main article')
      .evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().width)));
    expect(widths.length, store).toBeGreaterThan(0);
    for (const w of widths) expect(w, `${store} card width`).toBeGreaterThanOrEqual(180);
  }
});

const OBSTRUCTION = () => {
  const e = document.activeElement as HTMLElement | null;
  if (!e || e === document.body) return null;
  const r = e.getBoundingClientRect();
  const covers = (el: Element | null) => {
    if (!el || el.contains(e)) return 0;
    const b = el.getBoundingClientRect();
    if (b.height <= 0 || b.bottom <= 0) return 0;
    return Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top));
  };
  const header = document.querySelector('header');
  const tabs = document.querySelector('[data-part="menu-tabs"]');
  const stuck = (el: Element | null) => !!el && getComputedStyle(el).position !== 'static';
  const hiddenH = header?.classList.contains('-translate-y-full');
  return {
    label: (e.getAttribute('aria-label') ?? e.textContent ?? e.tagName).trim().slice(0, 30),
    underTabs: stuck(tabs) ? covers(tabs) / Math.max(1, r.height) : 0,
    underHeader: stuck(header) && !hiddenH ? covers(header) / Math.max(1, r.height) : 0,
  };
};

async function walkBack(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, 0));
  const bad: string[] = [];
  // forward through the menu rows, then back: the backward scroll is where the strip hides focus
  for (let i = 0; i < 45; i++) await page.keyboard.press('Tab');
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(350);
    const m = await page.evaluate(OBSTRUCTION);
    if (!m) continue;
    if (m.underTabs > 0.5) bad.push(`under menu tabs: ${m.label}`);
    if (m.underHeader > 0.5) bad.push(`under header: ${m.label}`);
  }
  return bad;
}

test('2.4.11: Shift+Tab through the menu never parks focus under the sticky header or tab strip', async ({
  page,
}) => {
  await open(page, 'lamma-table', 'ar', '/');
  await expect(page.locator('[data-part="menu-tabs"]')).toBeVisible();
  // the strip really sticks (body overflow-x:hidden used to make it scroll away with the page)
  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(500);
  const top = await page.evaluate(
    () => document.querySelector('[data-part="menu-tabs"]')!.getBoundingClientRect().top
  );
  expect(top, 'stuck strip top').toBeGreaterThanOrEqual(0);
  expect(top, 'stuck strip top').toBeLessThan(120);
  expect(await walkBack(page), 'obscured focus').toEqual([]);
});

test('2.4.11 negative control: with the old header-only offset the same walk IS caught', async ({
  page,
}) => {
  // on a phone the strip (61px) is as tall as a dish row's controls; at 1280 the rows are taller and
  // the old offset happens not to hide one, so the control proves the walk on the phone only
  test.skip((page.viewportSize()?.width ?? 0) > 420, 'the walk control is phone-sized');
  await open(page, 'lamma-table', 'ar', '/');
  await page.addStyleTag({
    content: 'html{scroll-padding-top:calc(var(--header-h,0px) + .75rem) !important}',
  });
  const bad = await walkBack(page);
  expect(
    bad.length,
    'the walk must detect an obstruction when the offset is wrong'
  ).toBeGreaterThan(0);
});

test('Kitchen notebook: no Arabic text under 12px in the cart and checkout (Ruling B4-16)', async ({
  page,
}) => {
  const small = async () =>
    page.evaluate(() => {
      const out: string[] = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const el = n.parentElement;
        if (!el || !n.textContent?.trim() || el.closest('[aria-hidden="true"], script, style'))
          continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) continue;
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (px < 12) out.push(`${px}px "${n.textContent.trim().slice(0, 24)}"`);
      }
      return [...new Set(out)];
    });
  await open(page, 'lamma-notebook', 'ar', '/products/okra-tagine');
  await page.getByTestId('pdp-add').first().click();
  await page.waitForTimeout(900);
  await open(page, 'lamma-notebook', 'ar', '/cart');
  expect(await small(), 'cart').toEqual([]);
  await open(page, 'lamma-notebook', 'ar', '/checkout');
  await page
    .getByRole('button', { name: /المتابعة للدفع/ })
    .first()
    .click();
  await page.waitForTimeout(600);
  expect(await small(), 'checkout (with its error lines)').toEqual([]);
});

test('2.4.3: keyboard focus follows the dish across add -> stepper -> add, and - at 1 is named "Remove from cart"', async ({
  page,
}) => {
  await open(page, 'lamma-table', 'en', TAGINES_PATH);
  const card = page.locator('main article').first();
  const add = card.locator('[data-cta="button"], [data-cta="add-compact"]');
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(card.locator('[data-cta="stepper"]')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
    .toBe('Increase quantity');
  const minus = card.locator('[data-cta="stepper"] button').first();
  await expect(minus).toHaveAttribute('aria-label', 'Remove from cart');
  await minus.focus();
  await page.keyboard.press('Enter');
  await expect(card.locator('[data-cta="stepper"]')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-cta')))
    .toMatch(/^(button|add-compact)$/);
});
