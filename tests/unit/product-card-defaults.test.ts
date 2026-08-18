import { describe, it, expect } from 'vitest';
import { resolveProductCardDefaults } from '../../apps/web/src/templates/shared/product-card-defaults';

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
