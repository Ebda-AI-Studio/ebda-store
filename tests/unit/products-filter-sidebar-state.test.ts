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
    expect(buildSidebarVars('10 20 30', undefined)).toEqual({ '--primary': '10 20 30' });
    expect(buildSidebarVars(undefined, '0 0 0')).toEqual({ '--primary-foreground': '0 0 0' });
  });

  it('overrides both when both are set', () => {
    expect(buildSidebarVars('10 20 30', '0 0 0')).toEqual({
      '--primary': '10 20 30',
      '--primary-foreground': '0 0 0',
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
