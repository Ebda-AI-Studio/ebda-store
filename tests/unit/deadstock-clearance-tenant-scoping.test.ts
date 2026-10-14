/**
 * createClearanceCouponFromFlag — cross-tenant IDOR regression guard.
 *
 * apps/api/src/services/accounting/deadstock-scan.service.ts used to look
 * up the DeadStockFlag with an unscoped `findUnique({ where: { id } })`
 * then create a Coupon using the flag's OWN storeId — so a store_admin
 * authenticated for store A could pass a dead-stock flag id belonging to
 * store B and mint a live discount coupon on store B's storefront. Fix:
 * the authenticated storeId is now a required parameter and the lookup is
 * `findFirst({ id, storeId })`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFlagFindFirst = vi.fn();
const mockFlagUpdate = vi.fn();
const mockCouponCreate = vi.fn();

vi.mock('@ebda/database', () => ({
  prisma: {
    deadStockFlag: {
      findFirst: (...args: unknown[]) => mockFlagFindFirst(...args),
      update: (...args: unknown[]) => mockFlagUpdate(...args),
    },
    coupon: {
      create: (...args: unknown[]) => mockCouponCreate(...args),
    },
  },
  withRlsBypass: vi.fn(),
  Prisma: {},
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../../apps/api/src/services/accounting/gemini-ai.service', () => ({
  callGemini: vi.fn(),
}));

import { createClearanceCouponFromFlag } from '../../apps/api/src/services/accounting/deadstock-scan.service';

const STORE_A = 'store-a';

describe('createClearanceCouponFromFlag — cross-tenant scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws 404 when the flag belongs to another store', async () => {
    mockFlagFindFirst.mockResolvedValue(null);

    await expect(
      createClearanceCouponFromFlag('flag-owned-by-store-b', STORE_A)
    ).rejects.toMatchObject({ statusCode: 404, code: 'FLAG_NOT_FOUND' });

    expect(mockFlagFindFirst).toHaveBeenCalledWith({
      where: { id: 'flag-owned-by-store-b', storeId: STORE_A },
      include: { product: { select: { sku: true, id: true } } },
    });
    expect(mockCouponCreate).not.toHaveBeenCalled();
  });

  it('creates the clearance coupon for a flag owned by the authenticated store (control)', async () => {
    mockFlagFindFirst.mockResolvedValue({
      id: 'flag-1',
      storeId: STORE_A,
      status: 'open',
      productId: 'product-1',
      suggestedDiscountBps: 2000,
      product: { sku: 'SKU-123', id: 'product-1' },
    });
    mockCouponCreate.mockResolvedValue({});
    mockFlagUpdate.mockResolvedValue({});

    const result = await createClearanceCouponFromFlag('flag-1', STORE_A);

    expect(result.couponCode).toBe('CLEAR-SKU123');
    expect(mockCouponCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ storeId: STORE_A }) })
    );
    expect(mockFlagUpdate).toHaveBeenCalledWith({
      where: { id: 'flag-1', storeId: STORE_A },
      data: { status: 'accepted_clearance', couponCode: 'CLEAR-SKU123' },
    });
  });
});
