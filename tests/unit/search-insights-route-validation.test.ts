/**
 * Ported from tests/integration/search-insights-route.test.ts (Postgres; the original is deleted): the route's own contract.
 * The real router, mounted as routes/index.ts mounts it, with the auth chain stubbed so the test can assert its ORDER
 * (authenticate, MFA, permission, store access) and the real permission check refusing a customer (no analytics:read).
 * `days` outside 7|30|90 and an unknown `filter` are 400 and never reach the reader; a refused role never reaches store access.
 * The privacy floor and the window are the reader's (search-log tests); the reader is stubbed here and its arguments asserted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  getSearchInsights: vi.fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: unknown, _s: unknown, n: () => void) => n(),
  authenticate: (
    req: { user?: unknown; header: (n: string) => string | undefined },
    _res: unknown,
    next: () => void
  ) => {
    h.calls.push('authenticate');
    req.user = { userId: 'user-1', role: req.header('x-test-role') ?? 'store_admin' };
    next();
  },
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: unknown, _res: unknown, next: () => void) => {
    h.calls.push('mfa');
    next();
  },
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: unknown, _res: unknown, next: () => void) => {
    h.calls.push('storeAccess');
    next();
  },
}));
vi.mock('../../apps/api/src/services/search-log.service', () => ({
  getSearchInsights: h.getSearchInsights,
}));
vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeMoney: async () => ({
    vectorStatus: async () => ({ ready: 3, total: 4, failed: 1 }),
  }),
}));

import { errorHandler } from '../../apps/api/src/middleware/error-handler';
import searchInsightsRoutes from '../../apps/api/src/routes/search-insights.routes';

const STORE = '11111111-1111-4111-8111-111111111111';
const app = express();
app.use(express.json());
app.use('/api/v1/stores', searchInsightsRoutes);
app.use(errorHandler);
const get = (qs: string, role?: string) => {
  const r = request(app).get(`/api/v1/stores/${STORE}/search-insights${qs}`);
  return role ? r.set('x-test-role', role) : r;
};

beforeEach(() => {
  h.calls.length = 0;
  h.getSearchInsights.mockReset();
  h.getSearchInsights.mockResolvedValue({
    days: 7,
    filter: 'zero',
    terms: [],
    totals: { searches: 0, zeroResults: 0 },
  });
});

describe('GET /stores/:storeId/search-insights', () => {
  it.each(['?days=400', '?days=0', '?days=abc', '?days=30&filter=bogus'])(
    'rejects %s with 400 and never reads',
    async qs => {
      const res = await get(qs);
      expect(res.status).toBe(400);
      expect(h.getSearchInsights).not.toHaveBeenCalled();
    }
  );

  it('passes a valid window and filter to the reader (defaults 30 / zero) and adds the index line', async () => {
    const res = await get('?days=90&filter=all');
    expect(res.status).toBe(200);
    expect(h.getSearchInsights).toHaveBeenCalledWith(STORE, { days: 90, filter: 'all' });
    expect(res.body.data.index).toMatchObject({ ready: 3, total: 4, failed: 1 });
    await get('');
    expect(h.getSearchInsights).toHaveBeenLastCalledWith(STORE, { days: 30, filter: 'zero' });
  });

  it.each([
    ['store_admin', 200],
    ['super_admin', 200],
    ['staff', 200], // staff hold analytics:read (Ruling SEARCH-T6-1)
    ['customer', 403], // no analytics:read
  ])('role %s gets %i', async (role, status) => {
    expect((await get('?days=7', role)).status).toBe(status);
  });

  it('runs authenticate, MFA, permission, store access in that order; a refused role never reaches store access', async () => {
    await get('?days=7');
    expect(h.calls).toEqual(['authenticate', 'mfa', 'storeAccess']);
    h.calls.length = 0;
    await get('?days=7', 'customer');
    expect(h.calls).toEqual(['authenticate', 'mfa']);
  });
});
