/**
 * The home-page phones are snapshots of the real demo storefronts (MKT-PHONES-1); the in-phone engine must still
 * drive them. Per template and look: filter by a category, open a product, add it to the cart, open the cart.
 */
import { test, expect } from '@playwright/test';

const TEMPLATES = ['qamar', 'souq', 'jasmine', 'lamma', 'dahab'] as const;

for (const tpl of TEMPLATES) {
  test(`${tpl}: cards, filter, product page, cart work in all three phones`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto('/', { waitUntil: 'load' });
    await page.evaluate(() => document.querySelector('.looks-wrap')?.scrollIntoView());
    if (tpl !== 'qamar') await page.click(`#looks-tab-${tpl}`);
    await page.waitForSelector('.look-screen .scr [data-p-id]', { state: 'attached' });
    for (let i = 0; i < 3; i++) {
      const r = await page.evaluate(async i => {
        const scr = document.querySelectorAll('.look-screen .scr')[i] as HTMLElement;
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        const cat = scr.querySelector<HTMLElement>('[data-cat]');
        let filtered = -1;
        if (cat) {
          cat.click();
          await sleep(250);
          filtered = scr.querySelectorAll('[data-p-id].ps-off, [data-grid] > .ps-empty').length;
          cat.click();
          await sleep(150);
        }
        scr.querySelector<HTMLElement>('.ph[role=button]')?.click();
        await sleep(450);
        const add = scr.querySelector<HTMLElement>('.ps-view [data-ps-act="add"]');
        add?.click();
        await sleep(300);
        scr.querySelector<HTMLElement>('[data-ps-act="back"]')?.click();
        await sleep(350);
        scr.querySelector<HTMLElement>('[data-open-cart]')?.click();
        await sleep(450);
        return {
          cards: scr.querySelectorAll('[data-p-id]').length,
          hadPdp: !!add,
          lines: scr.querySelectorAll('.ps-view [data-key]').length,
          filtered,
        };
      }, i);
      expect(r.cards, `${tpl} look ${i}`).toBeGreaterThan(0);
      expect(r.hadPdp, `${tpl} look ${i}: product page opens`).toBe(true);
      expect(r.lines, `${tpl} look ${i}: the cart holds the product`).toBeGreaterThan(0);
      if (r.filtered >= 0)
        expect(r.filtered, `${tpl} look ${i}: filter changes the grid`).toBeGreaterThan(0);
      await page.reload({ waitUntil: 'load' });
      await page.evaluate(() => document.querySelector('.looks-wrap')?.scrollIntoView());
      if (tpl !== 'qamar') await page.click(`#looks-tab-${tpl}`);
      await page.waitForSelector('.look-screen .scr [data-p-id]', { state: 'attached' });
    }
  });
}
