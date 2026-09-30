import { describe, it, expect } from 'vitest';
import {
  resolveProductCardDefaults,
  resolveProductCardCtaOosDefaults,
  renamedCardDefaultsKey,
} from '../../apps/web/src/templates/shared/product-card-defaults';

describe('resolveProductCardDefaults', () => {
  it('returns all-undefined and viewOnly=false when the merchant configured nothing', () => {
    // Every template renders with no layout at all (new store, preview), so this
    // must not throw and must not invent defaults.
    const r = resolveProductCardDefaults(undefined);
    expect(r.ctaShape).toBeUndefined();
    expect(r.oosLabelPlacement).toBeUndefined();
    expect(r.nameCase).toBeUndefined();
    expect(r.viewOnly).toBe(false);
  });

  it('handles a layout with no productCardDefaults', () => {
    expect(resolveProductCardDefaults({} as never).viewOnly).toBe(false);
  });

  it('passes merchant settings through unchanged', () => {
    const r = resolveProductCardDefaults({
      productCardDefaults: {
        ctaShape: 'pill',
        ctaSize: 'lg',
        ctaColor: '#fff',
        ctaTextColor: '#000',
        ctaLabelTextEn: 'Buy',
        ctaLabelTextAr: 'اشتر',
        oosDimColor: '#ccc',
        oosLabel: true,
        oosLabelTextEn: 'Sold out',
        oosLabelTextAr: 'نفد',
        oosLabelShape: 'square',
        oosLabelPlacement: 'top-end',
        oosLabelColor: '#111',
        oosLabelTextColor: '#eee',
        productNameCase: 'upper',
      },
    } as never);
    expect(r.ctaShape).toBe('pill');
    expect(r.ctaSize).toBe('lg');
    expect(r.oosLabelPlacement).toBe('top-end');
    expect(r.oosLabel).toBe(true);
    expect(r.nameCase).toBe('upper');
  });

  it('maps productNameCase onto nameCase', () => {
    // The six copies read `defaults?.productNameCase` into a local called
    // `nameCase`; the rename is part of the contract, not incidental.
    const r = resolveProductCardDefaults({
      productCardDefaults: { productNameCase: 'lower' },
    } as never);
    expect(r.nameCase).toBe('lower');
  });

  it('derives viewOnly only from ctaMode === "viewOnly"', () => {
    expect(
      resolveProductCardDefaults({ productCardDefaults: { ctaMode: 'viewOnly' } } as never).viewOnly
    ).toBe(true);
    expect(
      resolveProductCardDefaults({ productCardDefaults: { ctaMode: 'addToCart' } } as never)
        .viewOnly
    ).toBe(false);
    expect(resolveProductCardDefaults({ productCardDefaults: {} } as never).viewOnly).toBe(false);
  });
});

// Issue #2093 — the wrapper every render path calls must forward EVERY base
// field (renamed), so a new merchant setting cannot silently stop at it.
describe('resolveProductCardCtaOosDefaults', () => {
  const layout = {
    productCardDefaults: {
      ctaShape: 'pill',
      ctaSize: 'lg',
      ctaColor: '#111',
      ctaTextColor: '#222',
      ctaLabelTextEn: 'Buy',
      ctaLabelTextAr: 'اشتر',
      oosDimColor: '#333',
      oosLabel: 'soldOut',
      oosLabelTextEn: 'Gone',
      oosLabelTextAr: 'نفد',
      oosLabelShape: 'square',
      oosLabelPlacement: 'top-end',
      oosLabelColor: '#444',
      oosLabelTextColor: '#555',
      productNameCase: 'upper',
      ctaMode: 'viewOnly',
    },
  } as never;

  it('forwards every base field under its renamed key, and nothing else', () => {
    const base = resolveProductCardDefaults(layout) as unknown as Record<string, unknown>;
    const wrapped = resolveProductCardCtaOosDefaults(layout) as unknown as Record<string, unknown>;
    expect(Object.keys(wrapped).sort()).toEqual(
      Object.keys(base).map(renamedCardDefaultsKey).sort()
    );
    for (const [k, v] of Object.entries(base)) expect(wrapped[renamedCardDefaultsKey(k)]).toBe(v);
  });

  it('keeps nameCase/viewOnly unprefixed and prefixes the rest', () => {
    const w = resolveProductCardCtaOosDefaults(layout);
    expect(w.nameCase).toBe('upper');
    expect(w.viewOnly).toBe(true);
    expect(w.resolvedCtaShape).toBe('pill');
    expect(w.resolvedOosLabelPlacement).toBe('top-end');
  });
});
