// The Menu's actions (Ruling NAV-MENU-ACTIONS-1), the service-page CTA (Ruling NAV-CTA-2) and the bar's ladder (Ruling
// NAV-BAR-FIT-1): the CTA and WhatsApp are ONE block, the last item of the Menu; a service page asks for the
// conversation with a short label, every other page keeps NAV-CTA-1; the CSS that decides which items sit in the bar
// at each width is still there.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/font/google', () => {
  const font = () => ({ className: '', variable: '', style: {} });
  return { Geist: font, Geist_Mono: font, IBM_Plex_Sans_Arabic: font };
});

import type { PageSlug } from '../../apps/marketing/src/lib/site';
import { SERVICES_PAGE } from '../../apps/marketing/src/lib/services-page';

const LOCALES = ['ar', 'en'] as const;
type L = (typeof LOCALES)[number];
const CHOOSE = { ar: 'اختار منتجك', en: 'Choose a product' } as const;
// Literals on purpose: reading the expected label from SERVICES_PAGE would pass with the long sentence pasted back in.
const TALK = { ar: 'كلّمنا', en: 'Talk to us' } as const;
const HERO = { ar: 'احكيلنا عن شغلك', en: 'Tell us about your work' } as const;
const pre = (l: L) => (l === 'ar' ? '' : '/en');
// Outside a build next/link has no `trailingSlash` setting and drops the slash before `#` or `?`; the built site keeps
// it (checked in a browser). The comparison ignores that one slash, nothing else.
const bare = (href: string) => href.replace(/\/(?=[?#])/, '');

afterEach(() => vi.unstubAllEnvs());

async function render(l: L, page: PageSlug, lines: boolean) {
  if (lines) vi.stubEnv('EBDA_SERVICE_LINES', 'on');
  vi.resetModules();
  const { Header } = await import('../../apps/marketing/src/components/Header');
  return renderToStaticMarkup(<Header locale={l} page={page} />);
}

/** The Menu panel: the direct children of `details.nav-menu > ul`, as the HTML of each top-level `li`. */
function menuItems(html: string): string[] {
  // the Menu holds no nested <details>, so its first `</ul></details>` is its own end
  const menu = /<details class="nav-menu">.*?<\/summary><ul>(.*?)<\/ul><\/details>/s.exec(html);
  expect(menu, 'the Menu panel').not.toBeNull();
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (const m of menu![1].matchAll(/<(\/?)li\b[^>]*>/g)) {
    if (!m[1]) {
      if (depth === 0) start = m.index;
      depth++;
    } else if (--depth === 0) items.push(menu![1].slice(start, m.index + m[0].length));
  }
  return items;
}
const link = (html: string, cls: string) =>
  new RegExp(
    `<a\\b(?=[^>]*class="[^"]*\\b${cls}\\b[^"]*")[^>]*href="([^"]*)"[^>]*>(.*?)</a>`,
    's'
  ).exec(html) ??
  new RegExp(
    `<a\\b[^>]*href="([^"]*)"(?=[^>]*class="[^"]*\\b${cls}\\b[^"]*")[^>]*>(.*?)</a>`,
    's'
  ).exec(html);

describe('header: the Menu ends with one actions block', () => {
  for (const l of LOCALES) {
    for (const lines of [false, true]) {
      for (const page of ['', 'store', 'contact'] as PageSlug[]) {
        it(`${l} /${page} (lines ${lines ? 'on' : 'off'}): language, then CTA + WhatsApp as the last item`, async () => {
          const items = menuItems(await render(l, page, lines));
          const last = items.at(-1)!;
          expect(last).toMatch(/^<li class="menu-actions">/);
          expect(items.at(-2)).toMatch(/^<li class="menu-lang">/);
          // one CTA and one WhatsApp link, in that order, and nowhere else in the Menu
          expect(last.match(/<a\b/g)).toHaveLength(2);
          expect(last.indexOf('nav-cta')).toBeLessThan(last.indexOf('data-whatsapp'));
          expect(last).toMatch(/class="nav-cta menu-start"/);
          const rest = items.slice(0, -1).join('');
          expect(rest).not.toMatch(/nav-cta|data-whatsapp|menu-start/);
          expect(items.join('')).not.toMatch(/menu-wa\b/);
        });
      }
    }
  }
});

describe('header: the CTA (NAV-CTA-1, NAV-CTA-2)', () => {
  for (const l of LOCALES) {
    it(`${l}: a service page asks for the conversation, in the Menu and in the bar`, async () => {
      for (const [page, href] of [
        ['services', `${pre(l)}/contact/#form`],
        ['services/marketing', `${pre(l)}/contact/?topic=marketing#form`],
        ['services/design', `${pre(l)}/contact/?topic=design#form`],
        ['services/events', `${pre(l)}/contact/?topic=events#form`],
      ] as [PageSlug, string][]) {
        const html = await render(l, page, true);
        for (const cls of ['menu-start', 'header-start']) {
          const a = link(html, cls);
          expect(a, `${page} ${cls}`).not.toBeNull();
          expect(bare(a![1]), `${page} ${cls}`).toBe(bare(href));
          expect(a![2], `${page} ${cls}`).toBe(TALK[l]);
        }
        expect(html).not.toContain(CHOOSE[l]);
        // the hero's full sentence stays on the page: in the bar it pushed the header past the screen edge
        expect(html).not.toContain(HERO[l]);
      }
    });
    it(`${l}: the header's label is the short one, the hero keeps the sentence`, () => {
      expect(SERVICES_PAGE[l].headerCta).toBe(TALK[l]);
      expect(SERVICES_PAGE[l].contactCta).toBe(HERO[l]);
      expect(SERVICES_PAGE[l].headerCta.length).toBeLessThan(
        SERVICES_PAGE[l].contactCta.length / 1.5
      );
    });
    it(`${l}: every other studio page keeps "choose a product", lines on or off`, async () => {
      for (const lines of [false, true]) {
        for (const page of ['', 'about', 'contact'] as PageSlug[]) {
          const html = await render(l, page, lines);
          for (const cls of ['menu-start', 'header-start']) {
            const a = link(html, cls);
            expect(a, `${page} ${cls}`).not.toBeNull();
            expect(a![1], `${page} ${cls}`).toMatch(/#products$/);
            expect(a![2], `${page} ${cls}`).toBe(CHOOSE[l]);
          }
          // the short CTA as its own label (the WhatsApp button's «كلّمنا على واتساب» aria is not that CTA)
          expect(html).not.toContain(`>${TALK[l]}<`);
        }
      }
    });
    it(`${l}: a product page keeps its own CTA in the Menu and has no studio button in the bar`, async () => {
      for (const page of ['store', 'whatsapp'] as PageSlug[]) {
        const html = await render(l, page, true);
        expect(link(html, 'header-start')).toBeNull();
        const menu = link(html, 'menu-start');
        const bar = link(html, 'product-cta');
        expect(menu, page).not.toBeNull();
        expect(bar, page).not.toBeNull();
        expect(menu![1]).toBe(bar![1]);
        expect(menu![2]).toBe(bar![2]);
        expect(menu![2]).not.toBe(CHOOSE[l]);
      }
    });
  }
});

// The ladder itself is CSS and is proven in a browser (the sweep in Ruling NAV-BAR-FIT-1). This only keeps its rules
// from being deleted or loosened by an unrelated edit: each one was a measured overflow.
describe('header: the bar ladder is still in chrome.css (NAV-BAR-FIT-1)', () => {
  const css = readFileSync(
    resolve(__dirname, '../../apps/marketing/src/app/chrome.css'),
    'utf8'
  ).replace(/\s+/g, ' ');
  const block = (query: string) => {
    const at = css.indexOf(`@media ${query} {`);
    expect(at, query).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
    }
    throw new Error(`unclosed ${query}`);
  };
  it('under 800px the CTA leaves the bar and shows in the Menu', () => {
    const b = block('(max-width: 799px)');
    expect(b).toMatch(/\.header-actions \.header-start \{ display: none; \}/);
    expect(b).toMatch(/\.nav-menu \.menu-start \{ display: flex; \}/);
  });
  it('from 521 to 679px language and Log in leave the bar and show in the Menu, 44px tall', () => {
    const b = block('(min-width: 521px) and (max-width: 679px)');
    expect(b).toMatch(
      /\.header-actions \.lang-toggle, \.link-login, \.login-menu \{ display: none; \}/
    );
    expect(b).toMatch(/\.nav-menu \.menu-login, \.nav-menu \.menu-lang \{ display: list-item; \}/);
    expect(b).toMatch(/\.nav-menu \.menu-lang a \{[^}]*min-height: 44px;/);
  });
  it('from 1480px the English links keep the 1200px spacing', () => {
    expect(block('(min-width: 1480px)')).toMatch(
      /html\[lang='en'\] \.nav-links \{ gap: 18px; padding-inline-start: 8px; \}/
    );
  });
  it('the pinned pair sits on the panel edge and a focused link scrolls clear of it', () => {
    expect(css).toMatch(/\.nav-menu li\.menu-actions \{ position: sticky; bottom: -8px;/);
    expect(css).toMatch(/\.nav-menu > ul \{ scroll-padding-block-end: 124px;/);
  });
});
