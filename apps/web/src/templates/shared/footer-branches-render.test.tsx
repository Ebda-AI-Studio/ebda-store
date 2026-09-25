/**
 * Renders the real Footer component from all 5 themes and asserts the
 * opt-in "Branches" column's two hardest promises — the ones a unit test of
 * `resolveFooterBranches` alone cannot make:
 *
 *   1. THE ADDITIVE CONTRACT — with `theme.showBranchesInFooter` off (the
 *      default), a footer rendered WITH locations data is byte-identical to
 *      the same footer rendered with `locations` entirely absent. This is
 *      what "no live storefront may change look without opting in" means at
 *      the render layer: pecannbee's 8 locations must not move a single
 *      byte of its footer HTML until it flips the toggle on.
 *
 *   2. With the toggle ON and at least one published location, the column
 *      actually reaches the DOM: name + address (linked to the sanitized
 *      maps URL, `target="_blank" rel="noopener noreferrer"`) + phone as a
 *      `tel:` link — in the right language.
 *
 * String comparisons of server-rendered HTML rather than DOM queries because
 * there is no jsdom / testing-library in this repo (see
 * product-card-badge-render.test.tsx, the established pattern this mirrors).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoreTheme, StoreLocationPublic } from '@force/shared';
import type { FooterProps } from '../types';

// ── Module mocks ────────────────────────────────────────────────────────────
// Every theme's Footer reaches translations/routing through these three
// modules and nothing else (props carry all store data directly).

let currentIsRtl = false;

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    isRtl: currentIsRtl,
    language: currentIsRtl ? 'ar' : 'en',
    t: (en: string, ar?: string) => (currentIsRtl ? (ar ?? en) : en),
  }),
  // Real map values matter here: footerBranchesHeading reads
  // `translations.Branches` for the column heading.
  translations: { Branches: 'فروعنا' } as Record<string, string>,
}));

vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt?: string }) =>
    React.createElement('img', { src, alt }),
}));

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: React.PropsWithChildren<{ href: string; prefetch?: boolean }>) =>
    React.createElement('a', { href, ...rest }, children),
}));

vi.mock('../../lib/api', () => ({
  api: { subscribeNewsletter: vi.fn() },
}));

// Imported AFTER the mocks so every footer picks them up.
const { default: ClassicFooter } = await import('../classic/Footer');
const { default: ModernFooter } = await import('../modern/Footer');
const { default: MinimalFooter } = await import('../minimal/Footer');
const { default: BoldFooter } = await import('../bold/Footer');
const { default: ElegantFooter } = await import('../elegant/Footer');

const FOOTERS = [
  ['classic', ClassicFooter],
  ['modern', ModernFooter],
  ['minimal', MinimalFooter],
  ['bold', BoldFooter],
  ['elegant', ElegantFooter],
] as const;

// ── Fixtures ────────────────────────────────────────────────────────────────

const BRANDING = { name: 'Test Store', nameAr: 'متجر تجريبي' };
const CONTACT = {};
const SOCIALS = {};

const LOCATIONS: StoreLocationPublic[] = [
  {
    id: 'loc-1',
    name: 'Salmiya Branch',
    nameAr: 'فرع السالمية',
    address: 'Block 5, Salem Al Mubarak St, Salmiya',
    addressAr: 'قطعة 5، شارع سالم المبارك، السالمية',
    phone: '+96522223333',
    mapsUrl: 'https://maps.google.com/?q=salmiya-branch',
  },
];

function baseProps(overrides: Partial<FooterProps> = {}): FooterProps {
  return {
    branding: BRANDING,
    contact: CONTACT,
    socials: SOCIALS,
    navigation: [],
    ...overrides,
  };
}

function render(
  Footer: (typeof FOOTERS)[number][1],
  props: Partial<FooterProps>,
  { isRtl = false }: { isRtl?: boolean } = {}
): string {
  currentIsRtl = isRtl;
  return renderToStaticMarkup(React.createElement(Footer as never, baseProps(props) as never));
}

const OFF_THEME = {} as StoreTheme;
const ON_THEME = { showBranchesInFooter: true } as StoreTheme;

// ── 1. The additive contract — toggle OFF is byte-identical ───────────────

describe('footer Branches column — toggle off renders byte-identically to today', () => {
  it.each(FOOTERS)('%s: locations present but toggle OFF → no Branches markup', (_name, Footer) => {
    const withLocations = render(Footer, { theme: OFF_THEME, locations: LOCATIONS });
    const withoutLocations = render(Footer, { theme: OFF_THEME, locations: undefined });
    expect(withLocations).toBe(withoutLocations);
    expect(withLocations).not.toContain('Salmiya Branch');
    expect(withLocations).not.toContain('فرع السالمية');
  });

  it.each(FOOTERS)('%s: toggle ON but zero locations → no Branches markup', (_name, Footer) => {
    const html = render(Footer, { theme: ON_THEME, locations: [] });
    const withoutFlag = render(Footer, { theme: OFF_THEME, locations: [] });
    expect(html).toBe(withoutFlag);
  });

  it.each(FOOTERS)(
    '%s: theme entirely undefined + locations present → no Branches markup',
    (_name, Footer) => {
      const html = render(Footer, { theme: undefined, locations: LOCATIONS });
      expect(html).not.toContain('Salmiya Branch');
    }
  );
});

// ── 2. The additive contract — toggle ON only ADDS the column ──────────────

describe('footer Branches column — toggle on renders the branch data', () => {
  it.each(FOOTERS)(
    '%s: renders name, address (maps link) and phone (tel: link)',
    (_name, Footer) => {
      const html = render(Footer, { theme: ON_THEME, locations: LOCATIONS });
      expect(html).toContain('Salmiya Branch');
      expect(html).toContain('Block 5, Salem Al Mubarak St, Salmiya');
      expect(html).toContain('href="https://maps.google.com/?q=salmiya-branch"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('href="tel:+96522223333"');
    }
  );

  it.each(FOOTERS)(
    '%s: renders the Arabic name/address on the Arabic storefront',
    (_name, Footer) => {
      const html = render(Footer, { theme: ON_THEME, locations: LOCATIONS }, { isRtl: true });
      expect(html).toContain('فرع السالمية');
      expect(html).toContain('قطعة 5، شارع سالم المبارك، السالمية');
      expect(html).not.toContain('Salmiya Branch');
      // The column heading — "Branches"/"فروعنا".
      expect(html).toContain('فروعنا');
    }
  );

  it.each(FOOTERS)(
    '%s: an unsafe mapsUrl renders plain text, not a dangerous href',
    (_name, Footer) => {
      const html = render(Footer, {
        theme: ON_THEME,
        locations: [{ ...LOCATIONS[0], mapsUrl: 'javascript:alert(1)' }],
      });
      expect(html).not.toContain('javascript:alert');
      expect(html).toContain('Block 5, Salem Al Mubarak St, Salmiya');
    }
  );

  it.each(FOOTERS)('%s: a location with no phone renders no tel: link', (_name, Footer) => {
    const html = render(Footer, {
      theme: ON_THEME,
      locations: [{ ...LOCATIONS[0], phone: null }],
    });
    expect(html).not.toContain('tel:');
  });
});
