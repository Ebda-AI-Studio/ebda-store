/**
 * Every heading on every marketing page must clear the element after it: Arabic display headings carry
 * dots and tails below the baseline, so a tight line-height or a negative margin on the lede under them makes
 * the two collide (live bug on /features/: the dots of ي in "اللي" sat on the lede's first line).
 * Measured per page and per viewport (390 and 1280): the heading's box must not intersect the next sibling's box.
 */
import { test, expect } from '@playwright/test';

const PAGES = [
  '',
  'features',
  'compare/zid',
  'compare/shopify',
  'compare/wuilt',
  'compare/youcan',
  'compare/easyorders',
  'compare/expandcart',
  'about',
  'credits',
  'support',
  'legal',
  'privacy',
  'terms',
  'merchant-agreement',
  'acceptable-use',
];
const WIDTHS = [390, 1280];

for (const locale of ['ar', 'en'] as const) {
  for (const width of WIDTHS) {
    for (const page of PAGES) {
      const url = `${locale === 'en' ? '/en' : ''}/${page}${page ? '/' : ''}`.replace('//', '/');
      test(`${locale} ${width}px ${url}: no heading overlaps its next sibling`, async ({
        browser,
      }) => {
        const ctx = await browser.newContext({
          viewport: { width, height: 900 },
          reducedMotion: 'reduce',
        });
        const p = await ctx.newPage();
        await p.goto(url, { waitUntil: 'networkidle' });
        const bad = await p.evaluate(() => {
          const out: string[] = [];
          for (const h of document.querySelectorAll('main h1, main h2, main h3')) {
            const next = h.nextElementSibling;
            if (!next) continue;
            const a = h.getBoundingClientRect();
            const b = next.getBoundingClientRect();
            if (!a.height || !b.height) continue; // hidden
            const cs = getComputedStyle(next);
            if (cs.position === 'absolute' || cs.position === 'fixed') continue;
            const xOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const yOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (xOverlap > 0 && yOverlap > 0.5)
              out.push(
                `${h.tagName} "${(h.textContent ?? '').slice(0, 40)}" overlaps ${next.tagName}.${next.className} by ${yOverlap.toFixed(1)}px`
              );
          }
          return out;
        });
        await ctx.close();
        expect(bad).toEqual([]);
      });
    }
  }
}
