/**
 * Barcode Lookup — Unit Tests
 *
 * Tests the lookupBarcode logic at the pure-function level using mocks.
 * Real DB integration is covered in tests/integration/barcode-scan.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock @ebda/database prisma ────────────────────────────────────────────

const mockFindFirstProduct = vi.fn();
const mockFindFirstVariant = vi.fn();

vi.mock('@ebda/database', () => ({
  prisma: {
    product: { findFirst: (...args: unknown[]) => mockFindFirstProduct(...args) },
    productVariant: { findFirst: (...args: unknown[]) => mockFindFirstVariant(...args) },
  },
  runInTenantContext: vi.fn((_, fn) => fn()),
  Prisma: {},
}));

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../apps/api/src/services/inventory.service', () => ({
  InventoryService: { adjustInventory: vi.fn() },
}));

vi.mock('../../apps/api/src/services/accounting/stock-adjustment.service', () => ({
  createAdjustment: vi.fn(),
  postAdjustment: vi.fn(),
}));

vi.mock('../../apps/api/src/middleware/error-handler', () => ({
  AppError: class AppError extends Error {
    statusCode: number;
    code: string;
    constructor(statusCode: number, code: string, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  },
}));

import { lookupBarcode } from '../../apps/api/src/services/barcode-scan.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STORE_ID = 'store-uuid-1';

const productRow = {
  id: 'prod-1',
  name: 'Widget A',
  nameAr: 'ويدجيت أ',
  barcode: '123456789012',
  sku: 'WID-A',
  inventory: 42,
};

const variantRow = {
  id: 'var-1',
  barcode: '123456789012',
  sku: 'WID-A-L',
  inventory: 10,
  title: 'Large',
  titleAr: 'كبير',
  productId: 'prod-1',
  product: { name: 'Widget A', nameAr: 'ويدجيت أ' },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('lookupBarcode', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null when barcode is not found in products or variants', async () => {
    mockFindFirstProduct.mockResolvedValue(null);
    mockFindFirstVariant.mockResolvedValue(null);

    const result = await lookupBarcode(STORE_ID, 'NOPE-123');
    expect(result).toBeNull();
  });

  it('returns a product-level result when only product matches', async () => {
    mockFindFirstProduct.mockResolvedValue(productRow);
    mockFindFirstVariant.mockResolvedValue(null);

    const result = await lookupBarcode(STORE_ID, '123456789012');

    expect(result).not.toBeNull();
    expect(result!.type).toBe('product');
    expect(result!.productId).toBe('prod-1');
    expect(result!.productName).toBe('Widget A');
    expect(result!.inventory).toBe(42);
    expect(result!.ambiguous).toBe(false);
    expect(result!.variantId).toBeUndefined();
  });

  it('returns a variant-level result when only variant matches', async () => {
    mockFindFirstProduct.mockResolvedValue(null);
    mockFindFirstVariant.mockResolvedValue(variantRow);

    const result = await lookupBarcode(STORE_ID, '123456789012');

    expect(result).not.toBeNull();
    expect(result!.type).toBe('variant');
    expect(result!.productId).toBe('prod-1');
    expect(result!.variantId).toBe('var-1');
    expect(result!.variantTitle).toBe('Large');
    expect(result!.inventory).toBe(10);
    expect(result!.ambiguous).toBe(false);
  });

  it('returns ambiguous=true and prefers variant when both match the same barcode', async () => {
    mockFindFirstProduct.mockResolvedValue(productRow);
    mockFindFirstVariant.mockResolvedValue(variantRow);

    const result = await lookupBarcode(STORE_ID, '123456789012');

    expect(result).not.toBeNull();
    // Variant is preferred when both match
    expect(result!.type).toBe('variant');
    expect(result!.variantId).toBe('var-1');
    expect(result!.ambiguous).toBe(true);
  });

  it('passes storeId to product query and applies store scope to variant query', async () => {
    mockFindFirstProduct.mockResolvedValue(null);
    mockFindFirstVariant.mockResolvedValue(null);

    await lookupBarcode(STORE_ID, 'TEST-BC');

    // Product lookup is scoped to storeId
    expect(mockFindFirstProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ storeId: STORE_ID }),
      })
    );

    // Variant lookup uses nested product.storeId scope
    expect(mockFindFirstVariant).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          product: expect.objectContaining({ storeId: STORE_ID }),
        }),
      })
    );
  });
});
