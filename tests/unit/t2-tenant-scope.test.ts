/**
 * BE:S-25 / S-7 / S-30: a coupon or promotion may only target this store's customer group, a count line may only read this
 * store's variant, and staff cannot page the whole customer list.
 */
import { describe, it, expect, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    customerGroup: { findFirst: vi.fn() },
    countSession: { findFirst: vi.fn() },
    productVariant: { findFirst: vi.fn() },
    product: { findFirst: vi.fn() },
  },
}));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<object>()),
  prisma: prismaMock,
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: vi.fn(),
  storeStock: vi.fn().mockResolvedValue(null),
  storeWriter: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const STORE = '11111111-1111-1111-1111-111111111111';

describe('assertCustomerGroupInStore (BE:S-25)', () => {
  it('passes without a group and for an own group; 404 for a foreign one', async () => {
    const repo = await import('@api/lib/repo-factory');
    vi.mocked(repo.storeDb).mockResolvedValue(prismaMock as never);
    const { assertCustomerGroupInStore } = await import('@api/lib/customer-group-scope');
    await expect(assertCustomerGroupInStore(STORE, null)).resolves.toBeUndefined();
    await expect(assertCustomerGroupInStore(STORE, undefined)).resolves.toBeUndefined();
    expect(prismaMock.customerGroup.findFirst).not.toHaveBeenCalled();

    prismaMock.customerGroup.findFirst.mockResolvedValueOnce({ id: 'g1' });
    await expect(assertCustomerGroupInStore(STORE, 'g1')).resolves.toBeUndefined();
    expect(prismaMock.customerGroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'g1', storeId: STORE } })
    );

    prismaMock.customerGroup.findFirst.mockResolvedValueOnce(null);
    await expect(assertCustomerGroupInStore(STORE, 'foreign')).rejects.toMatchObject({
      statusCode: 404,
      code: 'CUSTOMER_GROUP_NOT_FOUND',
    });
  });
});

describe('submitCountLine variant lookup (BE:S-7)', () => {
  it("reads the variant only through THIS store's product", async () => {
    prismaMock.countSession.findFirst.mockResolvedValue({ id: 'sess' });
    prismaMock.productVariant.findFirst.mockResolvedValue({ inventory: 4 });
    prismaMock.product.findFirst.mockResolvedValue(null);
    const { submitCountLine } = await import('@api/services/barcode-scan.service');
    // the upsert after the lookup is not under test: the lookup's WHERE is
    await submitCountLine(STORE, 'sess', { productId: 'p1', variantId: 'v1', countedQty: 2 }).catch(
      () => undefined
    );
    expect(prismaMock.productVariant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'v1', productId: 'p1', product: { storeId: STORE } },
      })
    );
  });
});
