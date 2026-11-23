/**
 * Owner-assistant RPC (Ebda Chat Smart Layer): top products + coupon create. Pure logic over fake ports.
 * The caller's role is read LIVE; a coupon is owner-only, bounded, replay-safe and audited with before/after.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createOwnerTools,
  cairoStartOfDay,
  resetOwnerToolBuckets,
  MAX_FIXED_MINOR,
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
  const calls = { top: [] as any[], created: 0 };
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
