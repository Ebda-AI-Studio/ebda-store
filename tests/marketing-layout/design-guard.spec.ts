/**
 * Marketing design-system guard (UI/UX wave 3). Every page in the sitemap (ar + en) at 360 / 390 / 820 / 1280:
 *  1. the header bar fits: every visible control of the top row sits inside the viewport, menu closed; with the Menu
 *     open on a phone the panel and the CTA are inside it too;
 *  2. a CLOSED Menu is display:none (not merely collapsed): its links are not rendered, not tabbable, not targets;
 *  3. tap targets are at least 24px (WCAG 2.5.8) in both directions. Exempt: a link inside a running sentence, a
 *     control that is inert / aria-hidden / tabindex=-1, anything in a scaled phone mock-up, and a native checkbox or
 *     radio whose <label> is the target (the label is measured instead);
 *  4. no visible text is under 12px;
 *  5. anything that reaches past the viewport sits in a proper horizontal scroller (overflow-x auto/scroll AND
 *     scroll-snap) and the page itself never widens.
 * Run: npm run build -w @ebda/marketing && npx playwright test -c playwright.marketing.config.ts design-guard
 */
import { test, expect } from '@playwright/test';

const WIDTHS = [360, 390, 820, 1280];

test.describe.configure({ mode: 'parallel' });

async function sitemapPaths(
  request: import('@playwright/test').APIRequestContext
): Promise<string[]> {
  const xml = await (await request.get('/sitemap.xml')).text();
  const paths = [...xml.matchAll(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/g)].map(m => m[1]);
  expect(paths.length, 'sitemap lists the pages').toBeGreaterThan(40);
  return paths;
}

type Findings = {
  header: string[];
  closedMenu: string[];
  taps: string[];
  tiny: string[];
  unscrollable: string[];
  pageWidth: number;
};

function measure(vw: number): Findings {
  const TAP_MIN = 24; // inlined: this function is serialised into the page
  const TEXT_MIN = 12;
  const f: Findings = {
    header: [],
    closedMenu: [],
    taps: [],
    tiny: [],
    unscrollable: [],
    pageWidth: 0,
  };
  const name = (e: Element) =>
    `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''} "${(
      e.textContent ||
      e.getAttribute('aria-label') ||
      ''
    )
      .trim()
      .slice(0, 24)}"`;
  const shown = (e: Element) =>
    e.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });

  // 1 + 2: the header row, and the closed menu panel
  document.querySelectorAll('.header-row a, .header-row button, .header-row summary').forEach(e => {
    if (!shown(e)) return;
    const r = e.getBoundingClientRect();
    if (r.left < -0.5 || r.right > vw + 0.5) {
      f.header.push(`${name(e)} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
  });
  document.querySelectorAll('details.nav-menu:not([open]) > ul').forEach(ul => {
    if (getComputedStyle(ul).display !== 'none')
      f.closedMenu.push('menu panel is rendered while closed');
  });

  const inertish = (e: Element) =>
    !!e.closest('[aria-hidden="true"], [inert], .look-phone') ||
    e.getAttribute('tabindex') === '-1';
  const inSentence = (e: Element) => {
    if (e.tagName !== 'A' || getComputedStyle(e).display !== 'inline') return false;
    const block = e.closest('p, li, dd, td, figcaption') ?? e.parentElement!;
    let own = (block.textContent || '').length;
    block.querySelectorAll('a, button').forEach(x => (own -= (x.textContent || '').length));
    return own >= 12;
  };

  // 3: tap targets
  document.querySelectorAll('a[href], button, input, select, textarea, summary').forEach(e => {
    if (!shown(e) || (e instanceof HTMLInputElement && e.type === 'hidden')) return;
    if (inertish(e) || inSentence(e)) return;
    let r = e.getBoundingClientRect();
    if (
      e instanceof HTMLInputElement &&
      (e.type === 'checkbox' || e.type === 'radio') &&
      e.labels?.[0]
    ) {
      r = e.labels[0].getBoundingClientRect();
    }
    if (r.width < TAP_MIN - 0.5 || r.height < TAP_MIN - 0.5) {
      f.taps.push(`${name(e)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  });

  // 4: text floor
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const e = n.parentElement;
    if (!e || !(n.textContent || '').trim() || e.closest('script, style, noscript, svg')) continue;
    if (!shown(e)) continue;
    const px = parseFloat(getComputedStyle(e).fontSize);
    if (px < TEXT_MIN - 0.01) f.tiny.push(`${px}px ${name(e)}`);
  }

  // 5: overflow lives in a real scroller
  const scroller = (e: Element) => {
    for (let p = e.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return s;
    }
    return null;
  };
  const checked = new Set<Element>();
  document.querySelectorAll('a[href], button, input, summary, img, figure').forEach(e => {
    if (!shown(e) || inertish(e)) return;
    const r = e.getBoundingClientRect();
    if (r.right <= vw + 0.5 && r.left >= -0.5) return;
    const s = scroller(e);
    if (!s) {
      // e.g. a closed accordion/hidden decorative layer would already be filtered by `shown`
      if (!e.closest('[data-offscreen], .skip'))
        f.unscrollable.push(`${name(e)} ${Math.round(r.left)}..${Math.round(r.right)}`);
    } else {
      let p = e.parentElement!;
      while (
        p &&
        !(/(auto|scroll)/.test(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth)
      )
        p = p.parentElement!;
      if (!checked.has(p)) {
        checked.add(p);
        if (s.scrollSnapType === 'none')
          f.unscrollable.push(`scroller ${name(p)} has no scroll-snap`);
      }
    }
  });
  f.pageWidth = document.documentElement.scrollWidth;
  return f;
}

for (const vw of WIDTHS) {
  test(`marketing design guard @${vw}px: every page, ar + en`, async ({ browser, request }) => {
    test.setTimeout(240_000);
    const paths = await sitemapPaths(request);
    const ctx = await browser.newContext({
      viewport: { width: vw, height: 800 },
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const failures: string[] = [];
    for (const path of paths) {
      await page.goto(path, { waitUntil: 'networkidle' });
      const f = await page.evaluate(measure, vw);
      const add = (kind: string, list: string[]) =>
        list.slice(0, 6).forEach(m => failures.push(`${path} ${kind}: ${m}`));
      add('header-overflow', f.header);
      add('closed-menu', f.closedMenu);
      add('tap<24', f.taps);
      add('text<12', f.tiny);
      add('overflow', f.unscrollable);
      if (f.pageWidth > vw) failures.push(`${path} page is ${f.pageWidth}px wide`);
      if (vw < 800) {
        // the open Menu on a phone: panel and CTA stay inside the viewport
        await page.locator('details.nav-menu > summary').click();
        const box = await page.locator('details.nav-menu > ul').boundingBox();
        if (!box || box.x < -0.5 || box.x + box.width > vw + 0.5)
          failures.push(`${path} open menu panel outside the viewport`);
        const cta = await page.locator('details.nav-menu a.nav-cta').first().boundingBox();
        if (!cta || cta.x < -0.5 || cta.x + cta.width > vw + 0.5)
          failures.push(`${path} menu CTA outside the viewport`);
      }
    }
    await ctx.close();
    expect(failures, failures.join('\n')).toEqual([]);
  });
}
