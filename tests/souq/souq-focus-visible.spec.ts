/**
 * WCAG 2.4.11 Focus Not Obscured (Phase B2 STOP-2 a11y audit P1-1). The storefront header is sticky
 * on every template and hides itself on scroll-down on some: a keyboard user walking BACKWARDS
 * (Shift+Tab) used to land on elements parked under the opaque header, and could focus the header's
 * own controls while it was translated out of view. Platform-wide fix; the test drives the real
 * keyboard on the Souq stores (two different header heights: Catalogue's two-row prominent search,
 * Night's one row).
 */
import { test, expect } from '@playwright/test';
import { open } from './helpers';

for (const store of ['souq-catalogue', 'souq-night'])
  for (const lang of ['ar', 'en'] as const)
    test(`${store} ${lang}: walking backwards never parks focus under the sticky header`, async ({
      page,
    }) => {
      await open(page, store, lang, '/');
      // Forward to the end of the page (the footer), then back up.
      for (let i = 0; i < 70; i++) await page.keyboard.press('Tab');
      const bad: string[] = [];
      for (let i = 0; i < 70; i++) {
        await page.keyboard.press('Shift+Tab');
        await page.waitForTimeout(450);
        const m = await page.evaluate(() => {
          const e = document.activeElement as HTMLElement | null;
          const h = document.querySelector('header');
          if (!e || e === document.body || !h) return null;
          const r = e.getBoundingClientRect();
          const hr = h.getBoundingClientRect();
          const inHeader = h.contains(e);
          // The skip link is fixed ABOVE the header on focus (z-index), so it is never obscured.
          const overlay =
            getComputedStyle(e).position === 'fixed' ||
            /skip to main|تخط/i.test(e.textContent ?? '');
          return {
            label: (e.getAttribute('aria-label') ?? e.textContent ?? e.tagName).trim().slice(0, 30),
            top: r.top,
            bottom: r.bottom,
            headerBottom: hr.bottom,
            inHeader,
            overlay,
            // the sticky header is only an obstacle while it is on screen
            headerShown: hr.bottom > 1,
          };
        });
        if (!m) continue;
        if (m.inHeader && !m.headerShown) bad.push(`in hidden header: ${m.label}`);
        if (
          !m.overlay &&
          !m.inHeader &&
          m.headerShown &&
          m.top < m.headerBottom - 1 &&
          m.bottom > 0
        )
          bad.push(
            `under header: ${m.label} top=${Math.round(m.top)} header=${Math.round(m.headerBottom)}`
          );
      }
      expect(bad, 'focused elements hidden by the sticky header').toEqual([]);
    });
