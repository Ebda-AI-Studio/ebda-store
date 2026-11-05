/** `assertAggregateOnly`, mutation style: every forbidden shape is added to a clean payload and must go red. */
import { describe, expect, it } from 'vitest';
import {
  assertAggregateOnly,
  MAX_AGGREGATE_ENTRIES,
} from '../../apps/api/src/lib/ci/aggregate/guard';

const clean = () => ({
  asOf: '2026-11-03',
  windowDays: 90,
  cells: {
    'bosta|EG-C': { n: 120, hit: 12, stores: 6, maxShare: 0.3 },
    'aramex|EG-G': { suppressed: true },
  },
});

describe('assertAggregateOnly', () => {
  it('passes a clean aggregate', () => {
    expect(() => assertAggregateOnly(clean())).not.toThrow();
  });

  it.each([
    'buyerKey',
    'buyer_key',
    'orderId',
    'order_id',
    'phone',
    'email',
    'e-mail',
    'address',
    'name',
    'customerId',
  ])('rejects a key named %s', key => {
    const p = clean() as Record<string, unknown>;
    p[key] = 'x';
    expect(() => assertAggregateOnly(p)).toThrow(/forbidden key/);
  });

  it.each([
    ['an Egyptian mobile', '01012345678'],
    ['an E.164 phone', '+20 101 234 5678'],
    ['Arabic-Indic digits', '٠١٠١٢٣٤٥٦٧٨'],
    ['an email', 'ahmed@example.com'],
  ])('rejects a string value that is %s', (_n, v) => {
    const p = clean() as Record<string, unknown>;
    p.finding = `watch ${v} closely`;
    expect(() => assertAggregateOnly(p)).toThrow(/phone number or email/);
  });

  it('rejects a suppressed cell that carries content', () => {
    const p = clean();
    (p.cells['aramex|EG-G'] as Record<string, unknown>).n = 7;
    expect(() => assertAggregateOnly(p)).toThrow(/suppressed but carries content/);
  });

  it('rejects an oversized numeric array and an oversized object', () => {
    expect(() => assertAggregateOnly({ xs: new Array(MAX_AGGREGATE_ENTRIES + 1).fill(1) })).toThrow(
      /entries/
    );
    const big = Object.fromEntries(
      Array.from({ length: MAX_AGGREGATE_ENTRIES + 1 }, (_, i) => [`k${i}`, 1])
    );
    expect(() => assertAggregateOnly(big)).toThrow(/keys/);
  });

  it('dates and plain counts are not mistaken for phones', () => {
    expect(() =>
      assertAggregateOnly({ first: '2026-11-03', last: '2026-11-03', n: 1790000000000 })
    ).not.toThrow();
  });
});
