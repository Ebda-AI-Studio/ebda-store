/**
 * GET /stores/:storeId/search: cost + transport guards (review I1, I2 of Search P2).
 *  - the term is read from the X-Search-Query header only (never the URL),
 *  - ONE customer lookup per request, with small caps, reused by the order search,
 *  - a per-user limiter (GETs skip the global limiter) that answers 429 RATE_LIMITED,
 *  - a request with no term costs nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  matching: vi.fn(),
  productIds: vi.fn(),
  orderSearchWhere: vi.fn(),
  prismaCalls: [] as string[],
}));

vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@ebda/database')>();
  const find = (name: string) => async () => {
    h.prismaCalls.push(name);
    return [];
  };
  return {
    ...actual,
    // `storeDb(id)` scopes a Postgres store's model call in a short `withStore` when no scope is ambient (Ruling NZ-INTEG-SCOPE-1);
    // the real one would open a transaction on a database this unit test does not have (it passed only where one listens on 5432).
    withStore: async (_id: string, fn: () => unknown) => fn(),
    prisma: {
      product: { findMany: find('product') },
      order: { findMany: find('order') },
      user: { findMany: find('user') },
    },
  };
});
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = {
      userId: req.header('x-user') ?? 'u1',
      role: req.header('x-role') ?? 'store_admin',
    };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/admin-search.service', () => ({
  matchingCustomers: (...a: unknown[]) => h.matching(...a),
}));
vi.mock('@api/services/product-search.service', () => ({
  searchProductIds: (...a: unknown[]) => h.productIds(...a),
}));
vi.mock('@api/services/order.service', () => ({
  orderSearchWhere: (...a: unknown[]) => h.orderSearchWhere(...a),
}));

const { default: router } = await import('@api/routes/admin-search.routes');
const { ADMIN_SEARCH_LIMIT_PER_MINUTE } = await import('@api/middleware/security');

const STORE = '11111111-1111-4111-8111-111111111111';
const app = express();
app.use('/api/v1/stores', router);
const enc = encodeURIComponent;
const get = (term?: string, hdrs: Record<string, string> = {}) => {
  const r = request(app).get(`/api/v1/stores/${STORE}/search`);
  if (term !== undefined) r.set('X-Search-Query', enc(term));
  for (const [k, v] of Object.entries(hdrs)) r.set(k, v);
  return r;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.prismaCalls.length = 0;
  h.productIds.mockResolvedValue([]);
  h.orderSearchWhere.mockResolvedValue([{ id: { in: [] } }]);
  h.matching.mockResolvedValue({
    userIds: ['u1'],
    guestOrderIds: ['g1'],
    truncated: true,
    usersTruncated: true,
    guestsTruncated: true,
  });
});

describe('admin search route: transport (SEARCH-P2-9)', () => {
  it('reads the term from the X-Search-Query header, decoded (Arabic survives)', async () => {
    const res = await get('أحمد');
    expect(res.status).toBe(200);
    expect(h.matching).toHaveBeenCalledWith(STORE, 'أحمد', expect.any(Object));
    expect(res.headers.vary).toMatch(/X-Search-Query/i);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('ignores ?q= entirely: the URL form is not a way in', async () => {
    const res = await request(app).get(`/api/v1/stores/${STORE}/search?q=${enc('أحمد')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ products: [], orders: [], customers: [] });
    expect(h.matching).not.toHaveBeenCalled();
    expect(h.productIds).not.toHaveBeenCalled();
  });

  it('no term (the empty state) or a malformed header: three empty lists and no lookup at all', async () => {
    for (const r of [get(), get(undefined, { 'X-Search-Query': '%E0%A4%A' })]) {
      const res = await r;
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ products: [], orders: [], customers: [] });
    }
    expect(h.matching).not.toHaveBeenCalled();
    expect(h.productIds).not.toHaveBeenCalled();
    expect(h.prismaCalls).toEqual([]);
  });

  it('ONE character (search as you type) costs a product word-start lookup only: no customer or order scan', async () => {
    await get('ا');
    expect(h.productIds).toHaveBeenCalledTimes(1);
    expect(h.matching).not.toHaveBeenCalled();
    expect(h.orderSearchWhere).not.toHaveBeenCalled();
  });
});

describe('admin search route: cost (I1)', () => {
  it('runs the customer lookup ONCE and hands it to the order search, with small caps', async () => {
    await get('محمد علي');
    expect(h.matching).toHaveBeenCalledTimes(1);
    expect(h.matching).toHaveBeenCalledWith(STORE, 'محمد علي', { userCap: 50, guestCap: 200 });
    expect(h.orderSearchWhere).toHaveBeenCalledTimes(1);
    const [, , opts] = h.orderSearchWhere.mock.calls[0];
    expect(opts.numberIdLimit).toBe(50);
    // the order search reuses the lookup, and a capped lookup must not push it onto the unindexed fallback
    expect(opts.matches).toMatchObject({
      userIds: ['u1'],
      usersTruncated: false,
      guestsTruncated: false,
    });
  });

  it('a two-letter term skips the order search (it would take the unindexed relation filter)', async () => {
    await get('عل');
    expect(h.matching).toHaveBeenCalledTimes(1);
    expect(h.orderSearchWhere).not.toHaveBeenCalled();
  });

  it('a role without orders:read triggers no customer or order lookup at all', async () => {
    await get('محمد', { 'x-role': 'nobody' });
    expect(h.matching).not.toHaveBeenCalled();
    expect(h.orderSearchWhere).not.toHaveBeenCalled();
  });
});

describe('admin search route: per-user rate limit (I1)', () => {
  it('answers 429 RATE_LIMITED past the per-minute budget, per user, not per IP', async () => {
    const user = `rl-${Date.now()}`;
    let limited = 0;
    let firstLimitedAt = 0;
    for (let i = 1; i <= ADMIN_SEARCH_LIMIT_PER_MINUTE + 5; i++) {
      const res = await get('محمد', { 'x-user': user });
      if (res.status === 429) {
        limited++;
        firstLimitedAt ||= i;
        expect(res.body.error.code).toBe('RATE_LIMITED');
      }
    }
    expect(firstLimitedAt).toBe(ADMIN_SEARCH_LIMIT_PER_MINUTE + 1);
    expect(limited).toBe(5);
    // another user of the same IP (a shared office) is not limited by this one
    expect((await get('محمد', { 'x-user': `${user}-other` })).status).toBe(200);
  }, 60_000);
});
