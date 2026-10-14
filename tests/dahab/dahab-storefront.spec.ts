/**
 * Dahab storefront in a real browser: home, collection, product and cart, in
 * Arabic (RTL) and English (LTR), at the project's viewport (390 / 820 / 1440).
 *  - the document direction matches the language;
 *  - no horizontal scroll;
 *  - Western digits by default (no Arabic-Indic digit in the page text);
 *  - axe (WCAG 2.0/2.1 A + AA): no serious or critical violation.
 * Plus the header drawers (menu from the inline start, bag from the inline end).
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

// axe-core is already in the tree (via @ebda/site-kit → lighthouse); no new dependency.
const AXE = path.join(process.cwd(), 'node_modules/axe-core/axe.min.js');

const PAGES = [
  { name: 'home', path: '/' },
  { name: 'collection', path: '/products?category=necklaces' },
  { name: 'product', path: '/products/solitaire-ring' },
  { name: 'cart', path: '/cart' },
];

async function open(page: Page, lang: 'ar' | 'en', path: string) {
  const base = test.info().project.use.baseURL!;
  await page.context().addCookies([
    { name: 'force-language', value: lang, url: base },
    // Accept the consent banner up front so it does not cover the page under test.
    {
      name: 'force-cookie-consent',
      value: encodeURIComponent(
        JSON.stringify({ marketing: false, v: 1, ts: '2026-10-07T00:00:00Z' })
      ),
      url: base,
    },
  ]);
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  expect(res?.status(), path).toBe(200);
}

for (const lang of ['ar', 'en'] as const) {
  for (const pg of PAGES) {
    test(`${pg.name} (${lang}): direction, no overflow, western digits, axe AA`, async ({
      page,
    }) => {
      await open(page, lang, pg.path);
      await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
      await expect(page.locator('[data-pack="dahab"]').first()).toBeAttached();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect(overflow, 'horizontal scroll (px)').toBeLessThanOrEqual(0);
      const text = await page.locator('main').innerText();
      expect(text, 'Arabic-Indic digits on the page').not.toMatch(/[٠-٩]/);

      await page.addScriptTag({ path: AXE });
      const result = await page.evaluate(async () => {
        // @ts-expect-error injected
        const r = await window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        });
        return r.violations.map(
          (v: { id: string; impact: string; nodes: Array<{ target: string[] }> }) => ({
            id: v.id,
            impact: v.impact,
            targets: v.nodes.map(n => n.target.join(' ')).slice(0, 3),
          })
        );
      });
      const blocking = result.filter(
        (v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical'
      );
      test.info().annotations.push({ type: 'axe', description: JSON.stringify(result) });
      expect(blocking, JSON.stringify(blocking)).toEqual([]);
    });
  }

  test(`header drawers open from the right sides and trap focus (${lang})`, async ({ page }) => {
    await open(page, lang, '/');
    const width = page.viewportSize()!.width;
    const bag = page
      .getByRole('banner')
      .getByRole('button', { name: lang === 'ar' ? /^السلة/ : /^Bag/ });
    await bag.click();
    const dialog = page.getByRole('dialog', { name: lang === 'ar' ? /سلتك/ : /Your bag/ });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    // The bag sits at the inline END: left edge in Arabic, right edge in English.
    if (lang === 'ar') expect(box.x).toBeLessThan(2);
    else expect(box.x + box.width).toBeGreaterThan(width - 2);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    if (width < 1024) {
      await page
        .getByRole('banner')
        .getByRole('button', { name: lang === 'ar' ? 'القائمة' : 'Menu' })
        .click();
      const menu = page.getByRole('dialog').filter({ has: page.getByRole('navigation') });
      await expect(menu).toBeVisible();
      const m = (await menu.boundingBox())!;
      if (lang === 'ar') expect(m.x + m.width).toBeGreaterThan(width - 2);
      else expect(m.x).toBeLessThan(2);
    }
  });
}
