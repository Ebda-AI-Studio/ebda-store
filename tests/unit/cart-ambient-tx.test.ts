/**
 * Regression: the first add-to-cart of a session returned 500.
 *
 * `tenantContext` wraps the WHOLE request in one interactive transaction and
 * every proxied Prisma call runs inside it; that transaction only commits when
 * the response finishes. `CartService.addItem` then opened its OWN
 * `prisma.$transaction` — and `$transaction` is deliberately not proxied to the
 * tenant client (`isProxiedProp` rejects anything starting with `$`), so it ran
 * on a different connection that could not see the cart `getOrCreate` had just
 * written. The FK on `cart_items.cart_id` pointed at an invisible row:
 *
 *   Foreign key constraint violated on the constraint: `cart_items_cart_id_fkey`
 *
 * A `GET /cart` first masked it, because that committed the cart in an earlier
 * request — which is why the storefront never tripped it and a direct
 * `POST /cart/items` always did.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const hasTenantContextMock = vi.fn();

vi.mock('@force/database', () => ({
  prisma: {
    cart: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    cartItem: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    product: { findFirst: vi.fn() },
    productVariant: { findFirst: vi.fn() },
    $transaction: vi.fn(),
    // The ambient-tx write path brackets its create in a Postgres SAVEPOINT
    // (see apps/api/src/lib/savepoint.ts) — without this the mock throws
    // "$executeRawUnsafe is not a function" and every assertion below fails
    // for the wrong reason.
    $executeRawUnsafe: vi.fn(),
  },
  Prisma: {
    TransactionIsolationLevel: { Serializable: 'Serializable', ReadCommitted: 'ReadCommitted' },
  },
  hasTenantContext: () => hasTenantContextMock(),
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

const { CartService } = await import('@api/services/cart.service');
const { prisma } = await import('@force/database');

const CART = { id: 'cart-1', items: [], subtotal: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(CartService, 'getOrCreate').mockResolvedValue(CART as never);
  (prisma.cart.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (prisma.cartItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.cartItem.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (prisma.product.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: 'prod-1',
    trackInventory: true,
    inventory: 50,
    allowBackorder: false,
  });
});

describe('CartService.addItem — transaction scoping', () => {
  it('inside a tenant transaction it does NOT open a nested $transaction', async () => {
    hasTenantContextMock.mockReturnValue(true);

    await CartService.addItem('store-1', 'sess-1', 'prod-1', 1);

    // The bug: a nested transaction cannot see the cart written by the outer
    // (uncommitted) tenant transaction, so the cart-item FK fails.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.cartItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cartId: 'cart-1' }) })
    );
  });

  it('brackets the ambient-tx write in a SAVEPOINT so a lost unique race can recover', async () => {
    hasTenantContextMock.mockReturnValue(true);

    await CartService.addItem('store-1', 'sess-1', 'prod-1', 1);

    // Without the savepoint, a P2002 from the create below would abort the
    // whole request transaction and every later statement — including the
    // retry's own findFirst — would fail with 25P02 instead of recovering.
    const statements = (prisma.$executeRawUnsafe as ReturnType<typeof vi.fn>).mock.calls.map(
      c => c[0] as string
    );
    expect(statements.some(s => s.startsWith('SAVEPOINT '))).toBe(true);
    expect(statements.some(s => s.startsWith('RELEASE SAVEPOINT '))).toBe(true);
  });

  it('outside a tenant context it still uses its own transaction', async () => {
    hasTenantContextMock.mockReturnValue(false);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: never) =>
      (fn as unknown as (tx: unknown) => Promise<unknown>)(prisma)
    );

    await CartService.addItem('store-1', 'sess-1', 'prod-1', 1);

    // Crons/scripts/tests run with no ambient transaction — behaviour unchanged.
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('still enforces inventory on the ambient path', async () => {
    hasTenantContextMock.mockReturnValue(true);
    (prisma.product.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'prod-1',
      trackInventory: true,
      inventory: 1,
      allowBackorder: false,
    });

    await expect(CartService.addItem('store-1', 'sess-1', 'prod-1', 5)).rejects.toThrow(
      /Not enough inventory/
    );
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });
});
