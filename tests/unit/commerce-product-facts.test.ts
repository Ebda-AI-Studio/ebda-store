import { describe, it, expect } from 'vitest';
import { productFactsSchema, factText, cardFacts } from '@ebda/shared';
import { updateProductSchema } from '../../apps/api/src/routes/product.routes';

const f = (o: Partial<any> = {}) => ({
  key: 'Fabric',
  keyAr: 'الخامة',
  value: 'Linen',
  valueAr: 'كتان',
  onCard: false,
  ...o,
});

describe('product facts', () => {
  it('caps at 24 rows and 2 card chips', () => {
    expect(productFactsSchema.safeParse(Array.from({ length: 25 }, () => f())).success).toBe(false);
    expect(
      productFactsSchema.safeParse([f({ onCard: true }), f({ onCard: true }), f({ onCard: true })])
        .success
    ).toBe(false);
    expect(productFactsSchema.safeParse([f({ onCard: true }), f()]).success).toBe(true);
  });
  it('needs a key and value in at least one language', () => {
    expect(productFactsSchema.safeParse([f({ key: '', keyAr: '' })]).success).toBe(false);
    expect(productFactsSchema.safeParse([f({ key: '', value: '' })]).success).toBe(true);
  });
  it('falls back to arabic', () => {
    expect(factText(f({ key: '', value: '' }), 'en')).toEqual({ key: 'الخامة', value: 'كتان' });
    expect(factText(f(), 'ar')).toEqual({ key: 'الخامة', value: 'كتان' });
  });
  it('falls back to english on an english-only fact in arabic', () => {
    expect(factText(f({ keyAr: '', valueAr: '' }), 'ar')).toEqual({
      key: 'Fabric',
      value: 'Linen',
    });
  });
  it('cardFacts returns onCard rows only', () => {
    expect(cardFacts([f(), f({ onCard: true, value: 'Silk' })]).map(x => x.value)).toEqual([
      'Silk',
    ]);
    expect(cardFacts(null)).toEqual([]);
  });
  it('the product update schema accepts facts and rejects 25 rows', () => {
    expect(updateProductSchema.safeParse({ facts: [f()] }).success).toBe(true);
    expect(updateProductSchema.safeParse({ name: 'x' }).success).toBe(true);
    expect(
      updateProductSchema.safeParse({ facts: Array.from({ length: 25 }, () => f()) }).success
    ).toBe(false);
  });
});
