import { describe, expect, it } from 'vitest';
import { ledgerCostsStatus, stockValueState } from '../money-truth';

describe('ledgerCostsStatus', () => {
  it('trusts the API status when present', () => {
    expect(ledgerCostsStatus({ revenue: 100, cogs: 0, costsStatus: 'known' })).toBe('known');
    expect(ledgerCostsStatus({ revenue: 100, cogs: 5, costsStatus: 'partial' })).toBe('partial');
    expect(ledgerCostsStatus({ revenue: 100, cogs: 5, costsStatus: 'unknown' })).toBe('unknown');
  });
  it('falls back to revenue>0 && cogs==0 for an older API', () => {
    expect(ledgerCostsStatus({ revenue: 100, cogs: 0 })).toBe('unknown');
    expect(ledgerCostsStatus({ revenue: 100, cogs: 40 })).toBe('known');
    expect(ledgerCostsStatus({ revenue: 0, cogs: 0 })).toBe('known');
  });
});

describe('stockValueState', () => {
  it('unknown when every stocked product is uncosted', () => {
    expect(stockValueState({ stockValue: 0, stockedProducts: 5, uncostedProducts: 5 })).toEqual({
      kind: 'unknown',
    });
  });
  it('partial when some are uncosted', () => {
    expect(stockValueState({ stockValue: 900, stockedProducts: 5, uncostedProducts: 2 })).toEqual({
      kind: 'partial',
      value: 900,
      costed: 3,
      stocked: 5,
    });
  });
  it('full when all are costed, or when the API predates the coverage fields', () => {
    expect(stockValueState({ stockValue: 900, stockedProducts: 5, uncostedProducts: 0 }).kind).toBe(
      'full'
    );
    expect(stockValueState({ stockValue: 0 }).kind).toBe('full');
  });
  it('an empty shelf is a true 0', () => {
    expect(stockValueState({ stockValue: 0, stockedProducts: 0, uncostedProducts: 0 }).kind).toBe(
      'full'
    );
  });
});
