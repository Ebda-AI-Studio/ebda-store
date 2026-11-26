/**
 * Ruling G35-PRORATE-1: the one proration seam. Upgrade = (new total - old total) x remaining days / period days,
 * VAT included, rounded UP to the piastre; downgrade = nothing now, effective at the period end.
 */
import { describe, it, expect } from 'vitest';
import {
  periodStartFor,
  quotePlanChange,
  wholeDaysCeil,
} from '../../apps/api/src/services/billing/proration';
import {
  PLATFORM_VAT_OFF,
  type PlatformVat,
} from '../../apps/api/src/services/billing/charge-amount';

const d = (iso: string) => new Date(iso);
const VAT_EXCL: PlatformVat = { enabled: true, rateBps: 1400, mode: 'exclusive' };
const VAT_INCL: PlatformVat = { enabled: true, rateBps: 1400, mode: 'inclusive' };

describe('quotePlanChange (G35-PRORATE-1)', () => {
  it('upgrade halfway through a 30-day period charges half the difference, period unchanged', () => {
    const q = quotePlanChange({
      currentPriceMinor: 20000,
      newPriceMinor: 50000,
      periodStart: d('2026-11-01T00:00:00Z'),
      periodEnd: d('2026-12-01T00:00:00Z'),
      now: d('2026-11-16T00:00:00Z'),
      vat: PLATFORM_VAT_OFF,
    });
    expect(q.kind).toBe('upgrade');
    expect(q.periodDays).toBe(30);
    expect(q.remainingDays).toBe(15);
    expect(q.charge.totalMinor).toBe(15000);
    expect(q.charge.vat).toBeNull();
    expect(q.periodEnd.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('rounds UP to the piastre and counts a started day as remaining', () => {
    const q = quotePlanChange({
      currentPriceMinor: 19999,
      newPriceMinor: 49900,
      periodStart: d('2026-11-03T04:00:00Z'),
      periodEnd: d('2026-12-03T04:00:00Z'),
      now: d('2026-11-23T05:00:00Z'), // 9 days 23 h left -> 10 days
      vat: PLATFORM_VAT_OFF,
    });
    expect(q.remainingDays).toBe(10);
    // 29901 * 10 / 30 = 9967 exactly; 29901 * 7 / 30 = 6976.9 -> 6977 (checked below)
    expect(q.charge.totalMinor).toBe(9967);
    const q7 = quotePlanChange({
      currentPriceMinor: 19999,
      newPriceMinor: 49900,
      periodStart: d('2026-11-03T04:00:00Z'),
      periodEnd: d('2026-12-03T04:00:00Z'),
      now: d('2026-11-26T04:00:00Z'),
      vat: PLATFORM_VAT_OFF,
    });
    expect(q7.remainingDays).toBe(7);
    expect(q7.charge.totalMinor).toBe(6977);
  });

  it('VAT exclusive: prorates the VAT-included totals and carves the VAT out of the charge', () => {
    const q = quotePlanChange({
      currentPriceMinor: 20000, // total 22800
      newPriceMinor: 50000, // total 57000
      periodStart: d('2026-11-01T00:00:00Z'),
      periodEnd: d('2026-12-01T00:00:00Z'),
      now: d('2026-11-21T00:00:00Z'), // 10 of 30 days
      vat: VAT_EXCL,
    });
    expect(q.currentTotalMinor).toBe(22800);
    expect(q.newTotalMinor).toBe(57000);
    expect(q.charge.totalMinor).toBe(11400); // 34200 / 3
    expect(q.charge.netMinor + q.charge.vatMinor).toBe(11400);
    expect(q.charge.vatMinor).toBe(1400); // 11400 - round(11400 / 1.14)
    expect(q.charge.vat?.rateBps).toBe(1400);
  });

  it('VAT inclusive: the plan price already holds VAT, the charge is the plain prorated difference', () => {
    const q = quotePlanChange({
      currentPriceMinor: 20000,
      newPriceMinor: 50000,
      periodStart: d('2026-11-01T00:00:00Z'),
      periodEnd: d('2026-12-01T00:00:00Z'),
      now: d('2026-11-21T00:00:00Z'),
      vat: VAT_INCL,
    });
    expect(q.charge.totalMinor).toBe(10000);
    expect(q.charge.netMinor + q.charge.vatMinor).toBe(10000);
  });

  it('month end: a Jan 31 -> Feb 28 period is 28 days long', () => {
    const q = quotePlanChange({
      currentPriceMinor: 28000,
      newPriceMinor: 56000,
      periodStart: d('2027-01-31T00:00:00Z'),
      periodEnd: d('2027-02-28T00:00:00Z'),
      now: d('2027-02-14T00:00:00Z'),
      vat: PLATFORM_VAT_OFF,
    });
    expect(q.periodDays).toBe(28);
    expect(q.remainingDays).toBe(14);
    expect(q.charge.totalMinor).toBe(14000);
  });

  it('leap year: a Feb 2028 period has 29 days and a yearly period over Feb 29 has 366', () => {
    const feb = quotePlanChange({
      currentPriceMinor: 0,
      newPriceMinor: 29000,
      periodStart: d('2028-02-01T00:00:00Z'),
      periodEnd: d('2028-03-01T00:00:00Z'),
      now: d('2028-02-29T00:00:00Z'),
      vat: PLATFORM_VAT_OFF,
    });
    expect(feb.periodDays).toBe(29);
    expect(feb.remainingDays).toBe(1);
    expect(feb.charge.totalMinor).toBe(1000);
    const year = quotePlanChange({
      currentPriceMinor: 100000,
      newPriceMinor: 466000,
      periodStart: d('2027-06-01T00:00:00Z'),
      periodEnd: d('2028-06-01T00:00:00Z'),
      now: d('2027-12-01T00:00:00Z'),
      vat: PLATFORM_VAT_OFF,
    });
    expect(year.periodDays).toBe(366);
    expect(year.remainingDays).toBe(183);
    expect(year.charge.totalMinor).toBe(183000);
  });

  it('a period stretched by a free month never charges more than one full difference', () => {
    const q = quotePlanChange({
      currentPriceMinor: 20000,
      newPriceMinor: 50000,
      periodStart: d('2026-11-01T00:00:00Z'),
      periodEnd: d('2027-01-01T00:00:00Z'), // 61 days (one paid month + one granted)
      now: d('2026-11-01T00:00:00Z'),
      vat: PLATFORM_VAT_OFF,
    });
    expect(q.remainingDays).toBe(q.periodDays);
    expect(q.charge.totalMinor).toBe(30000);
  });

  it('downgrade charges nothing and takes effect at the period end', () => {
    const q = quotePlanChange({
      currentPriceMinor: 50000,
      newPriceMinor: 20000,
      periodStart: d('2026-11-01T00:00:00Z'),
      periodEnd: d('2026-12-01T00:00:00Z'),
      now: d('2026-11-16T00:00:00Z'),
      vat: VAT_EXCL,
    });
    expect(q.kind).toBe('downgrade');
    expect(q.charge.totalMinor).toBe(0);
    expect(q.effectiveAt.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('an upgrade with no day left charges nothing (the renewal bills the new plan)', () => {
    const q = quotePlanChange({
      currentPriceMinor: 20000,
      newPriceMinor: 50000,
      periodStart: d('2026-11-01T00:00:00Z'),
      periodEnd: d('2026-12-01T00:00:00Z'),
      now: d('2026-12-01T00:00:00Z'),
      vat: PLATFORM_VAT_OFF,
    });
    expect(q.kind).toBe('upgrade');
    expect(q.remainingDays).toBe(0);
    expect(q.charge.totalMinor).toBe(0);
  });
});

describe('periodStartFor / wholeDaysCeil', () => {
  it('walks one interval back with the day clamped to the month', () => {
    expect(periodStartFor(d('2026-12-03T04:00:00Z'), 'monthly').toISOString()).toBe(
      '2026-11-03T04:00:00.000Z'
    );
    expect(periodStartFor(d('2028-03-31T00:00:00Z'), 'monthly').toISOString()).toBe(
      '2028-02-29T00:00:00.000Z'
    );
    expect(periodStartFor(d('2027-03-31T00:00:00Z'), 'monthly').toISOString()).toBe(
      '2027-02-28T00:00:00.000Z'
    );
    expect(periodStartFor(d('2027-01-15T00:00:00Z'), 'monthly').toISOString()).toBe(
      '2026-12-15T00:00:00.000Z'
    );
    expect(periodStartFor(d('2029-02-28T00:00:00Z'), 'yearly').toISOString()).toBe(
      '2028-02-28T00:00:00.000Z'
    );
  });

  it('counts a started day, never negative', () => {
    expect(wholeDaysCeil(d('2026-11-01T00:00:00Z'), d('2026-11-01T00:00:01Z'))).toBe(1);
    expect(wholeDaysCeil(d('2026-11-02T00:00:00Z'), d('2026-11-01T00:00:00Z'))).toBe(0);
    expect(wholeDaysCeil(d('2026-11-01T00:00:00Z'), d('2026-11-03T00:00:00Z'))).toBe(2);
  });
});

describe('paidTotalMinor: never credit more than was paid (money review C3)', () => {
  const base = {
    currentPriceMinor: 20000,
    newPriceMinor: 50000,
    periodStart: d('2026-11-01T00:00:00Z'),
    periodEnd: d('2026-12-01T00:00:00Z'),
    now: d('2026-11-16T00:00:00Z'),
    vat: PLATFORM_VAT_OFF,
  };
  it('a smaller paid amount is the credit; a larger one is capped at the catalogue price', () => {
    expect(quotePlanChange({ ...base, paidTotalMinor: 10000 }).charge.totalMinor).toBe(20000); // (50000-10000)/2
    expect(quotePlanChange({ ...base, paidTotalMinor: 99999 }).charge.totalMinor).toBe(15000); // capped at 20000
    expect(quotePlanChange({ ...base, paidTotalMinor: null }).charge.totalMinor).toBe(15000);
  });
});
