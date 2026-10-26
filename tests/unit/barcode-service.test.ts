import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  product: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  productVariant: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  featureOn: vi.fn(),
}));

vi.mock('@ebda/database', () => {
  const tx = {
    $queryRaw: db.queryRaw,
    $executeRaw: vi.fn(),
    product: db.product,
    productVariant: db.productVariant,
  };
  return {
    prisma: tx,
    withStore: async (_id: string, fn: (t: unknown) => unknown) => fn(tx),
  };
});
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: db.featureOn },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  allocateBarcodes,
  assertBarcodeAvailable,
  ensureBarcode,
  generateMissingBarcodes,
  parseBarcodeOrThrow,
} from '../../apps/api/src/services/barcode.service';
import { isInStoreEan13 } from '../../packages/shared/src/barcode';

beforeEach(() => {
  vi.clearAllMocks();
  db.queryRaw.mockResolvedValue([{ m: null }]);
  db.featureOn.mockResolvedValue(true);
  db.product.findFirst.mockResolvedValue(null);
  db.productVariant.findFirst.mockResolvedValue(null);
});

describe('parseBarcodeOrThrow', () => {
  it('returns the normalised value or a 422 with the reason', () => {
    expect(parseBarcodeOrThrow(' 4006381333931 ')).toBe('4006381333931');
    expect(() => parseBarcodeOrThrow('4006381333932')).toThrowError(
      expect.objectContaining({ statusCode: 422, code: 'BARCODE_INVALID' })
    );
  });
});

describe('allocateBarcodes', () => {
  it('takes the advisory lock FIRST, then hands out consecutive in-store EAN-13 after the highest serial', async () => {
    db.queryRaw.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{ m: 41n }]);
    const codes = await allocateBarcodes('s1', 3);
    expect(codes).toHaveLength(3);
    expect(codes.every(isInStoreEan13)).toBe(true);
    expect(codes.map(c => Number(c.slice(2, 12)))).toEqual([42, 43, 44]);
    const first = String(db.queryRaw.mock.calls[0][0].join(' '));
    expect(first).toContain('pg_advisory_xact_lock');
    expect(db.queryRaw.mock.calls[0].slice(1)).toEqual(['s1:barcode']);
  });
  it('starts at serial 1 for a store with none, and returns [] for 0', async () => {
    const [c] = await allocateBarcodes('s1', 1);
    expect(Number(c.slice(2, 12))).toBe(1);
    expect(await allocateBarcodes('s1', 0)).toEqual([]);
  });
  it('refuses when the serial range is exhausted', async () => {
    db.queryRaw.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{ m: 9_999_999_999n }]);
    await expect(allocateBarcodes('s1', 1)).rejects.toMatchObject({ code: 'BARCODE_RANGE_FULL' });
  });
});

describe('assertBarcodeAvailable', () => {
  it('passes when free, and when the holder is the row being saved', async () => {
    await expect(assertBarcodeAvailable('s1', '4006381333931')).resolves.toBeUndefined();
    db.product.findFirst.mockResolvedValue({ id: 'p1', name: 'Ring' });
    await expect(
      assertBarcodeAvailable('s1', '4006381333931', { productId: 'p1' })
    ).resolves.toBeUndefined();
  });
  it('409 BARCODE_IN_USE naming a product, or a variant of another product', async () => {
    db.product.findFirst.mockResolvedValue({ id: 'p9', name: 'Ring' });
    await expect(
      assertBarcodeAvailable('s1', '4006381333931', { productId: 'p1' })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'BARCODE_IN_USE',
    });
    db.product.findFirst.mockResolvedValue(null);
    db.productVariant.findFirst.mockResolvedValue({
      id: 'v9',
      title: 'Size 7',
      productId: 'p9',
      product: { name: 'Ring' },
    });
    await expect(
      assertBarcodeAvailable('s1', '4006381333931', { variantId: 'v1' })
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      assertBarcodeAvailable('s1', '4006381333931', { variantId: 'v9' })
    ).resolves.toBeUndefined();
  });
  it('looks only inside the store and ignores soft-deleted products', async () => {
    await assertBarcodeAvailable('s1', 'ABC');
    expect(db.product.findFirst.mock.calls[0][0].where).toMatchObject({
      storeId: 's1',
      barcode: 'ABC',
      deletedAt: null,
    });
    expect(db.productVariant.findFirst.mock.calls[0][0].where).toMatchObject({
      barcode: 'ABC',
      product: { storeId: 's1', deletedAt: null },
    });
  });
});

describe('ensureBarcode', () => {
  it('does nothing without the inventory.barcode feature', async () => {
    db.featureOn.mockResolvedValue(false);
    expect(await ensureBarcode('s1', { productId: 'p1' })).toBeNull();
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });
  it('writes only onto a row that still has no barcode (a concurrent writer wins)', async () => {
    db.product.updateMany.mockResolvedValue({ count: 1 });
    const code = await ensureBarcode('s1', { productId: 'p1' });
    expect(code && isInStoreEan13(code)).toBe(true);
    expect(db.product.updateMany.mock.calls[0][0].where).toEqual({
      id: 'p1',
      storeId: 's1',
      barcode: null,
    });
    db.productVariant.updateMany.mockResolvedValue({ count: 0 });
    expect(await ensureBarcode('s1', { variantId: 'v1' })).toBeNull();
  });
  it('never throws: a failure leaves the row barcode-less', async () => {
    db.queryRaw.mockRejectedValue(new Error('db down'));
    await expect(ensureBarcode('s1', { productId: 'p1' })).resolves.toBeNull();
  });
});

describe('generateMissingBarcodes', () => {
  it('fills product-without-variants and variants, one allocation, reports what remains', async () => {
    db.product.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    db.productVariant.findMany.mockResolvedValue([{ id: 'v1' }]);
    db.product.count.mockResolvedValue(0);
    db.productVariant.count.mockResolvedValue(4);
    const r = await generateMissingBarcodes('s1');
    expect(r).toEqual({ products: 2, variants: 1, remaining: 4 });
    expect(db.product.update).toHaveBeenCalledTimes(2);
    expect(db.productVariant.update).toHaveBeenCalledTimes(1);
    const written = [
      ...db.product.update.mock.calls.map(c => c[0].data.barcode),
      ...db.productVariant.update.mock.calls.map(c => c[0].data.barcode),
    ];
    expect(new Set(written).size).toBe(3);
    // only products WITHOUT variants get a product-level code
    expect(db.product.findMany.mock.calls[0][0].where).toMatchObject({
      variants: { none: {} },
      barcode: null,
    });
  });
  it('is a no-op when nothing is missing and caps the batch at 500', async () => {
    db.product.findMany.mockResolvedValue([]);
    db.productVariant.findMany.mockResolvedValue([]);
    expect(await generateMissingBarcodes('s1', 99999)).toEqual({
      products: 0,
      variants: 0,
      remaining: 0,
    });
    expect(db.product.findMany.mock.calls[0][0].take).toBe(500);
  });
});
