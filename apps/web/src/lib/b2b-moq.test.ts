import { describe, it, expect } from 'vitest';
import { moqShortfalls, moqCartMessage, pdpMaxQty, cartMaxQty, moqFix } from './b2b-moq';

const line = (o: Record<string, unknown>) => ({
  productId: 'p1',
  name: 'Tea',
  quantity: 2,
  belowMoq: true,
  moqRequired: 6,
  ...o,
});

describe('moqShortfalls', () => {
  it('groups variant lines of one product into one entry with the product total', () => {
    const r = moqShortfalls([line({ quantity: 2 }), line({ quantity: 1 })]);
    expect(r).toEqual([
      { productId: 'p1', name: 'Tea', nameAr: undefined, required: 6, current: 3 },
    ]);
  });
  it('ignores lines that meet MOQ, unavailable lines and lines without a MOQ', () => {
    expect(
      moqShortfalls([
        line({ belowMoq: false }),
        line({ unavailable: true }),
        line({ moqRequired: undefined }),
      ])
    ).toEqual([]);
  });
  it('lists every offending product', () => {
    expect(
      moqShortfalls([line({}), line({ productId: 'p2', name: 'Honey', moqRequired: 12 })]).map(
        s => s.productId
      )
    ).toEqual(['p1', 'p2']);
  });
});

describe('moqCartMessage', () => {
  const s = moqShortfalls([
    line({ nameAr: 'شاي' }),
    line({ productId: 'p2', name: 'Honey', moqRequired: 12, quantity: 4 }),
  ]);
  it('names every product with current/required in English and Arabic, Latin digits', () => {
    const en = moqCartMessage(s, 'en')!;
    const ar = moqCartMessage(s, 'ar')!;
    expect(en).toContain('Tea (2/6)');
    expect(en).toContain('Honey (4/12)');
    expect(ar).toContain('شاي (2/6)');
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toMatch(/[٠-٩]/);
  });
  it('is undefined when nothing is short', () => expect(moqCartMessage([], 'en')).toBeUndefined());
});

describe('quantity caps and the MOQ fix (review M7)', () => {
  it('pdpMaxQty keeps the retail cap but reaches a MOQ or a tier above it, never past the server limit', () => {
    expect(pdpMaxQty(10, null, [])).toBe(10);
    expect(pdpMaxQty(10, 24, [])).toBe(24);
    expect(pdpMaxQty(10, 6, [{ minQty: 50 }, { minQty: 200 }])).toBe(200);
    expect(pdpMaxQty(10, 5000, [])).toBe(1000);
  });
  it('cartMaxQty lifts the cap only for a MOQ line or a line already on a tier / group price', () => {
    expect(cartMaxQty({})).toBe(10);
    expect(cartMaxQty({ priceSource: 'base' })).toBe(10);
    expect(cartMaxQty({ moqRequired: 12 })).toBe(1000);
    expect(cartMaxQty({ priceSource: 'tier' })).toBe(1000);
    expect(cartMaxQty({ priceSource: 'group' })).toBe(1000);
  });
  it('moqFix returns the quantity to set on the first line of the short product', () => {
    expect(
      moqFix({ productId: 'p1', required: 12, current: 5 }, [
        { id: 'l1', productId: 'p1', quantity: 3 },
        { id: 'l2', productId: 'p1', quantity: 2 },
        { id: 'l3', productId: 'p2', quantity: 9 },
      ])
    ).toEqual({ lineId: 'l1', quantity: 10 });
    expect(moqFix({ productId: 'px', required: 2, current: 1 }, [])).toBeNull();
  });
});
