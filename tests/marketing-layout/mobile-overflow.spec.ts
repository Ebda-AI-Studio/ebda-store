/**
 * Audit M-039 / UI-1: no marketing page is wider than a 360px phone, in Arabic (the primary audience, mid-range
 * Android) or English. The Arabic site was 379-381px wide, so the header CTA and the hero were clipped and the page
 * opened scrolled. Checked per page with the header menu closed AND open (the open panel must stay inside the
 * viewport too).
 */
import { test, expect } from '@playwright/test';

const PAGES = [
  '',
  'features',
  'whatsapp',
  'compare/zid',
  'store',
  'services',
  'about',
  'contact',
  'credits',
  'support',
  'legal',
  'privacy',
  'terms',
  'refund',
];

for (const locale of ['ar', 'en'] as const) {
  for (const page of PAGES) {
    const url = `${locale === 'en' ? '/en' : ''}/${page}${page ? '/' : ''}`.replace('//', '/');
    test(`${locale} 360px ${url}: not wider than the viewport`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width: 360, height: 740 },
        reducedMotion: 'reduce',
      });
      const p = await ctx.newPage();
      await p.goto(url, { waitUntil: 'networkidle' });
      const width = () => p.evaluate(() => document.documentElement.scrollWidth);
      expect(await width(), 'menu closed').toBeLessThanOrEqual(360);
      await p.locator('details.nav-menu > summary').click();
      expect(await width(), 'menu open').toBeLessThanOrEqual(360);
      const panel = await p.locator('details.nav-menu > ul').boundingBox();
      expect(panel!.x).toBeGreaterThanOrEqual(0);
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(360);
      await ctx.close();
    });
  }
}
