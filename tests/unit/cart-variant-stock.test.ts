/**
 * Regression: CartService.updateItem checked the PARENT product's inventory
 * for a variant cart line. On a variant product the parent column is not
 * stock (and had drifted negative in production — 92 active pecannbee
 * products), so every quantity change threw INSUFFICIENT_INVENTORY no matter
 * how much variant stock existed. `addItem` and `validate` had always
 * resolved `variant ? variant.inventory : product.inventory`; only
 * `updateItem` was missed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CartService } from '@api/services/cart.service';
import { prisma } from '@force/database';

vi.mock('@force/database', () => ({
  prisma: {
    cart: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    cartItem: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    product: { findFirst: vi.fn(), update: vi.fn() },
    productVariant: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
  // updateItem's line write runs inside withSavepoint (issues 2009/2011),
  // which asks this; standalone path here, so it is a pass-through.
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
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(false) },
}));

const CART = { id: 'cart-1', items: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(CartService, 'getOrCreate').mockResolvedValue(CART as never);
  (prisma.cart.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (prisma.cartItem.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

describe('CartService.updateItem — variant lines', () => {
  it('uses the VARIANT stock, not the drifted parent column', async () => {
    // Exact production shape: parent -16, variant holds 1173.
    (prisma.cartItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'prod-1',
      variantId: 'var-1',
      product: { trackInventory: true, inventory: -16, allowBackorder: false },
      variant: { id: 'var-1', inventory: 1173, allowBackorder: false },
    });

    await expect(CartService.updateItem('store-1', 'sess-1', 'item-1', 3)).resolves.toBeDefined();
    expect(prisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { quantity: 3 },
    });
  });

  it('still rejects when the VARIANT itself is short', async () => {
    (prisma.cartItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'prod-1',
      variantId: 'var-1',
      product: { trackInventory: true, inventory: 500, allowBackorder: false },
      variant: { id: 'var-1', inventory: 2, allowBackorder: false },
    });

    await expect(CartService.updateItem('store-1', 'sess-1', 'item-1', 3)).rejects.toThrow(
      /Not enough inventory/
    );
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('leaves non-variant lines on the product column (unchanged behaviour)', async () => {
    (prisma.cartItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'prod-1',
      variantId: null,
      product: { trackInventory: true, inventory: 2, allowBackorder: false },
      variant: null,
    });

    await expect(CartService.updateItem('store-1', 'sess-1', 'item-1', 3)).rejects.toThrow(
      /Not enough inventory/
    );
  });

  it('loads the variant alongside the product — omitting it is the bug', async () => {
    (prisma.cartItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'prod-1',
      variantId: 'var-1',
      product: { trackInventory: true, inventory: -16, allowBackorder: false },
      variant: { id: 'var-1', inventory: 1173, allowBackorder: false },
    });

    await CartService.updateItem('store-1', 'sess-1', 'item-1', 3);

    const call = (prisma.cartItem.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.include).toHaveProperty('variant');
  });
});
