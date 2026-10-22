/**
 * C-01 (P0, Qamar taste audit 2026-10-15): a product with variants is bought as
 * ONE of its variants, never as the bare parent.
 *
 * Recommendation, wishlist and related-product cards used to offer a one-tap
 * add on sized products. With no `variantId` the cart fell back to the parent's
 * `inventory` column, which the inventory model holds at 0 for a variant
 * product: an in-stock sized product failed as "not enough inventory", and with
 * backorder on it wrote a SIZELESS line that checkout then sold. The storefront
 * card is a hint; `CartService.addItem` is the gate, and this file is the
 * defence-mutation test for it (`cart-add-variant-required`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const isFeatureEnabled = vi.fn();

// Gold-rate pricing is proven in gold-*.test.ts and tests/integration/gold-checkout.test.ts; this suite
// is about something else, so the gate is stubbed to "no gold lines".
vi.mock('@api/services/gold-rate/gate', () => ({
  assertGoldLinesPriceable: async () => ({ snapshots: new Map(), rateIds: new Map() }),
  assertSameRates: async () => undefined,
  goldQuotesForLines: async () => new Map(),
  goldQuoteKey: (p: string, v: string | null) => `${p}|${v ?? ''}`,
}));
vi.mock('@api/services/gold-rate/public', () => ({
  publicGoldPricingForLines: async () => new Map(),
  publicGoldFields: async () => ({ goldPricing: null }),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    cart: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    cartItem: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    product: { findFirst: vi.fn(), findMany: vi.fn() },
    productVariant: { findFirst: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const { prisma } = await import('@ebda/database');
      return fn(prisma);
    }),
    $executeRawUnsafe: vi.fn(),
  },
  Prisma: {
    TransactionIsolationLevel: { Serializable: 'Serializable', ReadCommitted: 'ReadCommitted' },
  },
  hasTenantContext: () => false,
  OrderStatus: {
    pending: 'pending',
    confirmed: 'confirmed',
    processing: 'processing',
    shipped: 'shipped',
    delivered: 'delivered',
    cancelled: 'cancelled',
    refunded: 'refunded',
  },
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: (...a: unknown[]) => isFeatureEnabled(...a) },
}));

const { CartService, VARIANT_REQUIRED_MESSAGE } = await import('@api/services/cart.service');
const { prisma } = await import('@ebda/database');

const m = prisma as unknown as {
  cartItem: Record<string, ReturnType<typeof vi.fn>>;
  product: Record<string, ReturnType<typeof vi.fn>>;
  productVariant: Record<string, ReturnType<typeof vi.fn>>;
};

/** A sized product exactly as the inventory model stores it: parent column 0. */
const SIZED_PARENT = {
  id: 'prod-sized',
  trackInventory: true,
  inventory: 0,
  allowBackorder: true,
  personalisation: null,
  _count: { variants: 3 },
};

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureEnabled.mockResolvedValue(true); // backorder ON: the sizeless-line case
  vi.spyOn(CartService, 'getOrCreate').mockResolvedValue({ id: 'cart-1', items: [] } as never);
  m.cartItem.findFirst.mockResolvedValue(null);
  m.cartItem.findMany.mockResolvedValue([]);
  m.cartItem.create.mockResolvedValue({});
});

describe('CartService.addItem — VARIANT_REQUIRED', () => {
  it('refuses a variant product with no variantId: 400 VARIANT_REQUIRED, ar + en, no line', async () => {
    m.product.findFirst.mockResolvedValue(SIZED_PARENT);

    const err = await CartService.addItem('store-1', 'sess-1', 'prod-sized', 1).catch(e => e);

    expect(err).toMatchObject({ statusCode: 400, code: 'VARIANT_REQUIRED' });
    expect(err.details).toEqual({
      messageEn: VARIANT_REQUIRED_MESSAGE.en,
      messageAr: VARIANT_REQUIRED_MESSAGE.ar,
    });
    expect(VARIANT_REQUIRED_MESSAGE.ar).toMatch(/[؀-ۿ]/);
    expect(m.cartItem.create).not.toHaveBeenCalled();
    expect(m.cartItem.update).not.toHaveBeenCalled();
  });

  it('a product whose variants are ALL disabled is still a variant product', async () => {
    // _count counts every variant row; disabled ones included.
    m.product.findFirst.mockResolvedValue({ ...SIZED_PARENT, _count: { variants: 1 } });
    await expect(CartService.addItem('store-1', 'sess-1', 'prod-sized', 1)).rejects.toMatchObject({
      code: 'VARIANT_REQUIRED',
    });
    expect(m.cartItem.create).not.toHaveBeenCalled();
  });

  it('asks Prisma for the variant count on the product read', async () => {
    m.product.findFirst.mockResolvedValue(SIZED_PARENT);
    await CartService.addItem('store-1', 'sess-1', 'prod-sized', 1).catch(() => {});
    const call = m.product.findFirst.mock.calls[0][0];
    expect(call.include).toEqual({ _count: { select: { variants: true } } });
  });

  it('accepts the same product WITH a variant', async () => {
    m.product.findFirst.mockResolvedValue(SIZED_PARENT);
    m.productVariant.findFirst.mockResolvedValue({
      id: 'var-m',
      inventory: 4,
      allowBackorder: false,
    });
    await CartService.addItem('store-1', 'sess-1', 'prod-sized', 1, undefined, 'var-m');
    expect(m.cartItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ productId: 'prod-sized', variantId: 'var-m', quantity: 1 }),
    });
  });

  it('a plain SKU (no variants) still adds with no variantId', async () => {
    m.product.findFirst.mockResolvedValue({
      ...SIZED_PARENT,
      id: 'prod-plain',
      inventory: 5,
      _count: { variants: 0 },
    });
    await CartService.addItem('store-1', 'sess-1', 'prod-plain', 1);
    expect(m.cartItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ productId: 'prod-plain', variantId: null }),
    });
  });
});

describe('CartService.addItems (guest→login sync) — variant parent without a variant', () => {
  it('skips the sizeless line and keeps the rest of the cart (Ruling FU46-W1a-2)', async () => {
    m.product.findMany.mockResolvedValue([
      SIZED_PARENT,
      { ...SIZED_PARENT, id: 'prod-plain', inventory: 5, _count: { variants: 0 } },
    ]);
    m.productVariant.findMany.mockResolvedValue([]);

    await CartService.addItems('store-1', 'sess-1', [
      { productId: 'prod-sized', quantity: 1 },
      { productId: 'prod-plain', quantity: 2 },
    ]);

    expect(m.cartItem.create).toHaveBeenCalledTimes(1);
    expect(m.cartItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ productId: 'prod-plain', variantId: null, quantity: 2 }),
    });
  });
});

describe('CartService.addItems — a variant must belong to ITS line (W1a review #1)', () => {
  it('[{A, vB}, {B}] writes no (A, vB) line; a variant on its own product still syncs', async () => {
    m.product.findMany.mockResolvedValue([
      { ...SIZED_PARENT, id: 'prod-A', inventory: 5, _count: { variants: 0 } },
      { ...SIZED_PARENT, id: 'prod-B', _count: { variants: 2 } },
    ]);
    // The payload-wide lookup finds vB (it belongs to B, which is in the payload).
    m.productVariant.findMany.mockResolvedValue([
      { id: 'var-B', productId: 'prod-B', inventory: 9, allowBackorder: false },
    ]);

    await CartService.addItems('store-1', 'sess-1', [
      { productId: 'prod-A', variantId: 'var-B', quantity: 1 },
      { productId: 'prod-B', quantity: 1 },
      { productId: 'prod-B', variantId: 'var-B', quantity: 2 },
    ]);

    const written = m.cartItem.create.mock.calls.map(c => c[0].data);
    expect(written).toEqual([
      expect.objectContaining({ productId: 'prod-B', variantId: 'var-B', quantity: 2 }),
    ]);
    expect(written.some(d => d.productId === 'prod-A')).toBe(false);
    // the lookup must return productId for the compare to mean anything
    expect(m.productVariant.findMany.mock.calls[0][0].select).toMatchObject({ productId: true });
  });
});

describe('CartService.addItems — the skip log names WHY (W1a re-review minor 3)', () => {
  it('a disabled / unknown variant logs VARIANT_UNAVAILABLE; a foreign one VARIANT_PRODUCT_MISMATCH', async () => {
    const { default: logger } = await import('@api/lib/logger');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    m.product.findMany.mockResolvedValue([
      { ...SIZED_PARENT, id: 'prod-A', _count: { variants: 2 } },
      { ...SIZED_PARENT, id: 'prod-B', _count: { variants: 2 } },
    ]);
    // The lookup is `isActive: true`: the disabled var-A-off never comes back.
    m.productVariant.findMany.mockResolvedValue([
      { id: 'var-B', productId: 'prod-B', inventory: 9, allowBackorder: false },
    ]);

    await CartService.addItems('store-1', 'sess-1', [
      { productId: 'prod-A', variantId: 'var-A-off', quantity: 1 },
      { productId: 'prod-A', variantId: 'var-B', quantity: 1 },
    ]);

    const codes = warn.mock.calls.map(c => (c[0] as { code?: string }).code);
    expect(codes).toEqual(['VARIANT_UNAVAILABLE', 'VARIANT_PRODUCT_MISMATCH']);
    expect(m.cartItem.create).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
