/** CI-3 hints: both sides of every threshold, the "not enough data" path, and advise-only outputs. */
import { describe, expect, it } from 'vitest';
import type { Cell, Cells, Metric } from '../../apps/api/src/lib/ci/aggregate/cells';
import type { Cohort, StoreWindow } from '../../apps/api/src/lib/ci/aggregate/run';
import { wilsonLower, wilsonUpper } from '../../apps/api/src/lib/ci/aggregate/stats';
import {
  STORE_MIN_N,
  aggregateFresh,
  cohortCellShowable,
  pickCell,
  storeCellShowable,
  type HintData,
} from '../../apps/api/src/lib/ci/hints/thresholds';
import { codRiskHint } from '../../apps/api/src/lib/ci/hints/cod-risk';
import { rankCouriers } from '../../apps/api/src/lib/ci/hints/courier';
import { feeHint } from '../../apps/api/src/lib/ci/hints/fee';

const NOW = new Date('2026-11-10T09:00:00Z');
const AS_OF = '2026-11-09';
const cell = (n: number, hit: number, o: Partial<Cell> = {}): Cell => ({
  n,
  hit,
  sum: 0,
  first: '2026-10-01',
  last: '2026-11-08',
  ...o,
});
const empty = (): Cells => ({
  return_rate: {},
  delivery_hours: {},
  cod_confirmation: {},
  cod_return_by_amount: {},
  return_by_shipping_fee: {},
  payment_failure: {},
  onboarding_step: {},
  cart_recovery: {},
});
function win(own: Partial<Record<Metric, Record<string, Cell>>>, asOf = AS_OF): StoreWindow {
  return { v: 1, storeId: 's', asOf, windowDays: 90, own: { ...empty(), ...own }, shared: empty() };
}
function cohort(metrics: Partial<Record<Metric, Record<string, unknown>>>, asOf = AS_OF): Cohort {
  return {
    v: 1,
    asOf,
    windowDays: 90,
    metrics: {
      return_rate: {},
      delivery_hours: {},
      cod_confirmation: {},
      cod_return_by_amount: {},
      return_by_shipping_fee: {},
      payment_failure: {},
      onboarding_step: {},
      cart_recovery: {},
      ...metrics,
    } as Cohort['metrics'],
  };
}
const pub = (n: number, hit: number, o: Record<string, number> = {}) => ({
  n,
  hit,
  sum: 0,
  stores: 6,
  maxShare: 0.3,
  ...o,
});
const data = (w: StoreWindow | null, c: Cohort | null): HintData => ({
  window: w,
  cohort: c,
  now: NOW,
});

describe('wilson', () => {
  it('matches known values', () => {
    expect(wilsonLower(50, 100)).toBeCloseTo(0.4038, 3);
    expect(wilsonUpper(50, 100)).toBeCloseTo(0.5962, 3);
    expect(wilsonLower(0, 0)).toBe(0);
  });
});

describe('thresholds', () => {
  it('store cell: n 29 / 30 and span 13 / 14 days', () => {
    expect(storeCellShowable(cell(STORE_MIN_N - 1, 1))).toBe(false);
    expect(storeCellShowable(cell(STORE_MIN_N, 1))).toBe(true);
    expect(storeCellShowable(cell(40, 1, { first: '2026-10-01', last: '2026-10-13' }))).toBe(false); // 13 days
    expect(storeCellShowable(cell(40, 1, { first: '2026-10-01', last: '2026-10-14' }))).toBe(true); // 14 days
  });
  it('cohort cell: n 99/100, stores 4/5, share 0.41/0.4', () => {
    expect(cohortCellShowable(pub(99, 1))).toBe(false);
    expect(cohortCellShowable(pub(100, 1))).toBe(true);
    expect(cohortCellShowable(pub(200, 1, { stores: 4 }))).toBe(false);
    expect(cohortCellShowable(pub(200, 1, { stores: 5 }))).toBe(true);
    expect(cohortCellShowable(pub(200, 1, { maxShare: 0.41 }))).toBe(false);
    expect(cohortCellShowable(pub(200, 1, { maxShare: 0.4 }))).toBe(true);
  });
  it('freshness: 7 days old ok, 9 days old not', () => {
    expect(aggregateFresh('2026-11-03', NOW)).toBe(true);
    expect(aggregateFresh('2026-11-01', NOW)).toBe(false);
    expect(aggregateFresh(undefined, NOW)).toBe(false);
  });
  it('a stale window yields no cell, and a suppressed cohort cell is never picked', () => {
    const stale = win({ return_rate: { '*|EG-C': cell(60, 6) } }, '2026-10-01');
    expect(pickCell(data(stale, null), 'store', 'return_rate', ['*|EG-C'])).toBeUndefined();
    const c = cohort({ return_rate: { '*|EG-C': { suppressed: true } } });
    expect(pickCell(data(null, c), 'cohort', 'return_rate', ['*|EG-C'])).toBeUndefined();
  });
});

describe('codRiskHint', () => {
  const base = { '*|*': pub(1000, 100) }; // platform 10%
  it('not enough data anywhere: insufficient, no number', () => {
    const h = codRiskHint(data(null, null), 'EG-C-nasr-city', null);
    expect(h).toMatchObject({
      band: 'insufficient',
      source: 'none',
      n: 0,
      rate: null,
      suggestions: [],
    });
  });
  it('typical when the area is in line with the platform', () => {
    const c = cohort({ return_rate: { ...base, '*|EG-C': pub(400, 40) } });
    const h = codRiskHint(data(null, c), 'EG-C-nasr-city', null);
    expect(h).toMatchObject({ band: 'typical', source: 'cohort', n: 400 });
    expect(h.suggestions).toEqual([]);
  });
  it('elevated only when the Wilson lower bound clears the baseline', () => {
    // 15% of 400: lower bound ~11.8% > 10%
    const hi = codRiskHint(
      data(null, cohort({ return_rate: { ...base, '*|EG-C': pub(400, 60) } })),
      'EG-C',
      null
    );
    expect(hi.band).toBe('elevated');
    expect(hi.suggestions).toEqual(['confirm_by_phone', 'ask_instapay_deposit']);
    // 12% of 100: lower bound ~7% < 10%, a high-looking rate on a small sample is NOT elevated
    const lo = codRiskHint(
      data(null, cohort({ return_rate: { ...base, '*|EG-C': pub(100, 12) } })),
      'EG-C',
      null
    );
    expect(lo.band).toBe('typical');
  });
  it('uses the district first, then falls back to the governorate', () => {
    const c = cohort({ return_rate: { ...base, '*|EG-C': pub(400, 60) } });
    expect(codRiskHint(data(null, c), 'EG-C-maadi', null)).toMatchObject({
      band: 'elevated',
      n: 400,
    });
  });
  it("the buyer's own history inside the store raises the band even with no area data", () => {
    expect(codRiskHint(data(null, null), null, { shipped: 4, returned: 2 })).toMatchObject({
      band: 'elevated',
      source: 'store',
      reasons: ['buyer'],
      n: 4,
    });
    expect(codRiskHint(data(null, null), null, { shipped: 3, returned: 1 }).band).toBe(
      'insufficient'
    );
    expect(codRiskHint(data(null, null), null, { shipped: 10, returned: 2 }).band).toBe(
      'insufficient'
    ); // 2 of 10 < half
  });
  it('a store-only cell is judged against the platform baseline when there is one', () => {
    const w = win({ return_rate: { '*|EG-C': cell(80, 30) } });
    const c = cohort({ return_rate: base });
    expect(codRiskHint(data(w, c), 'EG-C', null)).toMatchObject({
      band: 'elevated',
      source: 'store',
    });
  });
});

describe('rankCouriers', () => {
  const rr = {
    'bosta|EG-C': pub(300, 15), // 95% delivered
    'aramex|EG-C': pub(300, 45), // 85%
  };
  it('ranks by delivered rate and suggests the leader when two can be compared', () => {
    const r = rankCouriers(data(null, cohort({ return_rate: rr })), 'EG-C-nasr-city', [
      'aramex',
      'bosta',
      'mylerz',
    ]);
    expect(r.ranked.map(x => [x.carrier, x.status])).toEqual([
      ['bosta', 'ok'],
      ['aramex', 'ok'],
      ['mylerz', 'insufficient'],
    ]);
    expect(r.suggested).toBe('bosta');
    expect(r.ranked[0]).toMatchObject({ scope: 'cohort', n: 300 });
  });
  it('no suggestion with fewer than two comparable carriers', () => {
    const r = rankCouriers(
      data(null, cohort({ return_rate: { 'bosta|EG-C': pub(300, 15) } })),
      'EG-C',
      ['bosta', 'aramex']
    );
    expect(r.suggested).toBeNull();
    expect(r.ranked[0]!.carrier).toBe('bosta');
  });
  it('breaks a tie on hours, store-only first', () => {
    const w = win({
      return_rate: { 'a|EG-C': cell(50, 5), 'b|EG-C': cell(50, 5) },
      delivery_hours: {
        'a|EG-C': { ...cell(50, 50), sum: 50 * 30 },
        'b|EG-C': { ...cell(50, 50), sum: 50 * 20 },
      },
    });
    const r = rankCouriers(data(w, null), 'EG-C', ['a', 'b']);
    expect(r.ranked.map(x => x.carrier)).toEqual(['b', 'a']);
    expect(r.ranked[0]).toMatchObject({ scope: 'store', meanHours: 20 });
  });
  it('nothing below the threshold is shown', () => {
    const r = rankCouriers(data(win({ return_rate: { 'a|EG-C': cell(29, 0) } }), null), 'EG-C', [
      'a',
    ]);
    expect(r.ranked).toEqual([{ carrier: 'a', status: 'insufficient' }]);
  });
});

describe('feeHint', () => {
  // Fee bands (CI-13): f0 free .. f4 100+ EGP; the hint reads the REAL shipping fee, not the COD amount.
  const amt = (f4: ReturnType<typeof pub>) => ({
    '*': pub(1000, 100),
    f1: pub(300, 30),
    f2: pub(300, 30),
    f3: pub(200, 20),
    f4,
  });
  it('suggests the lowest band that returns clearly more', () => {
    const f = feeHint(data(null, cohort({ return_by_shipping_fee: amt(pub(150, 45)) })));
    expect(f.status).toBe('ok');
    expect(f.suggestion).toMatchObject({ thresholdMinor: 10_000, scope: 'cohort', n: 150 });
  });
  it('no suggestion when no band clears the baseline, and insufficient with no baseline at all', () => {
    expect(feeHint(data(null, cohort({ return_by_shipping_fee: amt(pub(150, 15)) })))).toEqual({
      status: 'ok',
      suggestion: null,
    });
    expect(feeHint(data(null, null))).toEqual({ status: 'insufficient', suggestion: null });
  });
  it('the COD-amount proxy no longer feeds the hint (CI-13)', () => {
    const f = feeHint(
      data(null, cohort({ cod_return_by_amount: { '*': pub(1000, 100), b4: pub(150, 45) } }))
    );
    expect(f).toEqual({ status: 'insufficient', suggestion: null });
  });
});
