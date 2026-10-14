/**
 * Issues 2009 / 2011: on the store-scoped cart mount the request runs inside
 * ONE ambient tenant transaction, so every by-id line write whose P2025 is
 * swallowed or re-mapped must be bracketed by a SAVEPOINT — otherwise, if the
 * failed statement reached Postgres, the `cart.update` that follows dies with
 * 25P02 and the race the recovery exists for still 500s.
 *
 * `tests/unit/cart.test.ts` stubs `hasTenantContext: () => false`, which makes
 * `withSavepoint` a pass-through; this file runs the REAL `withSavepoint`
 * with an ambient context reported, and records the statement order.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const log: string[] = [];

vi.mock('@ebda/database', () => {
  const rec = (name: string, impl?: (...a: any[]) => any) =>
    vi.fn(async (...a: any[]) => {
      log.push(name);
      return impl ? impl(...a) : {};
    });
  return {
    prisma: {
      cart: {
        findFirst: rec('cart.findFirst', () => ({ id: 'cart-1', storeId: 'store-1', items: [] })),
        update: rec('cart.update'),
        create: rec('cart.create'),
      },
      cartItem: {
        findFirst: rec('cartItem.findFirst', () => ({
          id: 'item-1',
          cartId: 'cart-1',
          quantity: 2,
          product: { inventory: 50, trackInventory: true, allowBackorder: false },
          variant: null,
        })),
        update: vi.fn(),
        delete: vi.fn(),
      },
      cartBundle: {
        findFirst: rec('cartBundle.findFirst', () => ({ id: 'bundle-1', cartId: 'cart-1' })),
        delete: vi.fn(),
      },
      $executeRawUnsafe: vi.fn(async (sql: string) => {
        log.push(sql.replace(/"ebda_sp_\d+"/, 'sp'));
        return 0;
      }),
    },
    Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
    hasTenantContext: () => true,
    OrderStatus: {
      pending: 'pending',
      confirmed: 'confirmed',
      processing: 'processing',
      shipped: 'shipped',
      delivered: 'delivered',
      cancelled: 'cancelled',
      refunded: 'refunded',
    },
  };
});

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(true) },
}));

import { prisma } from '@ebda/database';
import { CartService } from '@api/services/cart.service';

const lineGone = () => Object.assign(new Error('No record was found.'), { code: 'P2025' });
const gone = (name: string) =>
  vi.fn(async () => {
    log.push(name);
    throw lineGone();
  });

/** The recovery must be: SAVEPOINT → failing write → ROLLBACK TO → RELEASE → cart.update. */
const RECOVERED = (write: string) => [
  'SAVEPOINT sp',
  write,
  'ROLLBACK TO SAVEPOINT sp',
  'RELEASE SAVEPOINT sp',
  'cart.update',
];

function tail(from: string) {
  return log.slice(log.lastIndexOf('SAVEPOINT sp')).filter(s => s !== 'cart.findFirst');
}

describe('cart P2025 recoveries run inside a savepoint on the ambient-tx mount', () => {
  beforeEach(() => {
    log.length = 0;
  });

  it('removeItem', async () => {
    (prisma.cartItem as any).delete = gone('cartItem.delete');
    await CartService.removeItem('store-1', 'sess-1', 'item-1');
    expect(tail('cartItem.delete').slice(0, 5)).toEqual(RECOVERED('cartItem.delete'));
  });

  it('updateItem to 0', async () => {
    (prisma.cartItem as any).delete = gone('cartItem.delete');
    await CartService.updateItem('store-1', 'sess-1', 'item-1', 0);
    expect(tail('cartItem.delete').slice(0, 5)).toEqual(RECOVERED('cartItem.delete'));
  });

  it('removeBundle', async () => {
    (prisma.cartBundle as any).delete = gone('cartBundle.delete');
    await CartService.removeBundle('store-1', 'sess-1', 'bundle-1');
    expect(tail('cartBundle.delete').slice(0, 5)).toEqual(RECOVERED('cartBundle.delete'));
  });

  it('updateItem quantity>0 re-maps inside the savepoint and rolls back to it', async () => {
    (prisma.cartItem as any).update = gone('cartItem.update');
    await expect(CartService.updateItem('store-1', 'sess-1', 'item-1', 3)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(tail('cartItem.update').slice(0, 4)).toEqual(RECOVERED('cartItem.update').slice(0, 4));
  });
});
