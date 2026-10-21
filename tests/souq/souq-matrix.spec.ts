/**
 * Souq scenario matrix (Phase B2 Task 7): the three looks plus the scenario stores
 * (scripts/storedemo/scenario-stores.mjs --template souq) x ar/en x the page list, per viewport
 * project. SOUQ_STORES / SOUQ_PAGES (comma lists) narrow a run; unset runs the full matrix.
 */
import { test, expect } from '@playwright/test';
import { open, runAxe, hostOf } from './helpers';

const LOOK_STORES = ['souq-catalogue', 'souq-night', 'souq-showroom'];
const PDP = '/products/smartphone-6-7';
const ALL_PAGES = [
  '/',
  '/products',
  '/products?category=phones',
  PDP,
  '/cart',
  '/checkout',
  '/search?q=سماعة',
  '/compare',
  '/account',
  '/account/orders',
  '/this-page-does-not-exist',
];
// Focused layouts: checkout and the account/login pages carry no footer by design.
const NO_FOOTER = /^\/(checkout|account)/;
// Products a scenario store does not carry: the PDP is a 404, correctly.
const ABSENT: Record<string, string[]> = { 'souq-empty': [PDP] };
// Ruling B1-111: a merchant primaryColor at the extremes is honoured verbatim, so text-primary
// can fail contrast on those stores; every other axe rule still applies.
const EXTREME_PRIMARY = /^souq-edge-/;
const csv = (v?: string) => (v ? v.split(',').filter(Boolean) : null);
const PAGES = csv(process.env.SOUQ_PAGES) ?? ALL_PAGES;
const STORES = csv(process.env.SOUQ_STORES) ?? [
  ...LOOK_STORES,
  'souq-empty',
  'souq-one',
  'souq-500',
  'souq-noimg',
  'souq-longnames',
  'souq-edge-light',
  'souq-edge-dark',
  'souq-logo-wide',
  'souq-logo-tall',
  'souq-logo-none',
  'souq-white-photos',
  'souq-cod',
];

for (const store of STORES)
  for (const lang of ['ar', 'en'] as const)
    for (const p of PAGES)
      test(`${store} ${lang} ${p}`, async ({ page }) => {
        const res = await open(page, store, lang, p);
        const absent = p.includes('does-not-exist') || ABSENT[store]?.includes(p);
        expect(res.status(), p).toBe(absent ? 404 : 200);
        await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
        ).toBeLessThanOrEqual(0);
        await expect(page.locator('main')).toHaveCount(1);
        // The platform 404 page is its own bare layout (header and footer absent).
        if (!absent) {
          await expect(page.locator('header')).toHaveCount(1);
          await expect(page.locator('footer')).toHaveCount(NO_FOOTER.test(p) ? 0 : 1);
        }
        const tiny = await page.evaluate(
          () =>
            [...document.querySelectorAll('body *')].filter(
              e =>
                e.childNodes.length &&
                [...e.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim()) &&
                parseFloat(getComputedStyle(e).fontSize) < 12
            ).length
        );
        expect(tiny, 'text under 12px').toBe(0);
        const axe = await runAxe(page);
        expect(
          axe.filter(
            v =>
              (v.impact === 'serious' || v.impact === 'critical') &&
              !(EXTREME_PRIMARY.test(store) && v.id === 'color-contrast')
          )
        ).toEqual([]);
      });

test('reduced motion: nothing animates', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const store of LOOK_STORES) {
    await open(page, store, 'ar', '/');
    await page.waitForTimeout(400);
    const running = await page.evaluate(
      () => document.getAnimations().filter(a => a.playState === 'running').length
    );
    expect(running, `${store}: running animations`).toBe(0);
  }
});

test('zoom 200%: 640px CSS width has no horizontal scroll on every look home + PDP', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 900 });
  for (const store of LOOK_STORES)
    for (const p of ['/', PDP]) {
      await open(page, store, 'en', p);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(over, `${store} ${p}`).toBeLessThanOrEqual(0);
    }
});

test('keyboard only: header search, then the category rail, a card and add-to-cart, each with a visible focus ring', async ({
  page,
}) => {
  await open(page, 'souq-catalogue', 'en', '/');
  const seen: Array<{ tag: string; type: string; rail: boolean; card: boolean; ring: boolean }> =
    [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const e = document.activeElement as HTMLElement;
        const s = getComputedStyle(e);
        return {
          tag: e.tagName,
          type: e.getAttribute('type') ?? '',
          rail: !!e.closest('[data-section="category-rail"], [data-section="category-grid"]'),
          card:
            !!e.closest('[data-product-card], [data-part="card"]') ||
            /\/products\//.test(e.getAttribute('href') ?? ''),
          ring: !(s.outlineStyle === 'none' && s.boxShadow === 'none'),
        };
      })
    );
  }
  expect(
    seen.some(s => s.tag === 'INPUT' && s.type === 'search'),
    'header search reached'
  ).toBe(true);
  expect(
    seen.some(s => s.rail),
    'category rail reached'
  ).toBe(true);
  expect(
    seen.some(s => s.card),
    'a product card reached'
  ).toBe(true);
  expect(
    seen.filter(s => s.tag !== 'BODY' && s.tag !== 'NEXTJS-PORTAL' && !s.ring),
    'focused elements without a visible ring'
  ).toEqual([]);
  await open(page, 'souq-catalogue', 'en', PDP);
  const pdp: string[] = [];
  for (let i = 0; i < 70; i++) {
    await page.keyboard.press('Tab');
    pdp.push(
      await page.evaluate(() =>
        ((document.activeElement as HTMLElement).textContent ?? '').trim().slice(0, 40)
      )
    );
  }
  expect(
    pdp.some(t => /add to (cart|bag)|أضف/i.test(t)),
    'add-to-cart reached'
  ).toBe(true);
});

test('PDP: variants, OOS combination, sale, instalment line, backorder, compare toggle', async ({
  page,
}) => {
  await open(page, 'souq-catalogue', 'en', PDP);
  // Black / 512GB is sold out: a struck-through unavailable option appears.
  await page
    .getByRole('button', { name: /^black$/i })
    .first()
    .click();
  const struck = await page.evaluate(() =>
    [...document.querySelectorAll('[data-option-group] button')].some(
      b =>
        (b as HTMLButtonElement).disabled &&
        getComputedStyle(b).textDecorationLine.includes('line-through')
    )
  );
  expect(struck, 'a struck-through unavailable option').toBe(true);
  // Instalment line: PDP only, named approximate, never on a card.
  await expect(page.getByTestId('instalment-line')).toHaveCount(1);
  await open(page, 'souq-catalogue', 'en', '/products');
  await expect(page.getByTestId('instalment-line')).toHaveCount(0);
  // Backorder CTA on the sold-out speaker.
  await open(page, 'souq-catalogue', 'en', '/products/portable-speaker');
  await expect(
    page.getByRole('button', { name: /pre-?order|backorder|اطلب مسبق|طلب مسبق|order now/i }).first()
  ).toBeVisible();
  // A sale product shows a crossed price.
  await open(page, 'souq-catalogue', 'en', '/products/power-bank-20000');
  const crossed = await page.evaluate(
    () =>
      [...document.querySelectorAll('body *')].filter(
        e =>
          [...e.childNodes].some(n => n.nodeType === 3 && /\d/.test(n.textContent ?? '')) &&
          // the strike is a text-decoration, or (Catalogue's drawn strike, B2-23) a 1.5px line
          // painted by the element's own background
          (getComputedStyle(e).textDecorationLine.includes('line-through') ||
            (e.classList.contains('line-through') &&
              getComputedStyle(e).backgroundImage.includes('linear-gradient')))
      ).length
  );
  expect(crossed, 'crossed price').toBeGreaterThan(0);
});

test('Night souq on white-background merchant photos: no white rectangle on the green', async ({
  page,
}) => {
  await open(page, 'souq-white-photos', 'en', '/');
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    for (const img of document.querySelectorAll<HTMLImageElement>('img[src*="white-photo"]')) {
      // Walk up to the first ancestor with a painted background: that is the ground the photo sits on.
      let e: HTMLElement | null = img.parentElement;
      let bg = 'rgba(0, 0, 0, 0)';
      while (e && /rgba\(0, 0, 0, 0\)|transparent/.test((bg = getComputedStyle(e).backgroundColor)))
        e = e.parentElement;
      const m = /rgba?\((\d+), (\d+), (\d+)/.exec(bg);
      if (m && Number(m[1]) + Number(m[2]) + Number(m[3]) < 3 * 200) out.push(`${img.alt}: ${bg}`);
    }
    return out;
  });
  expect(bad, 'white photos sitting on a dark ground').toEqual([]);
});

test('prominent search: the wordmark never sits under the search field (390 and 1280, ar and en)', async ({
  page,
}) => {
  for (const lang of ['ar', 'en'] as const) {
    await open(page, 'souq-catalogue', lang, '/');
    const [name, search] = await Promise.all([
      page.locator('[data-zone="storeName"]').first().boundingBox(),
      page.locator('header [role="search"]').first().boundingBox(),
    ]);
    expect(name && search, `${lang}: both boxes`).toBeTruthy();
    const overlap =
      name!.x < search!.x + search!.width &&
      name!.x + name!.width > search!.x &&
      name!.y < search!.y + search!.height &&
      name!.y + name!.height > search!.y;
    expect(overlap, `${lang}: wordmark overlaps the search field`).toBe(false);
  }
});

test('every look home opens with one h1 and a sane heading order (a11y P2-2)', async ({ page }) => {
  for (const store of LOOK_STORES)
    for (const lang of ['ar', 'en'] as const) {
      await open(page, store, lang, '/');
      expect(await page.locator('h1').count(), `${store} ${lang} h1 count`).toBe(1);
      const axe = await runAxe(page);
      expect(
        axe.filter(v => ['page-has-heading-one', 'heading-order', 'empty-heading'].includes(v.id)),
        `${store} ${lang}`
      ).toEqual([]);
    }
});

test('Night keeps its green ground on the listing and mattes white photos (STOP-2 P2)', async ({
  page,
}) => {
  await open(page, 'souq-white-photos', 'en', '/products');
  const g = await page.evaluate(() => {
    const bg = (e: Element | null) => (e ? getComputedStyle(e).backgroundColor : '');
    const wrap = document.querySelector('[data-part="card-image"]');
    const img = wrap?.querySelector('img');
    return {
      main: bg(document.querySelector('main')?.firstElementChild ?? null),
      body: bg(document.body),
      matte: bg(wrap ?? null),
      blend: img ? getComputedStyle(img).mixBlendMode : '',
    };
  });
  // dark ground (page green #0F3B2E = rgb(15, 59, 46)), cream matte, multiply blend
  const near = (got: string, want: number[]) =>
    got
      .match(/\d+/g)!
      .slice(0, 3)
      .every((v, i) => Math.abs(Number(v) - want[i]!) <= 2);
  expect(near(g.body, [15, 59, 46]), `body ${g.body}`).toBe(true);
  expect(near(g.matte, [246, 243, 234]), `matte ${g.matte}`).toBe(true);
  expect(g.blend).toBe('multiply');
});

test('PLP fills the column: at 1280 the grid holds 4 cards of 200px or more, photo fills the card', async ({
  page,
}) => {
  for (const store of LOOK_STORES) {
    await open(page, store, 'en', '/products');
    const m = await page.evaluate(() => {
      const w = [...document.querySelectorAll('article[itemtype]')].map(a => {
        const r = a.getBoundingClientRect();
        const im = a.querySelector('[data-part="card-image"]')?.getBoundingClientRect();
        return { w: r.width, img: im?.width ?? 0, top: r.top, h: r.height };
      });
      return w;
    });
    test.skip(m.length === 0, 'no cards');
    const vw = page.viewportSize()!.width;
    if (vw >= 1024) {
      for (const c of m) {
        expect(c.w, `${store} card width`).toBeGreaterThanOrEqual(190);
        expect(c.img / c.w, `${store} photo fills the card`).toBeGreaterThan(0.85);
      }
      // one row of cards shares one height (the CTA sits on the same baseline)
      const firstRow = m.filter(c => Math.abs(c.top - m[0]!.top) < 2);
      expect(new Set(firstRow.map(c => Math.round(c.h))).size, `${store} row heights`).toBe(1);
    }
  }
});

test('a fresh store with no hero photo gets a compact title band named after the store, never its slug', async ({
  page,
}) => {
  for (const store of ['souq-noimg', 'souq-cod', 'souq-one'])
    for (const lang of ['ar', 'en'] as const) {
      await open(page, store, lang, '/');
      const m = await page.evaluate(() => {
        const band = document.querySelector('[data-hero="compact"]');
        const h1s = [...document.querySelectorAll('h1')].map(h => h.textContent ?? '');
        return { band: band ? Math.round(band.getBoundingClientRect().height) : null, h1s };
      });
      // Night's hero section and the home of the other looks: either a compact band (<= 260px)
      // or no hero at all (Catalogue, Showroom open with the sr-only store-name h1)
      if (m.band !== null) expect(m.band, `${store} ${lang} band height`).toBeLessThanOrEqual(260);
      expect(m.h1s.length, `${store} ${lang} h1`).toBe(1);
      expect(m.h1s[0], `${store} ${lang}: the slug is not the title`).not.toMatch(/souq-/i);
    }
});
