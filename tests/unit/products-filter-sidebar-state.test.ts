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

  it('sums search, category and options', () => {
    expect(countActiveFilters('shirt', 'tops', { size: ['m'], color: ['red'] })).toBe(4);
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
    expect(src).toMatch(/lg:border lg:border-border lg:bg-\[hsl\(var\(--filter-bg\)\)\]/);
    expect(css).toMatch(
      /\[data-zone='filters'\] \{\s*--filter-bg: var\(--bg-page\);\s*--filter-fg: var\(--foreground\);/
    );
  });
  it('the accent (primary) marks only the active state', () => {
    expect(
      src.match(/'filter-active bg-primary text-primary-foreground font-semibold'/g)
    ).toHaveLength(3);
  });
  it('on a merchant-coloured panel the active chip keeps an ink ring (N3)', () => {
    expect(src).toMatch(/data-filter-custom=\{sidebarVars \? '' : undefined\}/);
    expect(css).toMatch(
      /\[data-zone='filters'\]\[data-filter-custom\] \.filter-active \{\s*box-shadow: inset 0 0 0 2px hsl\(var\(--filter-fg\)\);/
    );
  });
});
