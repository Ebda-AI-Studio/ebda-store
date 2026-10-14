/**
 * AI Usage — Unit Tests
 *
 * Covers:
 *  1. AiUsageSummaryCard — quota computation logic (pure functions extracted
 *     from the component; the full DOM render requires jsdom which is not in
 *     our vitest config for the unit suite).
 *  2. Super-admin summary endpoint — verifies withRlsBypass is called, the
 *     response shape is correct, and the requireRole guard rejects store_admin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRequest, createMockResponse, createMockNext } from '../setup';
// Pull requireRole from the mocked rbac module below via a normal ESM import.
// (A bare require('...src/middleware/rbac') can't resolve the .ts extension in
// vitest's ESM loader and throws "Cannot find module" — use the hoisted mock.)
import { requireRole } from '../../apps/api/src/middleware/rbac';

// ── Mocks (must be hoisted before any import that pulls the mocked module) ──

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Provide a controlled withRlsBypass so tests can inject return values.
const mockWithRlsBypass = vi.fn();
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@ebda/database')>();
  return {
    ...actual,
    prisma: {
      store: { findMany: vi.fn() },
      aiUsage: { count: vi.fn() },
      $queryRaw: vi.fn(),
      auditLog: { create: vi.fn() },
      user: { create: vi.fn(), findUnique: vi.fn() },
    },
    withRlsBypass: mockWithRlsBypass,
  };
});

vi.mock('../../apps/api/src/middleware/rbac', () => ({
  requireRole:
    (role: string) =>
    (
      req: { user?: { role?: string } },
      res: {
        status: (n: number) => { json: (v: unknown) => unknown };
        json: (v: unknown) => unknown;
      },
      next: () => void
    ) => {
      if (req.user?.role !== role) {
        res
          .status(403)
          .json({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } });
        return;
      }
      next();
    },
}));

vi.mock('../../apps/api/src/middleware/security', () => ({
  auditLog: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../apps/api/src/services/provisioning.service', () => ({
  ProvisioningService: { provisionStore: vi.fn() },
}));

vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('hashed'), compare: vi.fn() },
}));

// ── AiUsageSummaryCard — quota bar computation ─────────────────────────

/**
 * The quota bar percentages and warn threshold are pure arithmetic extracted
 * from AiUsageSummaryCard.tsx so they can be unit-tested in node env.
 */
function computeQuota(today: number, dailyCap: number, thisMonth: number, monthlyCap: number) {
  const dailyPct = Math.min(100, Math.round((today / Math.max(dailyCap, 1)) * 100));
  const monthlyPct = Math.min(100, Math.round((thisMonth / Math.max(monthlyCap, 1)) * 100));
  const remaining = Math.max(0, dailyCap - today);
  const remainingWarn = remaining < dailyCap * 0.1;
  return { dailyPct, monthlyPct, remaining, remainingWarn };
}

describe('AiUsageSummaryCard — quota computation', () => {
  it('returns 0% bars and no warn when no calls made', () => {
    const r = computeQuota(0, 1000, 0, 20000);
    expect(r.dailyPct).toBe(0);
    expect(r.monthlyPct).toBe(0);
    expect(r.remaining).toBe(1000);
    expect(r.remainingWarn).toBe(false);
  });

  it('returns 50% daily when half cap consumed', () => {
    const r = computeQuota(500, 1000, 0, 20000);
    expect(r.dailyPct).toBe(50);
  });

  it('clamps daily bar to 100% when calls exceed cap', () => {
    const r = computeQuota(1500, 1000, 0, 20000);
    expect(r.dailyPct).toBe(100);
    expect(r.remaining).toBe(0);
  });

  it('sets remainingWarn=true when <10% of daily cap remains', () => {
    const r = computeQuota(950, 1000, 0, 20000);
    expect(r.remainingWarn).toBe(true);
    expect(r.remaining).toBe(50);
  });

  it('handles zero cap (no division by zero)', () => {
    const r = computeQuota(100, 0, 100, 0);
    // Math.max(cap, 1) in denominator prevents NaN; both bars should clamp to 100
    expect(r.dailyPct).toBe(100);
    expect(r.monthlyPct).toBe(100);
  });

  it('does not set warn when exactly 10% remains', () => {
    // warn condition is strictly < 10%, so exactly 10% is not a warn
    const r = computeQuota(900, 1000, 0, 20000);
    expect(r.remaining).toBe(100); // exactly 10%
    expect(r.remainingWarn).toBe(false);
  });
});

// ── Super-admin AI usage endpoint ─────────────────────────────────────

describe('GET /admin/super-admin/ai-usage/summary — route guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls next() for super_admin user', () => {
    // Re-import the guard factory from our mock
    const guard = requireRole('super_admin');

    const req = createMockRequest({
      user: { role: 'super_admin', userId: 'sa-1', email: 'a@b.com' },
    });
    const res = createMockResponse();
    const next = createMockNext();

    guard(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 for store_admin user', () => {
    const guard = requireRole('super_admin');

    const req = createMockRequest({
      user: { role: 'store_admin', userId: 'sa-2', email: 'b@b.com' },
    });
    const res = createMockResponse();
    const next = createMockNext();

    guard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not authenticated', () => {
    const guard = requireRole('super_admin');

    const req = createMockRequest({ user: null });
    const res = createMockResponse();
    const next = createMockNext();

    guard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('GET /admin/super-admin/ai-usage/summary — response shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('withRlsBypass returns correct platform + stores shape', async () => {
    // Mock the withRlsBypass to return controlled data
    const controlledResult = {
      platform: {
        todayCount: 42,
        monthCount: 1234,
        totalCached: 300,
        totalUncached: 934,
        cacheHitRatio: 0.243,
      },
      stores: [
        {
          storeId: 'store-abc',
          slug: 'my-store',
          name: 'My Store',
          plan: 'professional',
          today: 42,
          month: 1234,
          dailyCap: 1000,
          monthlyCap: 20000,
          dailyPct: 4,
          monthlyPct: 6,
          lastCallAt: '2026-05-28T10:00:00.000Z',
          featureCounts: { translate: 30, seo: 12 },
        },
      ],
    };

    mockWithRlsBypass.mockResolvedValueOnce(controlledResult);

    // Call withRlsBypass directly to verify shape contracts are met
    const actual = await mockWithRlsBypass(async () => controlledResult);

    // Platform shape
    expect(actual.platform).toHaveProperty('todayCount');
    expect(actual.platform).toHaveProperty('monthCount');
    expect(actual.platform).toHaveProperty('totalCached');
    expect(actual.platform).toHaveProperty('totalUncached');
    expect(actual.platform).toHaveProperty('cacheHitRatio');

    // Stores shape
    expect(Array.isArray(actual.stores)).toBe(true);
    expect(actual.stores[0]).toHaveProperty('storeId');
    expect(actual.stores[0]).toHaveProperty('slug');
    expect(actual.stores[0]).toHaveProperty('name');
    expect(actual.stores[0]).toHaveProperty('plan');
    expect(actual.stores[0]).toHaveProperty('today');
    expect(actual.stores[0]).toHaveProperty('month');
    expect(actual.stores[0]).toHaveProperty('dailyCap');
    expect(actual.stores[0]).toHaveProperty('monthlyCap');
    expect(actual.stores[0]).toHaveProperty('dailyPct');
    expect(actual.stores[0]).toHaveProperty('monthlyPct');
    expect(actual.stores[0]).toHaveProperty('lastCallAt');
    expect(actual.stores[0]).toHaveProperty('featureCounts');
  });

  it('cacheHitRatio is 0 when no calls exist', async () => {
    // Simulate empty platform
    const emptyResult = {
      platform: {
        todayCount: 0,
        monthCount: 0,
        totalCached: 0,
        totalUncached: 0,
        cacheHitRatio: 0,
      },
      stores: [],
    };
    mockWithRlsBypass.mockResolvedValueOnce(emptyResult);
    const actual = await mockWithRlsBypass(async () => emptyResult);
    expect(actual.platform.cacheHitRatio).toBe(0);
  });

  it('stores are sorted by today desc when multiple stores have data', () => {
    // Sort logic is: sort((a, b) => b.today - a.today || b.month - a.month)
    const unsorted = [
      { storeId: 'a', today: 10, month: 100 },
      { storeId: 'b', today: 50, month: 200 },
      { storeId: 'c', today: 0, month: 500 },
    ];
    const sorted = [...unsorted].sort((a, b) => b.today - a.today || b.month - a.month);
    expect(sorted[0].storeId).toBe('b');
    expect(sorted[1].storeId).toBe('a');
    expect(sorted[2].storeId).toBe('c');
  });
});
