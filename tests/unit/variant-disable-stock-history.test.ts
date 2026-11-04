/**
 * issue 2146 — disabling a variant that holds stock removes those units from
 * every stock and stock-value figure (a disabled variant is not stock, Ruling
 * M5-6) without any quantity changing, so the drop had no audit trail. The
 * flip now writes a zero-quantity InventoryHistory marker. Mutation-proof:
 * deleting the marker block reddens the first two cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  historyCreate: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    productVariant: { findFirst: h.findFirst, update: h.update },
    inventoryHistory: { create: h.historyCreate },
  },
  Prisma: {},
}));
vi.mock('@api/lib/public-cache', () => ({ invalidateStoreProductCaches: vi.fn() }));
vi.mock('@api/services/r2-cleanup.service', () => ({ deleteR2ObjectIfOrphan: vi.fn() }));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { VariantService } from '@api/services/variant.service';

describe('VariantService.updateVariant — disabling a stocked variant is traceable (issue 2146)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.update.mockResolvedValue({ id: 'v1' });
    h.historyCreate.mockResolvedValue({});
  });

  it('writes a zero-quantity history marker when a variant holding stock is disabled', async () => {
    h.findFirst.mockResolvedValue({
      id: 'v1',
      isActive: true,
      inventory: 100,
      imageUrl: null,
      product: { status: 'draft', price: 0, pricingMode: 'fixed' },
    });
    await VariantService.updateVariant('s1', 'p1', 'v1', { isActive: false });
    expect(h.historyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'p1',
        storeId: 's1',
        type: 'adjustment',
        quantity: 0,
        previousStock: 100,
        newStock: 100,
        reference: 'variant:v1',
        reason: expect.stringMatching(/disabled.*100 unit/),
      }),
    });
  });

  it('records re-enabling too', async () => {
    h.findFirst.mockResolvedValue({
      id: 'v1',
      isActive: false,
      inventory: 7,
      imageUrl: null,
      product: { status: 'draft', price: 0, pricingMode: 'fixed' },
    });
    await VariantService.updateVariant('s1', 'p1', 'v1', { isActive: true });
    expect(h.historyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: expect.stringMatching(/re-enabled.*7 unit/) }),
    });
  });

  it('writes nothing when no stock is held, or the flag did not change', async () => {
    h.findFirst.mockResolvedValue({
      id: 'v1',
      isActive: true,
      inventory: 0,
      imageUrl: null,
      product: { status: 'draft', price: 0, pricingMode: 'fixed' },
    });
    await VariantService.updateVariant('s1', 'p1', 'v1', { isActive: false });
    h.findFirst.mockResolvedValue({
      id: 'v1',
      isActive: true,
      inventory: 5,
      imageUrl: null,
      product: { status: 'draft', price: 0, pricingMode: 'fixed' },
    });
    await VariantService.updateVariant('s1', 'p1', 'v1', { isActive: true, price: 100 });
    expect(h.historyCreate).not.toHaveBeenCalled();
  });
});
