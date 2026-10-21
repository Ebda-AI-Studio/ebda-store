import { describe, it, expect } from 'vitest';
import { moqShortfalls, moqCartMessage } from './b2b-moq';

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
