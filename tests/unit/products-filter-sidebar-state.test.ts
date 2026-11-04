import { describe, it, expect } from 'vitest';
import {
  buildSidebarVars,
  countActiveFilters,
} from '../../apps/web/src/app/products/filter-sidebar-state';

describe('buildSidebarVars', () => {
  it('returns undefined when the merchant set no filter colors', () => {
    // Must be undefined, not {} — an empty style object would still be applied
    // and could shadow the store's global tokens.
    expect(buildSidebarVars(undefined, undefined)).toBeUndefined();
    expect(buildSidebarVars('', '')).toBeUndefined();
  });

  it('overrides only the token the merchant actually set', () => {
    expect(buildSidebarVars('10 20 30', undefined)).toEqual({ '--filter-bg': '10 20 30' });
    expect(buildSidebarVars(undefined, '0 0 0')).toEqual({ '--filter-fg': '0 0 0' });
  });

  it('overrides both when both are set', () => {
    expect(buildSidebarVars('10 20 30', '0 0 0')).toEqual({
      '--filter-bg': '10 20 30',
      '--filter-fg': '0 0 0',
    });
  });
});

describe('countActiveFilters', () => {
  it('counts nothing when no filter is applied', () => {
    expect(countActiveFilters('', '', {})).toBe(0);
  });

  it('ignores a whitespace-only search', () => {
    // Otherwise a stray space shows a phantom active filter on the badge.
    expect(countActiveFilters('   ', '', {})).toBe(0);
  });

  it('counts an option NAME once regardless of how many values are selected', () => {
    // Three sizes is still one active filter from the shopper's point of view.
    expect(countActiveFilters('', '', { size: ['s', 'm', 'l'] })).toBe(1);
  });

  it('ignores an option name with no values selected', () => {
    expect(countActiveFilters('', '', { size: [], color: ['red'] })).toBe(1);
  });

  it('sums search and options', () => {
    expect(countActiveFilters('shirt', 'tops', { size: ['m'], color: ['red'] })).toBe(3);
  });

  it('never counts the category the page is about (IA-11)', () => {
    // The shopper reached /products?category=abayas by tapping a category; the
    // h1 already names it, so the badge showing "1" reads as a filter they never set.
    expect(countActiveFilters('', 'abayas', {})).toBe(0);
  });

  it('defaults optionFilters so an omitted argument does not throw', () => {
    expect(countActiveFilters('shirt', '')).toBe(1);
  });
});

describe('filter panel is a quiet surface on every skin (Ruling B1-31)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const root = `${__dirname}/../..`;
  const src = readFileSync(`${root}/apps/web/src/app/products/ProductsFilterSidebar.tsx`, 'utf8');
  const css = readFileSync(`${root}/apps/web/src/styles/globals.css`, 'utf8');
  it('the panel, sheet and trigger paint the page surface + hairline, never a primary slab', () => {
    expect(src).not.toMatch(/bg-\[hsl\(var\(--primary\)\)\]/);
    expect(src).not.toMatch(/--primary-foreground\)/);
    // PREMIUM-20 supersedes B1-43 for the FRAME: the panel is a container, not a control, so a hairline
    // (12% of the panel's own ink) replaces the full --input border (audit 2026-11-03 #9). The
    // controls inside (chips, thumbs, selects) keep their own boundaries.
    expect(src).toMatch(
      /lg:border lg:border-\[hsl\(var\(--filter-fg\)\/0\.12\)\] lg:bg-\[hsl\(var\(--filter-bg\)\)\]/
    );
    expect(src).not.toMatch(/lg:border-input/);
    expect(css).toMatch(
      /\[data-zone='filters'\] \{\s*--filter-bg: var\(--bg-page\);\s*--filter-fg: var\(--foreground\);/
    );
  });
  it('the accent (primary) marks only the active state', () => {
    // One chip skin for facet values and categories (PREMIUM-20): the literal lives once, in CHIP_ON.
    expect(
      src.match(/'filter-active border-primary bg-primary text-primary-foreground font-semibold'/g)
    ).toHaveLength(1);
    expect(src.match(/className=\{chip\(/g)!.length).toBeGreaterThanOrEqual(3);
  });
  it('on a merchant-coloured panel the active chip keeps an ink ring (N3)', () => {
    expect(src).toMatch(/data-filter-custom=\{sidebarVars \? '' : undefined\}/);
    expect(css).toMatch(
      /\[data-zone='filters'\]\[data-filter-custom\] \.filter-active \{\s*box-shadow: inset 0 0 0 2px hsl\(var\(--filter-fg\)\);/
    );
  });
});

describe('filter sidebar heading order (a11y P2-3)', () => {
  it('the Filters title is an h2 so it follows the page h1 without a skip', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../apps/web/src/app/products/ProductsFilterSidebar.tsx', import.meta.url),
      'utf8'
    );
    expect(src).toMatch(/<h2\b[^>]*>\s*\{t\('Filters', 'الفلاتر'\)\}\s*<\/h2>/);
  });
});

describe('mobile filter row shows the item count and a sort (IA-11)', () => {
  it('renders the result count with the counted noun and a sort select beside the trigger', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../apps/web/src/app/products/ProductsFilterSidebar.tsx', import.meta.url),
      'utf8'
    );
    expect(src).toMatch(/data-filter-result-count/);
    expect(src).toMatch(/countText\([^)]*ITEMS/);
    expect(src).toMatch(/id="products-sort-bar"/);
  });
});

describe('price range is one accessible two-thumb slider with 44px thumbs (a11y P2-10, audit #9)', () => {
  it('the sidebar uses PriceRangeSlider, no native range inputs, and each thumb has a 44px hit area', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (f: string) =>
      readFileSync(new URL(`../../apps/web/src/app/products/${f}`, import.meta.url), 'utf8');
    expect(read('ProductsFilterSidebar.tsx')).toContain('<PriceRangeSlider');
    expect(read('ProductsFilterSidebar.tsx')).not.toMatch(/type="range"/);
    // 24px thumb + before:-inset-2.5 (10px each side) = 44px
    expect(read('PriceRangeSlider.tsx')).toContain('h-6 w-6');
    expect(read('PriceRangeSlider.tsx')).toContain('before:-inset-2.5');
  });
});

// a11y re-audit P2-N9 / P2-N10 (rule (d)): at 1280 the Filters toggle measured 222x20, the
// search field 156x20, the grid/list toggles 28x28, the Lookbook sort select 38px; in the 390
// sheet the search field 284x20 inside its pill and the sort select 40px.
describe('filter panel controls are 44px (P2-N9/N10)', () => {
  it('selects, the panel toggle, the search field and the view toggles', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (f: string) =>
      readFileSync(new URL(`../../apps/web/src/${f}`, import.meta.url), 'utf8');
    const side = read('app/products/ProductsFilterSidebar.tsx');
    const selects = [...side.matchAll(/<select[\s\S]*?className="([^"]*)"/g)].map(m => m[1]);
    expect(selects.length).toBeGreaterThanOrEqual(3);
    for (const c of selects) expect(c).toMatch(/\b(min-h-11|h-11)\b/);
    expect(side).toMatch(/className="mb-4 flex min-h-11 w-full items-center justify-between/);
    const css = read('styles/globals.css');
    expect(css).toMatch(/\.search-input \{\s*@apply [^;]*\bmin-h-11\b[^;]*\btext-base\b/);
    const list = read('app/products/ProductsClient.tsx');
    const toggles = [
      ...list.matchAll(/className=\{`rounded-md ([^`]*?) transition-colors \$\{viewMode/g),
    ];
    expect(toggles.length).toBe(2);
    for (const t of toggles) expect(t[1]).toMatch(/\bh-11 w-11\b/);
  });
});
