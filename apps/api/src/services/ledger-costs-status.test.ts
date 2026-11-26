import { describe, expect, it } from 'vitest';
import { cogsFromPnl, ledgerCostsFields, ledgerCostsStatus } from './analytics.service';

const base = { revenue: 485000, cogs: 0, soldLines: 0, missingLines: 0 };

describe('ledgerCostsStatus (QA 2026-11-17 N1 + money review M1)', () => {
  it('unknown: revenue, nothing sold has a cost', () => {
    expect(ledgerCostsStatus({ ...base, soldLines: 3, missingLines: 3 })).toBe('unknown');
  });
  it('partial: some sold lines have a cost and some do not (COGS > 0 must not read as known)', () => {
    expect(ledgerCostsStatus({ ...base, cogs: 100000, soldLines: 5, missingLines: 2 })).toBe(
      'partial'
    );
  });
  it('known: every sold line has a cost', () => {
    expect(ledgerCostsStatus({ ...base, cogs: 100000, soldLines: 5, missingLines: 0 })).toBe(
      'known'
    );
  });
  it('known: refunds reverse COGS to exactly 0 but every line had a cost', () => {
    expect(ledgerCostsStatus({ ...base, cogs: 0, soldLines: 4, missingLines: 0 })).toBe('known');
  });
  it('no revenue means nothing to be unknown about', () => {
    expect(ledgerCostsStatus({ revenue: 0, cogs: 0, soldLines: 0, missingLines: 0 })).toBe('known');
  });
  it('no sold lines at all: the ledger decides (revenue without booked COGS is unknown)', () => {
    expect(ledgerCostsStatus({ ...base, cogs: 0 })).toBe('unknown');
    expect(ledgerCostsStatus({ ...base, cogs: 5 })).toBe('known');
  });
  it('fields carry status and the missing/total counts', () => {
    expect(ledgerCostsFields(1000, 10, { soldLines: 5, missingLines: 2 })).toEqual({
      costsStatus: 'partial',
      costsMissing: 2,
      costsTotal: 5,
    });
  });
});

describe('cogsFromPnl: the single 50xx rule', () => {
  it('sums only the 50xx expense accounts', () => {
    expect(
      cogsFromPnl({
        expenses: [
          { code: '5000', balance: 700 },
          { code: '5010', balance: 300 },
          { code: '6100', balance: 999 },
        ],
      })
    ).toBe(1000);
  });
});
