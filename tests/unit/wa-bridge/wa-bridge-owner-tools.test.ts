/**
 * Owner-assistant RPC (Ebda Chat Smart Layer): top products + coupon create. Pure logic over fake ports.
 * The caller's role is read LIVE; a coupon is owner-only, bounded, replay-safe and audited with before/after.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createOwnerTools,
  cairoStartOfDay,
  periodWindow,
  summariseOrders,
  resetOrdersSummaryCache,
  MAX_SUMMARY_ORDERS,
  type OrderRowLite,
  resetOwnerToolBuckets,
  MAX_FIXED_MINOR,
  MAX_PERCENT,
  MAX_WINDOW_DAYS,
  MAX_USAGE_LIMIT,
  type OwnerToolsPorts,
} from '../../../apps/api/src/lib/wa/bridge/owner-tools';

const S = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-23T12:00:00Z');
const KEY = 'preview-key-0001';

function fake(over: Partial<OwnerToolsPorts> = {}) {
  const coupons: any[] = [];
  const audits: any[] = [];
  const calls = { top: [] as any[], created: 0, orders: 0 };
  const ports: OwnerToolsPorts = {
    memberRole: async (_s, u) => (u === OWNER ? 'owner' : u === STAFF ? 'staff' : null),
    currency: async s => (s === S ? 'EGP' : null),
    isLinked: async () => true,
    featureEnabled: async () => true,
    topProducts: async (_s, range, limit) => {
      calls.top.push({ range, limit });
      return [
        { name: 'Ring', nameAr: 'خاتم', quantity: 9, revenue: 450000 },
        { name: 'Chain', nameAr: null, quantity: 4, revenue: 120000 },
      ];
    },
    ordersInWindow: async () => {
      calls.orders++;
      return ROWS;
    },
    findCoupon: async (_s, code) =>
      coupons.find(c => c.code.toLowerCase() === code.toLowerCase()) ?? null,
    createCoupon: async (_s, d) => {
      calls.created++;
      const row = { id: `c${coupons.length + 1}`, ...d, createdAt: new Date(NOW) };
      coupons.push(row);
      return row as any;
    },
    audit: async e => void audits.push(e),
    now: () => NOW,
    ...over,
  };
  return { t: createOwnerTools(ports), coupons, audits, calls };
}
const row = (o: Partial<OrderRowLite> & { total: number }): OrderRowLite => ({
  status: 'confirmed',
  paymentStatus: 'paid',
  online: true,
  cod: false,
  refundedMinor: 0,
  ...o,
});
const ROWS: OrderRowLite[] = [
  row({ total: 10_000, refundedMinor: 2_000 }), // paid online, partly refunded: counts, collected, net 8000
  row({ total: 5_000, status: 'delivered', paymentStatus: 'unpaid', online: false, cod: true }), // delivered COD: collected (CHIP-COD-DELIVERED-1)
  row({ total: 3_000, status: 'confirmed', paymentStatus: 'unpaid', online: false, cod: true }), // COD not yet delivered: a sale, not collected
  row({ total: 7_000, status: 'cancelled', paymentStatus: 'unpaid', online: false }), // cancelled: nothing
  row({ total: 9_000, status: 'pending', paymentStatus: 'unpaid', online: true }), // abandoned online checkout: nothing
  row({ total: 4_000, status: 'refunded', paymentStatus: 'refunded', refundedMinor: 4_000 }), // fully refunded: not a sale, its refund is counted
];
const base = {
  code: 'SAVE10',
  type: 'percentage' as const,
  value: 10,
  durationDays: 1,
  idempotencyKey: KEY,
};

beforeEach(() => resetOwnerToolBuckets());

describe('getTopProducts', () => {
  it('returns analytics rows for owner and staff, scoped to the resolved store', async () => {
    const f = fake();
    for (const u of [OWNER, STAFF]) {
      const r = await f.t.getTopProducts(S, u, { period: '7d', limit: 5 });
      expect(r).toMatchObject({
        ok: true,
        value: {
          currency: 'EGP',
          period: '7d',
          items: [
            { name: 'Ring', units: 9, revenueMinor: 450000 },
            { name: 'Chain', units: 4 },
          ],
        },
      });
    }
    expect(f.calls.top[0].limit).toBe(5);
    expect(f.calls.top[0].range.endDate.getTime() - f.calls.top[0].range.startDate.getTime()).toBe(
      7 * 86_400_000
    );
  });
  it('refuses a non-member, an unknown store, an unlinked store, bad args', async () => {
    const f = fake();
    expect(
      await f.t.getTopProducts(S, '33333333-3333-4333-8333-333333333333', {
        period: '30d',
        limit: 3,
      })
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(
      await f.t.getTopProducts('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', OWNER, {
        period: '30d',
        limit: 3,
      })
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(
      await fake({ isLinked: async () => false }).t.getTopProducts(S, OWNER, {
        period: '30d',
        limit: 3,
      })
    ).toMatchObject({ ok: false, reason: 'not_linked' });
    expect(await f.t.getTopProducts(S, OWNER, { period: 'year', limit: 3 })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await f.t.getTopProducts(S, OWNER, { period: '7d', limit: 11 })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(f.calls.top).toHaveLength(0);
  });
  it('"today" starts at Cairo midnight', () => {
    expect(new Date(cairoStartOfDay(NOW)).toISOString()).toBe('2026-11-22T22:00:00.000Z'); // UTC+2 in November
  });
  it('rate-limits a runaway caller per store', async () => {
    const f = fake();
    let limited = false;
    for (let i = 0; i < 40; i++) {
      const r = await f.t.getTopProducts(S, OWNER, { period: '7d', limit: 3 });
      if (!r.ok && r.code === 'RATE_LIMITED') limited = true;
    }
    expect(limited).toBe(true);
  });
});

describe('createCoupon', () => {
  it('is owner only (staff and non-members get FORBIDDEN, nothing is written)', async () => {
    const f = fake();
    expect(await f.t.createCoupon(S, STAFF, base)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await f.t.createCoupon(S, '33333333-3333-4333-8333-333333333333', base)).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(f.calls.created).toBe(0);
  });
  it('validates percent 1-90, fixed cap, window order and length, usage limit', async () => {
    const f = fake();
    const code = async (o: object) => {
      const r: any = await f.t.createCoupon(S, OWNER, { ...base, ...o });
      return r.ok ? 'ok' : r.code;
    };
    expect(await code({ value: 0 })).toBe('INVALID_ARGS');
    expect(await code({ value: 91 })).toBe('PERCENT_RANGE');
    expect(await code({ value: 90, code: 'NINETY' })).toBe('ok');
    expect(await code({ type: 'fixed', value: MAX_FIXED_MINOR + 1, code: 'BIG' })).toBe(
      'FIXED_TOO_LARGE'
    );
    expect(await code({ durationDays: 91, code: 'LONG' })).toBe('INVALID_ARGS');
    expect(
      await code({
        durationDays: undefined,
        startsAt: '2026-11-24T00:00:00Z',
        endsAt: '2026-11-23T00:00:00Z',
        code: 'BACK',
      })
    ).toBe('WINDOW_ORDER');
    expect(
      await code({
        durationDays: undefined,
        startsAt: '2026-11-24T00:00:00Z',
        endsAt: '2027-03-24T00:00:00Z',
        code: 'LONG2',
      })
    ).toBe('WINDOW_TOO_LONG');
    expect(
      await code({
        durationDays: undefined,
        startsAt: '2026-11-01T00:00:00Z',
        endsAt: '2026-11-02T00:00:00Z',
        code: 'PAST',
      })
    ).toBe('WINDOW_PAST');
    expect(await code({ durationDays: undefined, code: 'NOEND' })).toBe('INVALID_ARGS');
    expect(await code({ usageLimit: 0, code: 'ZERO' })).toBe('INVALID_ARGS');
  });
  it('refuses when the store has coupons switched off', async () => {
    const f = fake({ featureEnabled: async () => false });
    expect(await f.t.createCoupon(S, OWNER, base)).toMatchObject({
      ok: false,
      code: 'FEATURE_DISABLED',
    });
    expect(f.calls.created).toBe(0);
  });
  it('creates through the coupon service with an end from the creation time, and audits before/after', async () => {
    const f = fake();
    const r: any = await f.t.createCoupon(S, OWNER, { ...base, usageLimit: 50 });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({
      code: 'SAVE10',
      value: 10,
      usageLimit: 50,
      replayed: false,
      expiresAt: new Date(NOW + 86_400_000).toISOString(),
    });
    expect(f.coupons[0]).toMatchObject({ code: 'SAVE10', type: 'percentage', startsAt: null });
    expect(f.audits[0]).toMatchObject({
      action: 'coupon.created',
      userId: OWNER,
      storeId: S,
      details: { idempotencyKey: KEY, before: null, after: { code: 'SAVE10', value: 10 } },
    });
  });
  it('a retry of the same terms returns the same coupon (no duplicate, no second audit)', async () => {
    const f = fake();
    const a: any = await f.t.createCoupon(S, OWNER, base);
    const b: any = await f.t.createCoupon(S, OWNER, base);
    expect(b).toMatchObject({ ok: true, value: { couponId: a.value.couponId, replayed: true } });
    expect(f.coupons).toHaveLength(1);
    expect(f.audits).toHaveLength(1);
  });
  it('the same code with different terms is a duplicate, never an overwrite', async () => {
    const f = fake();
    await f.t.createCoupon(S, OWNER, base);
    expect(await f.t.createCoupon(S, OWNER, { ...base, value: 20 })).toMatchObject({
      ok: false,
      code: 'DUPLICATE_CODE',
    });
    expect(f.coupons).toHaveLength(1);
  });
  it('the same code with a different window is a duplicate, not a replay of the earlier window; an identical explicit window is a replay', async () => {
    const f = fake();
    await f.t.createCoupon(S, OWNER, base); // 1 day from NOW
    expect(await f.t.createCoupon(S, OWNER, { ...base, durationDays: 2 })).toMatchObject({
      ok: false,
      code: 'DUPLICATE_CODE',
    });
    expect(
      await f.t.createCoupon(S, OWNER, {
        ...base,
        durationDays: undefined,
        endsAt: '2026-11-25T12:00:00Z',
      })
    ).toMatchObject({ ok: false, code: 'DUPLICATE_CODE' });
    expect(
      await f.t.createCoupon(S, OWNER, {
        ...base,
        durationDays: undefined,
        startsAt: '2026-11-23T13:00:00Z',
        endsAt: '2026-11-24T12:00:00Z',
      })
    ).toMatchObject({ ok: false, code: 'DUPLICATE_CODE' }); // a start where the first had none
    const e = {
      ...base,
      code: 'EXPL',
      durationDays: undefined,
      startsAt: '2026-11-24T00:00:00Z',
      endsAt: '2026-11-26T00:00:00Z',
    };
    const first: any = await f.t.createCoupon(S, OWNER, e);
    expect(await f.t.createCoupon(S, OWNER, e)).toMatchObject({
      ok: true,
      value: { couponId: first.value.couponId, replayed: true },
    });
    expect(
      await f.t.createCoupon(S, OWNER, { ...e, endsAt: '2026-11-26T00:00:01Z' })
    ).toMatchObject({ ok: false, code: 'DUPLICATE_CODE' });
    expect(f.coupons).toHaveLength(2);
  });
  it('limits pinned to ebda-whatsapp COUPON_LIMITS (src/core/store-bridge.ts); change both together', () => {
    expect({
      percentMax: MAX_PERCENT,
      fixedMaxMinor: MAX_FIXED_MINOR,
      windowDaysMax: MAX_WINDOW_DAYS,
      usageLimitMax: MAX_USAGE_LIMIT,
    }).toEqual({
      percentMax: 90,
      fixedMaxMinor: 5_000_000,
      windowDaysMax: 90,
      usageLimitMax: 100_000,
    });
  });
  it('a code race the lookup missed maps to DUPLICATE_CODE', async () => {
    const f = fake({
      createCoupon: async () => {
        throw Object.assign(new Error('DUPLICATE_CODE'), { code: 'DUPLICATE_CODE' });
      },
    });
    expect(await f.t.createCoupon(S, OWNER, base)).toMatchObject({
      ok: false,
      code: 'DUPLICATE_CODE',
    });
  });
  it('a failing audit never undoes the created coupon', async () => {
    const f = fake({
      audit: async () => {
        throw new Error('audit down');
      },
    });
    expect(await f.t.createCoupon(S, OWNER, base)).toMatchObject({ ok: true });
  });
});

describe('getOrdersSummary', () => {
  const sale = (over: Partial<OwnerToolsPorts> = {}) => fake(over);
  beforeEach(() => resetOrdersSummaryCache());

  it('counts like the dashboard, collects paid and delivered-COD orders net of refunds, counts refunds, averages over collected orders', () => {
    expect(summariseOrders(ROWS)).toEqual({
      orderCount: 3,
      collectedOrders: 2,
      salesMinor: 8_000 + 5_000,
      refundsMinor: 2_000 + 4_000,
      avgOrderMinor: 6_500,
    });
    expect(summariseOrders([])).toEqual({
      orderCount: 0,
      collectedOrders: 0,
      salesMinor: 0,
      refundsMinor: 0,
      avgOrderMinor: 0,
    });
  });

  it('Cairo windows: today, yesterday, week from Saturday, month from the 1st, rolling 7 days', () => {
    const w = (p: Parameters<typeof periodWindow>[0]) => {
      const r = periodWindow(p, NOW);
      return [new Date(r.fromMs).toISOString(), new Date(r.toMs).toISOString()];
    };
    expect(w('today')).toEqual(['2026-11-22T22:00:00.000Z', '2026-11-23T12:00:00.000Z']);
    expect(w('yesterday')).toEqual(['2026-11-21T22:00:00.000Z', '2026-11-22T21:59:59.999Z']);
    expect(w('this_week')[0]).toBe('2026-11-20T22:00:00.000Z'); // Monday 23rd: the week began Saturday the 21st, Cairo midnight
    expect(w('this_month')[0]).toBe('2026-10-31T22:00:00.000Z'); // 1 Nov Cairo midnight
    expect(w('last_7_days')).toEqual(['2026-11-16T12:00:00.000Z', '2026-11-23T12:00:00.000Z']);
  });

  it('owner only: staff and non-members are FORBIDDEN and nothing is read; a bad period is INVALID_ARGS', async () => {
    const f = sale();
    expect(await f.t.getOrdersSummary(S, STAFF, { period: 'today' })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(
      await f.t.getOrdersSummary(S, '33333333-3333-4333-8333-333333333333', { period: 'today' })
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await f.t.getOrdersSummary(S, OWNER, { period: 'year' })).toMatchObject({
      ok: false,
      code: 'INVALID_ARGS',
    });
    expect(f.calls.orders).toBe(0);
  });

  it('answers from the store: figures in minor units with the store currency', async () => {
    const f = sale();
    expect(await f.t.getOrdersSummary(S, OWNER, { period: 'today' })).toMatchObject({
      ok: true,
      value: {
        currency: 'EGP',
        period: 'today',
        orderCount: 3,
        collectedOrders: 2,
        salesMinor: 13_000,
        refundsMinor: 6_000,
        avgOrderMinor: 6_500,
      },
    });
  });

  it('BOUNDED-stale cache: a repeat within 60 s reuses the figures, after 60 s it reads again; the role is re-checked on every call', async () => {
    let clock = NOW;
    const f = sale({ now: () => clock });
    await f.t.getOrdersSummary(S, OWNER, { period: 'today' });
    clock += 30_000;
    await f.t.getOrdersSummary(S, OWNER, { period: 'today' });
    expect(f.calls.orders).toBe(1);
    expect(await f.t.getOrdersSummary(S, STAFF, { period: 'today' })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    }); // a cached figure is never handed to a non-owner
    await f.t.getOrdersSummary(S, OWNER, { period: 'this_week' });
    expect(f.calls.orders).toBe(2); // another period is its own entry
    clock += 31_000;
    await f.t.getOrdersSummary(S, OWNER, { period: 'today' });
    expect(f.calls.orders).toBe(3);
  });

  it('never a partial figure: a window too large to read in full is refused', async () => {
    const f = sale({
      ordersInWindow: async () =>
        Array.from({ length: MAX_SUMMARY_ORDERS + 1 }, () => row({ total: 1 })),
    });
    expect(await f.t.getOrdersSummary(S, OWNER, { period: 'this_month' })).toMatchObject({
      ok: false,
      reason: 'unavailable',
      code: 'RANGE_TOO_LARGE',
    });
  });

  it('is rate-limited per store', async () => {
    const f = sale();
    let limited = false;
    for (let i = 0; i < 40; i++) {
      const r = await f.t.getOrdersSummary(S, OWNER, { period: 'today' });
      if (!r.ok && r.code === 'RATE_LIMITED') limited = true;
    }
    expect(limited).toBe(true);
  });
});
