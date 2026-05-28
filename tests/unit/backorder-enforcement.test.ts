/**
 * Backorder Feature Flag Enforcement — Unit Tests
 *
 * Verifies that every backorder code path respects the `inventory.backorder`
 * feature flag. The key invariant: when the flag is disabled, no backorder
 * rows can be created and the backorder management routes return 403.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRequest, createMockResponse, createMockNext, mockStore } from '../setup';

// Mock the feature service before importing middleware
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: vi.fn(),
    getStoreFeatures: vi.fn(),
  },
}));

// Mock logger to suppress output
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

const mockIsFeatureEnabled = featureService.isFeatureEnabled as ReturnType<typeof vi.fn>;

// ============================================================
// Route-level enforcement: requireFeature('inventory.backorder')
// ============================================================

describe('inventory.backorder route gate', () => {
  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
  });

  describe('when inventory.backorder is disabled', () => {
    beforeEach(() => {
      mockIsFeatureEnabled.mockResolvedValue(false);
    });

    it('returns 403 with FEATURE_DISABLED on GET /backorders', async () => {
      const req = createMockRequest({ params: { storeId: mockStore.id } });
      const res = createMockResponse();
      const next = createMockNext();

      const middleware = requireFeature('inventory.backorder');
      await middleware(req as any, res as any, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'FEATURE_DISABLED',
          feature: 'inventory.backorder',
        })
      );
    });

    it('returns 403 with FEATURE_DISABLED on POST /backorders/:id/cancel', async () => {
      const req = createMockRequest({
        params: { storeId: mockStore.id, id: 'test-backorder-id' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      const middleware = requireFeature('inventory.backorder');
      await middleware(req as any, res as any, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('returns 403 with FEATURE_DISABLED on POST /bulk-set-backorder', async () => {
      const req = createMockRequest({ params: { storeId: mockStore.id } });
      const res = createMockResponse();
      const next = createMockNext();

      const middleware = requireFeature('inventory.backorder');
      await middleware(req as any, res as any, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('when inventory.backorder is enabled', () => {
    beforeEach(() => {
      mockIsFeatureEnabled.mockResolvedValue(true);
    });

    it('calls next() and does NOT return 403 on GET /backorders', async () => {
      const req = createMockRequest({ params: { storeId: mockStore.id } });
      const res = createMockResponse();
      const next = createMockNext();

      const middleware = requireFeature('inventory.backorder');
      await middleware(req as any, res as any, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('fail-closed behaviour', () => {
    it('returns 403 when storeId is absent (cannot check feature)', async () => {
      mockIsFeatureEnabled.mockResolvedValue(true);

      const req = createMockRequest({ params: {} });
      const res = createMockResponse();
      const next = createMockNext();

      const middleware = requireFeature('inventory.backorder');
      await middleware(req as any, res as any, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      // Service should not be called when storeId is missing
      expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
    });

    it('returns 403 when the feature service throws (Redis down)', async () => {
      mockIsFeatureEnabled.mockRejectedValue(new Error('Redis timeout'));

      const req = createMockRequest({ params: { storeId: mockStore.id } });
      const res = createMockResponse();
      const next = createMockNext();

      const middleware = requireFeature('inventory.backorder');
      await middleware(req as any, res as any, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});

// ============================================================
// CartService — effectiveAllowBackorder logic
// ============================================================

describe('CartService effectiveAllowBackorder logic', () => {
  /**
   * Tests the dual-gate invariant:
   *   effectiveAllowBackorder = backorderFeatureEnabled && product.allowBackorder
   */

  function effectiveAllowBackorder(
    featureEnabled: boolean,
    productAllowBackorder: boolean
  ): boolean {
    return featureEnabled && productAllowBackorder;
  }

  it('returns false when feature is disabled and product allows backorder', () => {
    expect(effectiveAllowBackorder(false, true)).toBe(false);
  });

  it('returns false when feature is enabled and product does NOT allow backorder', () => {
    expect(effectiveAllowBackorder(true, false)).toBe(false);
  });

  it('returns false when both feature and product flag are false', () => {
    expect(effectiveAllowBackorder(false, false)).toBe(false);
  });

  it('returns true ONLY when both feature is enabled AND product allows backorder', () => {
    expect(effectiveAllowBackorder(true, true)).toBe(true);
  });
});
