/**
 * Sticky chrome + anchors (marketing). The header is pinned (studio bar, plus the product bar on a product page);
 * its combined height is `--sticky-h` and every `[id]` has `scroll-margin-top: var(--sticky-h)`.
 * Contract asserted here, at 390 and 1440 wide, in ar (default) and en:
 *   1. every #hash link (header, product bar, in-page) lands with the section's top EXACTLY at the bottom of the
 *      sticky chrome (within 2px), both as a deep link on load and as a click from the top of the page;
 *   2. `--sticky-h` equals the header's real rendered height (the CSS fallback and the measured value agree);
 *   3. nothing that pins (the home story) starts under the sticky chrome.
 * Needs a static build: npm run build -w @ebda/marketing && npx playwright test -c playwright.marketing.config.ts sticky-anchors
 */
import { test, expect, type Page } from '@playwright/test';

const PAGES = [
  '/store/',
  '/en/store/',
  '/whatsapp/',
  '/en/whatsapp/',
  '/',
  '/en/',
  '/about/',
  '/en/features/',
];
const WIDTHS = [390, 1440];
const TOL = 2;

/** Wait until the scroll position has been stable for several frames (smooth scroll, late layout). */
async function settle(page: Page) {
  // timer based on purpose: requestAnimationFrame is throttled in a background tab, which hangs parallel workers
  let last = -1;
  let same = 0;
  for (let i = 0; i < 60 && same < 5; i++) {
    const y = await page.evaluate(() => window.scrollY);
    same = y === last ? same + 1 : 0;
    last = y;
    await page.waitForTimeout(40);
  }
}

async function stickyBottom(page: Page) {
  return page.evaluate(
    () => document.querySelector('.site-header')!.getBoundingClientRect().bottom
  );
}

async function expectLanded(page: Page, id: string, label: string) {
  await settle(page);
  // poll: lazy media and hydration can still move things for a moment on a loaded CI box; the contract is the settled position
  await expect
    .poll(
      async () => {
        const m = await page.evaluate(id => {
          const el = document.getElementById(id);
          if (!el) return null;
          const hb = document.querySelector('.site-header')!.getBoundingClientRect().bottom;
          const max = document.documentElement.scrollHeight - window.innerHeight;
          return {
            top: el.getBoundingClientRect().top,
            hb,
            atEnd: window.scrollY >= max - 1,
            smt: getComputedStyle(el).scrollMarginTop,
            v: document.documentElement.style.getPropertyValue('--sticky-h'),
            sy: window.scrollY,
            H: document.documentElement.scrollHeight,
          };
        }, id);
        if (!m) return Infinity;
        // a last section shorter than the viewport cannot scroll further: it then sits at or below the bar, never under it
        if (m.atEnd && m.top > m.hb) return 0;
        return Math.abs(m.top - m.hb);
      },
      { message: `${label}: #${id} top within ${TOL}px of the sticky bottom`, timeout: 6000 }
    )
    .toBeLessThanOrEqual(TOL);
}

/** Same-document hash targets reachable from a page: header + product bar + in-page links (SVG <use> refs excluded). */
async function hashLinks(page: Page, path: string) {
  return page.evaluate(path => {
    const out = new Map<string, string>();
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="#"]')) {
      if (a.closest('svg')) continue;
      const u = new URL(a.href);
      if (u.origin !== location.origin || !u.hash || u.hash === '#') continue;
      const samePage = u.pathname.replace(/\/?$/, '/') === path.replace(/\/?$/, '/');
      if (!samePage) continue;
      out.set(u.hash.slice(1), a.getAttribute('href')!);
    }
    return [...out.entries()];
  }, path);
}

for (const w of WIDTHS) {
  test.describe(`${w}px`, () => {
    test.use({ viewport: { width: w, height: w < 700 ? 844 : 900 } });

    for (const path of PAGES) {
      test(`${path}: --sticky-h is the real header height, hash links land under it`, async ({
        page,
      }) => {
        await page.goto(path, { waitUntil: 'load' });
        await page.waitForFunction(
          () => !!document.documentElement.style.getPropertyValue('--sticky-h')
        );
        const { css, real } = await page.evaluate(() => ({
          css: parseFloat(document.documentElement.style.getPropertyValue('--sticky-h')),
          real: document.querySelector('.site-header')!.getBoundingClientRect().height,
        }));
        expect(Math.abs(css - real)).toBeLessThanOrEqual(1);

        const links = await hashLinks(page, path);
        for (const [id, href] of links) {
          // deep link on load
          await page.goto(path.replace(/\/$/, '/') + '#' + id, { waitUntil: 'load' });
          await page.waitForFunction(
            () => !!document.documentElement.style.getPropertyValue('--sticky-h')
          );
          await expectLanded(page, id, `${path} deep link (${href}) @${w}`);
          // click from the top of the page
          await page.goto(path, { waitUntil: 'load' });
          await page.waitForFunction(
            () => !!document.documentElement.style.getPropertyValue('--sticky-h')
          );
          const link = page.locator(`a[href="${href}"]:visible`).first();
          if (await link.count()) {
            // let hydration, fonts and lazy media settle first: the click is a user on a loaded page
            await page.waitForLoadState('networkidle').catch(() => {});
            await page.waitForTimeout(500);
            await link.scrollIntoViewIfNeeded();
            await link.evaluate(el => (el as HTMLElement).click()); // a cookie banner may cover it; the browser's own anchor handling still runs
            await expectLanded(page, id, `${path} click (${href}) @${w}`);
          }
        }
      });
    }

    test.describe('pinned story (motion on)', () => {
      test.use({ contextOptions: { reducedMotion: 'no-preference' } });
      test('product pages: no element starts under the sticky chrome while scrolling the pinned story', async ({
        page,
      }) => {
        for (const path of ['/store/', '/en/store/']) {
          await page.goto(path, { waitUntil: 'load' });
          await page.waitForFunction(
            () => !!document.documentElement.style.getPropertyValue('--sticky-h')
          );
          const hb = await stickyBottom(page);
          const total = await page.evaluate(() => document.documentElement.scrollHeight);
          for (let y = 0; y < total; y += 300) {
            await page.evaluate(y => window.scrollTo(0, y), y);
            const under = await page.evaluate(hb => {
              const bad: string[] = [];
              for (const el of document.querySelectorAll<HTMLElement>(
                '.story-sticky, .legal-toc'
              )) {
                const r = el.getBoundingClientRect();
                const pinned = getComputedStyle(el).position === 'sticky';
                // while it is still pinned (its parent runs on below it) its top must clear the sticky chrome; once the
                // parent ends it scrolls away with it, which is correct
                const parentBottom = el.parentElement!.getBoundingClientRect().bottom;
                if (pinned && r.top < hb - 1 && r.bottom > hb && parentBottom > r.bottom + 1)
                  bad.push(`${el.className} top=${r.top}`);
              }
              return bad;
            }, hb);
            expect(under, `${path} scrollY=${y}`).toEqual([]);
          }
        }
      });
    });
  });
}
