/**
 * Feature Toggle Engine — Unit Tests
 * Tests for the feature registry (shared) and requireFeature middleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRequest, createMockResponse, createMockNext, mockStore } from '../setup';

// Feature registry — import from direct path since @ebda/shared points to dist/
import {
  FEATURE_KEYS_ARRAY,
  featureKeySchema,
  featureUpdatesSchema,
} from '../../packages/shared/src/features';

// Mock the feature service before importing the middleware
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: vi.fn(),
  },
}));

// requireFeature falls back to resolvePublicStoreId (store-helpers.ts) for
// routes with no :storeId/:id param. `stores` is under RLS, so that resolution goes through the
// `lookupStore` / `resolveStoreId` definers (lib/definer.ts), not a Prisma read.
// `mockStore` (imported from '../setup') cannot be referenced here — vi.mock
// factories are hoisted above every import statement in the file — so its
// id is duplicated as a literal instead.
vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('../../apps/api/src/lib/definer', () => ({
  lookupStore: vi.fn(async ({ id }: { id?: string }) =>
    id === 'test-store-id-789' ? { id: 'test-store-id-789', status: 'active' } : null
  ),
  resolveStoreId: vi.fn(async ({ domain, slug }: { domain?: string; slug?: string }) =>
    domain || slug ? 'test-store-id-789' : null
  ),
}));

// Mock logger to suppress output during tests
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: {
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { requireFeature } from '../../apps/api/src/middleware/feature-gate';
import { featureService } from '../../apps/api/src/services/feature.service';

// ============================================================
// Feature Registry Tests
// ============================================================

describe('Feature Registry', () => {
  describe('FEATURE_KEYS_ARRAY', () => {
    // 2026-05-21: 22 keys (added floating_widget).
    // 2026-05-27: 36 keys (added 7 inventory.* + 7 accounting.* sub-features
    //   for the 3-tier plan system — see packages/shared/src/plan-baselines.ts).
    // 2026-06-22: 37 keys (added payment_abandonment Enterprise feature).
    // 2026-07-13: 38 keys (added agent_feed add-on feature).
    // 2026-07-24: 40 keys (merge of agent_checkout + answer_engine_insights add-on features).
    // 2026-09-06: 41 keys (added `bundles` — Product Bundles, in NO plan baseline).
    // 2026-09-09: 42 keys (added `agent_checkout_open_writes` — the MCP
    //   agent-write escape hatch, in NO plan baseline; Ruling M2).
    // 2026-09-11: 43 keys (added `merchant_mcp` — the merchant-admin MCP
    //   surface, in NO plan baseline so the whole surface is dark until a
    //   super-admin enables it per store).
    // 2026-09-25: 44 keys (added `customer_wallet_checkout` — spending the
    //   wallet at checkout, a second toggle in NO plan baseline).
    // 2026-10-07: 45 keys (added `remove_branding` — decided by the plan layer, in NO baseline).
    // 2026-10-07: 46 keys (added `product_3d` — every plan's baseline, Ruling R-EBDA-3D-2).
    // 2026-10-10: 47 keys (added `merchant_mcp_write` — MCP write tools, decided by the plan layer, in NO baseline).
    // 2026-10-21: 48 keys (added `b2b.wholesale` — B2B wholesale pricing, decided by the plan layer, in NO baseline).
    // 2026-10-26: 49 keys (added `eta_ereceipt` — Egypt ETA e-receipt connector, hidden, in NO baseline; Ruling ETA-1).
    // 2026-10-29: 50 keys (added `customer_intelligence` — CI-3 smart hints, merchant-visible, in NO baseline; Ruling CI-10).
    it('has exactly 50 entries', () => {
      expect(FEATURE_KEYS_ARRAY).toHaveLength(50);
    });
  });

  describe('featureKeySchema', () => {
    it('validates known key: coupons', () => {
      const result = featureKeySchema.safeParse('coupons');
      expect(result.success).toBe(true);
    });

    it('validates known key: loyalty', () => {
      const result = featureKeySchema.safeParse('loyalty');
      expect(result.success).toBe(true);
    });

    it('validates known key: whatsapp', () => {
      const result = featureKeySchema.safeParse('whatsapp');
      expect(result.success).toBe(true);
    });

    it('rejects unknown key: unknown_feature', () => {
      const result = featureKeySchema.safeParse('unknown_feature');
      expect(result.success).toBe(false);
    });

    it('rejects empty string', () => {
      const result = featureKeySchema.safeParse('');
      expect(result.success).toBe(false);
    });

    it('rejects non-string input: 123', () => {
      const result = featureKeySchema.safeParse(123);
      expect(result.success).toBe(false);
    });
  });

  describe('featureUpdatesSchema', () => {
    it('validates valid updates: {coupons: true, loyalty: false}', () => {
      const result = featureUpdatesSchema.safeParse({ coupons: true, loyalty: false });
      expect(result.success).toBe(true);
    });

    it('rejects updates with unknown keys: {unknown: true}', () => {
      const result = featureUpdatesSchema.safeParse({ unknown: true });
      expect(result.success).toBe(false);
    });

    it('rejects empty object: {}', () => {
      const result = featureUpdatesSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================
// requireFeature Middleware Tests
// ============================================================

describe('requireFeature Middleware', () => {
  const mockIsFeatureEnabled = featureService.isFeatureEnabled as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
  });

  it('should call next() when feature is enabled', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    const req = createMockRequest({ params: { storeId: mockStore.id } });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = requireFeature('coupons');
    await middleware(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should return 403 with FEATURE_DISABLED code when feature is disabled', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);

    const req = createMockRequest({ params: { storeId: mockStore.id } });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = requireFeature('coupons');
    await middleware(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
  });

  it('should fail closed (403) when no storeId available — empty params, no headers', async () => {
    const req = createMockRequest({ params: {}, headers: {} });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = requireFeature('loyalty');
    await middleware(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
    // Service should not be called at all when storeId is missing
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });

  it('should fail closed (403) on service error', async () => {
    mockIsFeatureEnabled.mockRejectedValue(new Error('Redis connection failed'));

    const req = createMockRequest({ params: { storeId: mockStore.id } });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = requireFeature('whatsapp');
    await middleware(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
  });

  it('should resolve storeId from x-store-id header when not in params', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    const req = createMockRequest({
      params: {},
      headers: { 'x-store-id': mockStore.id },
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = requireFeature('seo');
    await middleware(req as any, res as any, next);

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(mockStore.id, 'seo');
    expect(next).toHaveBeenCalledOnce();
  });
});
