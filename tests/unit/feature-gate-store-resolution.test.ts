/**
 * #1554 — requireFeature had its OWN inline storeId resolution
 * (`req.headers['x-store-id']` read raw, no DB check, no x-store-domain
 * fallback), separate from getStoreIdFromRequest's — used by the SAME
 * routes' handlers. A request with only `x-store-domain` set (no
 * `x-store-id`) got FEATURE_DISABLED from the gate even when the
 * domain-resolved store had the feature enabled, because the gate could not
 * see that header at all. requireFeature now falls back to the shared
 * resolvePublicStoreId() so the gate and the handler it guards resolve to
 * the same store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const findFirst = vi.fn();
vi.mock('@ebda/database', () => ({
  prisma: { store: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

// Host / slug -> store id goes through the `ebda_resolve_store_id` definer; `findFirst` keeps
// standing for "the store row that host or slug names".
vi.mock('../../apps/api/src/lib/definer', () => ({
  resolveStoreId: async (match: { slug?: string | null; domain?: string | null }) => {
    const where = match.domain ? { domain: match.domain } : { slug: match.slug };
    return ((await findFirst({ where })) as { id: string } | null)?.id ?? null;
  },
}));

const isFeatureEnabled = vi.fn();
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: (...a: unknown[]) => isFeatureEnabled(...a) },
}));

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { requireFeature } from '../../apps/api/src/middleware/feature-gate';

function makeReq(headers: Record<string, string> = {}): Request {
  return { params: {}, headers, user: { role: 'customer' } } as unknown as Request;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe('requireFeature — falls back to the shared, validated store resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves via x-store-domain when x-store-id is absent, matching getStoreIdFromRequest', async () => {
    findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      if (where.domain === 'shop.example') return Promise.resolve({ id: 'store-domain-resolved' });
      return Promise.resolve(null);
    });
    isFeatureEnabled.mockResolvedValue(true);

    const req = makeReq({ 'x-store-domain': 'shop.example' });
    const res = makeRes();
    const next = vi.fn();

    await requireFeature('bundles')(req, res, next as unknown as NextFunction);

    expect(isFeatureEnabled).toHaveBeenCalledWith('store-domain-resolved', 'bundles');
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('403s FEATURE_DISABLED (not a resolution failure) when the domain-resolved store has the feature off', async () => {
    findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      if (where.domain === 'shop.example') return Promise.resolve({ id: 'store-domain-resolved' });
      return Promise.resolve(null);
    });
    isFeatureEnabled.mockResolvedValue(false);

    const req = makeReq({ 'x-store-domain': 'shop.example' });
    const res = makeRes();
    const next = vi.fn();

    await requireFeature('bundles')(req, res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { code?: string }).code).toBe('FEATURE_DISABLED');
  });

  it('still fails closed (403) when no header resolves to a real store', async () => {
    findFirst.mockResolvedValue(null);

    const req = makeReq({ 'x-store-domain': 'no-such-shop.example' });
    const res = makeRes();
    const next = vi.fn();

    await requireFeature('bundles')(req, res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });

  it('a route param still wins over any header (no DB call needed)', async () => {
    isFeatureEnabled.mockResolvedValue(true);
    const req = {
      params: { storeId: 'route-store' },
      headers: {},
      user: { role: 'customer' },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn();

    await requireFeature('bundles')(req, res, next as unknown as NextFunction);

    expect(findFirst).not.toHaveBeenCalled();
    expect(isFeatureEnabled).toHaveBeenCalledWith('route-store', 'bundles');
    expect(next).toHaveBeenCalledOnce();
  });
});
