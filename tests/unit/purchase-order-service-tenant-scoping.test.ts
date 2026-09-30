/**
 * createPoFromSuggestion — cross-tenant IDOR regression guard.
 *
 * apps/api/src/services/accounting/purchase-order.service.ts used to look
 * up the ReorderSuggestion with an unscoped `findUnique({ where: { id } })`
 * then write a PurchaseOrder using the suggestion's OWN storeId — so a
 * store_admin authenticated for store A could pass a suggestion id
 * belonging to store B and have FWB draft (and pay for) a PO on store B's
 * behalf. Fix: the authenticated storeId is now a required parameter and
 * the lookup is `findFirst({ id, storeId })`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReorderSuggestionFindFirst = vi.fn();
const mockPurchaseOrderItemFindFirst = vi.fn();

vi.mock('@force/database', () => ({
  prisma: {
    reorderSuggestion: {
      findFirst: (...args: unknown[]) => mockReorderSuggestionFindFirst(...args),
      update: vi.fn(),
    },
    purchaseOrderItem: {
      findFirst: (...args: unknown[]) => mockPurchaseOrderItemFindFirst(...args),
    },
  },
  withMoneyTx: vi.fn(),
}));
vi.mock('../../apps/api/src/services/sequence.service', () => ({
  nextSequence: vi.fn(),
}));
vi.mock('../../apps/api/src/services/accounting/account.service', () => ({
  getSystemAccountIdByCode: vi.fn(),
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { createPoFromSuggestion } from '../../apps/api/src/services/accounting/purchase-order.service';

const STORE_A = 'store-a';

describe('createPoFromSuggestion — cross-tenant scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws 404 when the suggestion belongs to another store', async () => {
    mockReorderSuggestionFindFirst.mockResolvedValue(null);

    await expect(
      createPoFromSuggestion('sug-owned-by-store-b', STORE_A, 'user-1')
    ).rejects.toMatchObject({ statusCode: 404, code: 'SUGGESTION_NOT_FOUND' });

    expect(mockReorderSuggestionFindFirst).toHaveBeenCalledWith({
      where: { id: 'sug-owned-by-store-b', storeId: STORE_A },
      include: {
        product: {
          select: { costPrice: true, name: true, _count: { select: { variants: true } } },
        },
        variant: { select: { costPrice: true } },
      },
    });
  });

  it('finds the suggestion + proceeds past the ownership check for the authenticated store (control)', async () => {
    // supplierId null + no prior PO for the product => surfaces
    // SUPPLIER_REQUIRED (400), proving the code got PAST the tenant-scoped
    // lookup without needing to stub the full createPurchaseOrder money-tx
    // pipeline.
    mockReorderSuggestionFindFirst.mockResolvedValue({
      id: 'sug-1',
      storeId: STORE_A,
      status: 'open',
      supplierId: null,
      productId: 'product-1',
      variantId: null,
      suggestedQty: 10,
      urgencyDays: 3,
      velocity7d: 1.2,
      product: { costPrice: 100, name: 'Widget', _count: { variants: 0 } },
    });
    mockPurchaseOrderItemFindFirst.mockResolvedValue(null);

    await expect(createPoFromSuggestion('sug-1', STORE_A, 'user-1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'SUPPLIER_REQUIRED',
    });

    expect(mockReorderSuggestionFindFirst).toHaveBeenCalledWith({
      where: { id: 'sug-1', storeId: STORE_A },
      include: {
        product: {
          select: { costPrice: true, name: true, _count: { select: { variants: true } } },
        },
        variant: { select: { costPrice: true } },
      },
    });
  });
});
