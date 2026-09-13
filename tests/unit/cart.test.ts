/**
 * Cart Service Unit Tests
 * Tests cart operations and business logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CartService } from '@api/services/cart.service';
import { prisma } from '@force/database';

// Mock Prisma
vi.mock('@force/database', () => ({
  prisma: {
    cart: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
    },
    cartItem: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    // CartService.clear() also clears CartBundle rows (Task 5, product
    // bundles) — bundles live in their own table, never expanded into
    // cart_items, so clearing the cart must clear both.
    cartBundle: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    product: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn().mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') {
        // Pass the mocked prisma itself as the transaction client
        const { prisma: mockPrisma } = await import('@force/database');
        return fn(mockPrisma);
      }
      return fn;
    }),
  },
  Prisma: {
    TransactionIsolationLevel: {
      Serializable: 'Serializable',
      ReadCommitted: 'ReadCommitted',
    },
  },
  // CartService.addItem branches on this: inside a tenant transaction it
  // reuses the ambient client instead of opening a nested $transaction (which
  // could not see the cart the same request just wrote). These unit tests
  // exercise the standalone path, so report "no tenant context".
  hasTenantContext: () => false,
  // CartService now imports STOREFRONT_PRODUCT_SELECT from product.service,
  // which evaluates `const SOLD_ORDER_STATUSES: OrderStatus[]` at MODULE load.
  // Without OrderStatus on this mock the whole suite fails to import — the
  // tests themselves never run. Mirrors enum OrderStatus in schema.prisma.
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

// CartService now resolves the inventory.backorder feature flag before
// each inventory check. Default to enabled so existing tests pass unmodified.
vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    getStoreFeatures: vi.fn(),
    invalidateCache: vi.fn(),
  },
}));

describe('CartService', () => {
  const mockStoreId = 'store-123';
  const mockSessionId = 'session-456';
  const mockCustomerId = 'customer-789';

  const mockProduct = {
    id: 'prod-123',
    storeId: mockStoreId,
    name: 'Test Product',
    price: 5000,
    inventory: 50,
    trackInventory: true,
    status: 'active',
    images: [{ url: 'https://example.com/image.jpg' }],
  };

  const mockCart = {
    id: 'cart-123',
    storeId: mockStoreId,
    sessionId: mockSessionId,
    customerId: null,
    items: [],
  };

  const mockCartWithItems = {
    ...mockCart,
    items: [
      {
        id: 'item-1',
        cartId: 'cart-123',
        productId: 'prod-123',
        quantity: 2,
        product: mockProduct,
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOrCreate', () => {
    it('should return existing cart if found', async () => {
      vi.mocked(prisma.cart.findFirst).mockResolvedValue(mockCartWithItems as any);

      const result = await CartService.getOrCreate(mockStoreId, mockSessionId);

      expect(prisma.cart.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ storeId: mockStoreId }),
        })
      );
      expect(result.id).toBe('cart-123');
      expect(result.subtotal).toBe(10000); // 2 * 5000
    });

    it('should create new cart if not found', async () => {
      vi.mocked(prisma.cart.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.cart.create).mockResolvedValue(mockCart as any);

      const result = await CartService.getOrCreate(mockStoreId, mockSessionId);

      expect(prisma.cart.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storeId: mockStoreId,
            sessionId: mockSessionId,
          }),
        })
      );
      expect(result.subtotal).toBe(0);
    });

    it('should search by customerId when provided', async () => {
      vi.mocked(prisma.cart.findFirst).mockResolvedValue(mockCart as any);

      await CartService.getOrCreate(mockStoreId, mockSessionId, mockCustomerId);

      expect(prisma.cart.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              { sessionId: mockSessionId },
              { customerId: mockCustomerId },
            ]),
          }),
        })
      );
    });

    it('should calculate subtotal correctly with multiple items', async () => {
      const cartWithMultipleItems = {
        ...mockCart,
        items: [
          { id: 'item-1', productId: 'prod-1', quantity: 2, product: { price: 5000 } },
          { id: 'item-2', productId: 'prod-2', quantity: 3, product: { price: 3000 } },
        ],
      };
      vi.mocked(prisma.cart.findFirst).mockResolvedValue(cartWithMultipleItems as any);

      const result = await CartService.getOrCreate(mockStoreId, mockSessionId);

      // (2 * 5000) + (3 * 3000) = 10000 + 9000 = 19000
      expect(result.subtotal).toBe(19000);
    });
  });

  describe('addItem', () => {
    beforeEach(() => {
      vi.mocked(prisma.product.findFirst).mockResolvedValue(mockProduct as any);
      vi.mocked(prisma.cart.findFirst).mockResolvedValue(mockCart as any);
      vi.mocked(prisma.cart.create).mockResolvedValue(mockCart as any);
      vi.mocked(prisma.cartItem.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.cartItem.create).mockResolvedValue({} as any);
    });

    it('should add new item to cart', async () => {
      await CartService.addItem(mockStoreId, mockSessionId, 'prod-123', 2);

      expect(prisma.cartItem.create).toHaveBeenCalledWith({
        data: {
          cartId: mockCart.id,
          productId: 'prod-123',
          variantId: null,
          quantity: 2,
        },
      });
    });

    it('should throw error if product not found', async () => {
      vi.mocked(prisma.product.findFirst).mockResolvedValue(null);

      await expect(
        CartService.addItem(mockStoreId, mockSessionId, 'nonexistent', 1)
      ).rejects.toThrow('Product not found or unavailable');
    });

    it('should throw error if insufficient inventory', async () => {
      vi.mocked(prisma.product.findFirst).mockResolvedValue({
        ...mockProduct,
        inventory: 5,
      } as any);

      await expect(CartService.addItem(mockStoreId, mockSessionId, 'prod-123', 10)).rejects.toThrow(
        'Not enough inventory'
      );
    });

    it('should update quantity if item already exists', async () => {
      const existingItem = {
        id: 'item-existing',
        cartId: mockCart.id,
        productId: 'prod-123',
        quantity: 2,
      };
      vi.mocked(prisma.cartItem.findFirst).mockResolvedValue(existingItem as any);
      vi.mocked(prisma.cartItem.update).mockResolvedValue({} as any);

      await CartService.addItem(mockStoreId, mockSessionId, 'prod-123', 3);

      // The DELTA, not the absolute 5. An absolute quantity computed from the
      // findFirst above is a lost update: two concurrent adds of 3 both read
      // 2, both write 5, and one add silently vanishes from the cart behind a
      // 201. `increment` is evaluated by Postgres against the row as it stands
      // when the UPDATE takes its lock, so both land (2 + 3 + 3 = 8).
      expect(prisma.cartItem.update).toHaveBeenCalledWith({
        where: { id: 'item-existing' },
        data: { quantity: { increment: 3 } },
      });
    });

    it('should check combined quantity against inventory', async () => {
      const existingItem = {
        id: 'item-existing',
        cartId: mockCart.id,
        productId: 'prod-123',
        quantity: 45,
      };
      vi.mocked(prisma.cartItem.findFirst).mockResolvedValue(existingItem as any);

      // Product has 50 inventory, already have 45, trying to add 10 more
      await expect(CartService.addItem(mockStoreId, mockSessionId, 'prod-123', 10)).rejects.toThrow(
        'Not enough inventory'
      );
    });

    it('should skip inventory check if trackInventory is false', async () => {
      vi.mocked(prisma.product.findFirst).mockResolvedValue({
        ...mockProduct,
        trackInventory: false,
        inventory: 0,
      } as any);

      // Should not throw even with 0 inventory
      await expect(
        CartService.addItem(mockStoreId, mockSessionId, 'prod-123', 100)
      ).resolves.not.toThrow();
    });
  });

  describe('updateItem', () => {
    beforeEach(() => {
      vi.mocked(prisma.cart.findFirst).mockResolvedValue(mockCart as any);
      vi.mocked(prisma.cart.create).mockResolvedValue(mockCart as any);
    });

    it('should update item quantity', async () => {
      const existingItem = {
        id: 'item-123',
        cartId: mockCart.id,
        productId: 'prod-123',
        quantity: 2,
        product: mockProduct,
      };
      vi.mocked(prisma.cartItem.findFirst).mockResolvedValue(existingItem as any);
      vi.mocked(prisma.cartItem.update).mockResolvedValue({} as any);

      await CartService.updateItem(mockStoreId, mockSessionId, 'item-123', 5);

      expect(prisma.cartItem.update).toHaveBeenCalledWith({
        where: { id: 'item-123' },
        data: { quantity: 5 },
      });
    });

    it('should delete item if quantity is 0', async () => {
      const existingItem = {
        id: 'item-123',
        cartId: mockCart.id,
        productId: 'prod-123',
        quantity: 2,
        product: mockProduct,
      };
      vi.mocked(prisma.cartItem.findFirst).mockResolvedValue(existingItem as any);
      vi.mocked(prisma.cartItem.delete).mockResolvedValue({} as any);

      await CartService.updateItem(mockStoreId, mockSessionId, 'item-123', 0);

      expect(prisma.cartItem.delete).toHaveBeenCalledWith({
        where: { id: 'item-123' },
      });
    });

    it('should delete item if quantity is negative', async () => {
      const existingItem = {
        id: 'item-123',
        cartId: mockCart.id,
        productId: 'prod-123',
        quantity: 2,
        product: mockProduct,
      };
      vi.mocked(prisma.cartItem.findFirst).mockResolvedValue(existingItem as any);
      vi.mocked(prisma.cartItem.delete).mockResolvedValue({} as any);

      await CartService.updateItem(mockStoreId, mockSessionId, 'item-123', -1);

      expect(prisma.cartItem.delete).toHaveBeenCalled();
    });

    it('should throw error if item not found', async () => {
      vi.mocked(prisma.cartItem.findFirst).mockResolvedValue(null);

      await expect(
        CartService.updateItem(mockStoreId, mockSessionId, 'nonexistent', 5)
      ).rejects.toThrow('Cart item not found');
    });

    it('should throw error if update exceeds inventory', async () => {
      const existingItem = {
        id: 'item-123',
        cartId: mockCart.id,
        productId: 'prod-123',
        quantity: 2,
        product: { ...mockProduct, inventory: 10 },
      };
      vi.mocked(prisma.cartItem.findFirst).mockResolvedValue(existingItem as any);

      await expect(
        CartService.updateItem(mockStoreId, mockSessionId, 'item-123', 100)
      ).rejects.toThrow('Not enough inventory');
    });
  });

  describe('removeItem', () => {
    it('should remove item from cart', async () => {
      vi.mocked(prisma.cart.findFirst).mockResolvedValue(mockCart as any);
      vi.mocked(prisma.cartItem.findFirst).mockResolvedValue({
        id: 'item-123',
        cartId: mockCart.id,
      } as any);
      vi.mocked(prisma.cartItem.delete).mockResolvedValue({} as any);

      await CartService.removeItem(mockStoreId, mockSessionId, 'item-123');

      expect(prisma.cartItem.delete).toHaveBeenCalledWith({
        where: { id: 'item-123' },
      });
    });

    it('should throw error if item not found', async () => {
      vi.mocked(prisma.cart.findFirst).mockResolvedValue(mockCart as any);
      vi.mocked(prisma.cartItem.findFirst).mockResolvedValue(null);

      await expect(
        CartService.removeItem(mockStoreId, mockSessionId, 'nonexistent')
      ).rejects.toThrow('Cart item not found');
    });
  });

  describe('clear', () => {
    it('should remove all items from cart', async () => {
      vi.mocked(prisma.cart.findFirst).mockResolvedValue(mockCartWithItems as any);
      vi.mocked(prisma.cartItem.deleteMany).mockResolvedValue({ count: 2 } as any);

      await CartService.clear(mockStoreId, mockSessionId);

      expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({
        where: { cartId: mockCartWithItems.id },
      });
    });
  });

  describe('mergeGuestCart', () => {
    const mockGuestCart = {
      id: 'guest-cart',
      storeId: mockStoreId,
      sessionId: 'guest-session',
      customerId: null,
      items: [
        { id: 'guest-item-1', productId: 'prod-1', variantId: null, quantity: 2 },
        { id: 'guest-item-2', productId: 'prod-2', variantId: null, quantity: 1 },
      ],
    };

    const mockUserCart = {
      id: 'user-cart',
      storeId: mockStoreId,
      sessionId: 'user-session',
      customerId: mockCustomerId,
      items: [{ id: 'user-item-1', productId: 'prod-1', variantId: null, quantity: 3 }],
    };

    beforeEach(() => {
      vi.mocked(prisma.cartItem.create).mockResolvedValue({} as any);
      vi.mocked(prisma.cartItem.update).mockResolvedValue({} as any);
      vi.mocked(prisma.cart.delete).mockResolvedValue({} as any);
      vi.mocked(prisma.cart.findUnique).mockResolvedValue(mockUserCart as any);
    });

    it('should merge guest cart items into user cart', async () => {
      vi.mocked(prisma.cart.findFirst)
        .mockResolvedValueOnce(mockGuestCart as any)
        .mockResolvedValueOnce(mockUserCart as any);

      await CartService.mergeGuestCart(mockStoreId, 'guest-session', mockCustomerId);

      // prod-1 exists in both - should update
      // The guest line's DELTA, not the absolute 5 — see addItem's merge
      // assertion above for why an absolute quantity here is a lost update.
      expect(prisma.cartItem.update).toHaveBeenCalledWith({
        where: { id: 'user-item-1' },
        data: { quantity: { increment: 2 } },
      });

      // prod-2 only in guest - should create (with variantId so uniqueness is
      // correctly enforced at the DB level by the partial unique indexes)
      expect(prisma.cartItem.create).toHaveBeenCalledWith({
        data: {
          cartId: mockUserCart.id,
          productId: 'prod-2',
          variantId: null,
          quantity: 1,
        },
      });
    });

    it('should delete guest cart after merge', async () => {
      vi.mocked(prisma.cart.findFirst)
        .mockResolvedValueOnce(mockGuestCart as any)
        .mockResolvedValueOnce(mockUserCart as any);

      await CartService.mergeGuestCart(mockStoreId, 'guest-session', mockCustomerId);

      expect(prisma.cart.delete).toHaveBeenCalledWith({
        where: { id: mockGuestCart.id },
      });
    });

    it('should return user cart if guest cart is empty', async () => {
      vi.mocked(prisma.cart.findFirst)
        .mockResolvedValueOnce({ ...mockGuestCart, items: [] } as any)
        .mockResolvedValueOnce(mockUserCart as any);

      const result = await CartService.mergeGuestCart(mockStoreId, 'guest-session', mockCustomerId);

      expect(prisma.cartItem.create).not.toHaveBeenCalled();
      expect(prisma.cartItem.update).not.toHaveBeenCalled();
      expect(result).toEqual(mockUserCart);
    });

    // This test used to assert the opposite — that a SECOND cart was created
    // with `{ storeId, sessionId: 'guest-session', customerId }` — and it
    // passed, because the Prisma mock has no unique indexes. Against the real
    // schema that create is a guaranteed failure, not a race:
    // `carts_store_id_session_id_key` is a FULL unique index on
    // `(store_id, session_id)`, and the guest row with that exact pair is
    // still live at this point (it is not deleted until the end of the
    // function). Inside the ambient tenant transaction it aborts the whole
    // request. The old assertion was pinning a defect.
    it('promotes the guest cart in place instead of creating a second one', async () => {
      vi.mocked(prisma.cart.findFirst)
        .mockResolvedValueOnce(mockGuestCart as any)
        .mockResolvedValueOnce(null);

      await CartService.mergeGuestCart(mockStoreId, 'guest-session', mockCustomerId);

      expect(prisma.cart.update).toHaveBeenCalledWith({
        where: { id: mockGuestCart.id },
        data: { customerId: mockCustomerId },
      });
      expect(prisma.cart.create).not.toHaveBeenCalled();
    });

    it('does not delete the cart it just promoted', async () => {
      // The old path deleted the guest cart after merging into the new one.
      // On the promote branch that row IS the answer.
      vi.mocked(prisma.cart.findFirst)
        .mockResolvedValueOnce(mockGuestCart as any)
        .mockResolvedValueOnce(null);

      await CartService.mergeGuestCart(mockStoreId, 'guest-session', mockCustomerId);

      expect(prisma.cart.delete).not.toHaveBeenCalled();
    });
  });
});
