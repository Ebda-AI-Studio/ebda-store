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

vi.mock('@ebda/database', () => ({
  prisma: {
    cart: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    // `findMany` for the bulk path (`addItems` re-reads existing lines inside
    // the write body); `findFirst` for the single-item path.
    cartItem: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    product: { findFirst: vi.fn(), findMany: vi.fn() },
    productVariant: { findFirst: vi.fn(), findMany: vi.fn() },
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
const { prisma } = await import('@ebda/database');

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
    _count: { variants: 0 },
  });
  (prisma.cartItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: 'prod-1',
      trackInventory: true,
      inventory: 50,
      allowBackorder: false,
      _count: { variants: 0 },
    },
  ]);
  (prisma.productVariant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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
      _count: { variants: 0 },
    });

    await expect(CartService.addItem('store-1', 'sess-1', 'prod-1', 5)).rejects.toThrow(
      /Not enough inventory/
    );
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });
});

/**
 * `addItems` is the BULK path — `POST /stores/:storeId/cart/sync` — and it is
 * mounted under `tenantContext` exactly like `/cart/items`.
 *
 * It kept the nested-`$transaction` defect through three separate audit
 * reports while `addItem` and `addBundle` were both fixed for it. The reason
 * it never showed up in production: the first-party storefront calls the
 * sibling `/public/cart/sync`, which is mounted OUTSIDE `tenantContext`, so
 * `hasTenantContext()` is false there and the own-transaction branch is
 * correct. Only a store-scoped caller — POS, admin, an agent surface — reaches
 * the trap, and then the FIRST sync of a session 500s with P2003.
 *
 * These assertions are the unit-tier gate; the real-Postgres proof that this
 * is a P2003 and not a theory lives in
 * `tests/integration/cart-nested-transaction.test.ts`.
 */
describe('CartService.addItems — transaction scoping', () => {
  const ITEMS = [{ productId: 'prod-1', quantity: 1 }];

  it('inside a tenant transaction it does NOT open a nested $transaction', async () => {
    hasTenantContextMock.mockReturnValue(true);

    await CartService.addItems('store-1', 'sess-1', ITEMS);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.cartItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cartId: 'cart-1' }) })
    );
  });

  it('brackets the ambient-tx write in a SAVEPOINT so a lost unique race can recover', async () => {
    hasTenantContextMock.mockReturnValue(true);

    await CartService.addItems('store-1', 'sess-1', ITEMS);

    // Load-bearing for a reason `addItem`'s savepoint is not: this body writes
    // a LOOP of lines. A P2002 on the fifth item cannot be undone by rolling
    // back a transaction the service does not own, so without the savepoint a
    // retry would re-apply `{ increment }` to the four that already succeeded.
    const statements = (prisma.$executeRawUnsafe as ReturnType<typeof vi.fn>).mock.calls.map(
      c => c[0] as string
    );
    expect(statements.some(s => s.startsWith('SAVEPOINT '))).toBe(true);
    expect(statements.some(s => s.startsWith('RELEASE SAVEPOINT '))).toBe(true);
  });

  it('outside a tenant context it still uses its own transaction', async () => {
    // The negative control. The public storefront route depends on this branch
    // staying exactly as it was.
    hasTenantContextMock.mockReturnValue(false);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: never) =>
      (fn as unknown as (tx: unknown) => Promise<unknown>)(prisma)
    );

    await CartService.addItems('store-1', 'sess-1', ITEMS);

    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('still enforces inventory on the ambient path', async () => {
    hasTenantContextMock.mockReturnValue(true);
    (prisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'prod-1',
        trackInventory: true,
        inventory: 1,
        allowBackorder: false,
        _count: { variants: 0 },
      },
    ]);

    await expect(
      CartService.addItems('store-1', 'sess-1', [{ productId: 'prod-1', quantity: 5 }])
    ).rejects.toThrow(/Not enough inventory/);
  });
});
