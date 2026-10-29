/**
 * Barcode scan: pick-orders mismatch warnings and the audit-count reconcile.
 * Prisma and the stock-adjustment service are mocked: this proves the routing/guard logic,
 * not SQL. Stock only ever moves through createAdjustment + postAdjustment.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  prisma: {
    product: { findFirst: vi.fn(), findMany: vi.fn() },
    productVariant: { findFirst: vi.fn(), findMany: vi.fn() },
    orderItem: { findMany: vi.fn(), update: vi.fn() },
    countSession: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(),
  },
  createAdjustment: vi.fn(),
  postAdjustment: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: m.prisma,
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  Prisma: {},
}));
vi.mock('@api/services/inventory.service', () => ({ InventoryService: {} }));
vi.mock('@api/services/accounting/stock-adjustment.service', () => ({
  createAdjustment: m.createAdjustment,
  postAdjustment: m.postAdjustment,
}));
vi.mock('@api/lib/public-cache', () => ({ invalidateStoreProductCaches: vi.fn() }));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  pickOrderItemByBarcode,
  reconcileCountSession,
  resolvePickTarget,
} from '@api/services/barcode-scan.service';

const line = (over: Record<string, unknown> = {}) => ({
  id: 'oi-1',
  orderId: 'o-1',
  productId: 'p-1',
  variantId: null,
  productName: 'Abaya',
  personalisation: null,
  quantity: 2,
  pickedQty: 0,
  ...over,
});

describe('resolvePickTarget', () => {
  it('picks the first line still short of its quantity', () => {
    const r = resolvePickTarget([line({ id: 'a', pickedQty: 2 }), line({ id: 'b', pickedQty: 1 })]);
    expect(r).toMatchObject({ kind: 'pick', item: { id: 'b' } });
  });
  it('every matching line full -> already_picked (never a silent clamp)', () => {
    expect(resolvePickTarget([line({ pickedQty: 2 })])).toMatchObject({ kind: 'already_picked' });
  });
  it('no matching line -> not_in_order', () => {
    expect(resolvePickTarget([])).toEqual({ kind: 'not_in_order' });
  });
});

describe('pickOrderItemByBarcode mismatch warnings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // lookupBarcode: the barcode resolves to a plain product
    m.prisma.product.findFirst.mockResolvedValue({
      id: 'p-9',
      name: 'Scarf',
      nameAr: null,
      barcode: '111',
      sku: null,
      inventory: 3,
    });
    m.prisma.productVariant.findFirst.mockResolvedValue(null);
  });

  it('a real catalogue item that is not on this order -> 409 NOT_IN_ORDER naming it', async () => {
    m.prisma.orderItem.findMany.mockResolvedValue([]);
    await expect(pickOrderItemByBarcode('s-1', 'o-1', '111')).rejects.toMatchObject({
      statusCode: 409,
      code: 'NOT_IN_ORDER',
      details: expect.objectContaining({ productName: 'Scarf' }),
    });
    expect(m.prisma.orderItem.update).not.toHaveBeenCalled();
  });

  it('an unknown barcode stays a 404 BARCODE_NOT_FOUND', async () => {
    m.prisma.product.findFirst.mockResolvedValue(null);
    await expect(pickOrderItemByBarcode('s-1', 'o-1', 'zzz')).rejects.toMatchObject({
      statusCode: 404,
      code: 'BARCODE_NOT_FOUND',
    });
  });

  it('scanning past the ordered quantity -> 409 ALREADY_PICKED, nothing written', async () => {
    m.prisma.orderItem.findMany.mockResolvedValue([line({ productId: 'p-9', pickedQty: 2 })]);
    await expect(pickOrderItemByBarcode('s-1', 'o-1', '111')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ALREADY_PICKED',
    });
    expect(m.prisma.orderItem.update).not.toHaveBeenCalled();
  });
});

describe('reconcileCountSession', () => {
  const session = {
    id: 'cs-1',
    lines: [
      { productId: 'p-1', variantId: null, countedQty: 8, variance: -2 },
      { productId: 'p-2', variantId: 'v-2', countedQty: 5, variance: 0 },
    ],
  };
  beforeEach(() => {
    vi.clearAllMocks();
    m.prisma.countSession.findFirst.mockResolvedValue(session);
    m.prisma.countSession.updateMany.mockResolvedValue({ count: 1 });
    m.prisma.countSession.update.mockResolvedValue({});
    m.createAdjustment.mockResolvedValue({ id: 'adj-1' });
    m.postAdjustment.mockResolvedValue({});
  });

  it('posts ONE cycle_count adjustment for the non-zero lines and writes an audit row', async () => {
    const r = await reconcileCountSession('s-1', 'cs-1', 'u-1');
    expect(m.createAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cycle_count',
        items: [{ productId: 'p-1', variantId: undefined, newQty: 8 }],
      })
    );
    expect(m.postAdjustment).toHaveBeenCalledWith('s-1', 'adj-1', 'u-1');
    expect(m.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'inventory.count.reconciled',
        storeId: 's-1',
        userId: 'u-1',
        resourceId: 'cs-1',
        details: expect.objectContaining({ adjustmentId: 'adj-1', linesReconciled: 1 }),
      })
    );
    expect(r).toEqual({ adjustmentId: 'adj-1', linesReconciled: 1, zeroVarianceLines: 1 });
  });

  it('a concurrent second reconcile loses the claim and posts nothing', async () => {
    m.prisma.countSession.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(reconcileCountSession('s-1', 'cs-1', 'u-1')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    expect(m.createAdjustment).not.toHaveBeenCalled();
  });

  it('a failed post re-opens the claim so the merchant can retry', async () => {
    m.postAdjustment.mockRejectedValue(new Error('gl down'));
    await expect(reconcileCountSession('s-1', 'cs-1', 'u-1')).rejects.toThrow('gl down');
    const releases = m.prisma.countSession.updateMany.mock.calls.filter(
      c => c[0].data.status === 'closed'
    );
    expect(releases).toHaveLength(1);
    expect(m.insertAuditLog).not.toHaveBeenCalled();
  });
});
