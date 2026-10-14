/**
 * #1764: `tests/unit/soft-delete-and-csrf-failopen.test.ts` pins the
 * soft-delete-exclusion `where` clauses by grepping source text
 * (`readFileSync` + `indexOf`/regex) — none of those assertions execute the
 * actual middleware/service code. A behaviour-preserving refactor (e.g.
 * hoisting the `where` object into a variable, reordering its keys) reddens
 * them, while a real regression that happens to keep the matched substrings
 * intact — say, a typo'd `deletedAt: undefined` that Prisma silently ignores
 * as "no filter" — would stay green.
 *
 * This drives the REAL defect scenario end to end against a real Postgres:
 * a shopper adds a live product to their cart, the merchant soft-deletes it
 * (the "delete product" admin button — `deletedAt` set, `status` untouched,
 * per `product.service.ts`), and the shopper then tries to (a) add it to a
 * FRESH cart and (b) check out the cart that already held it before the
 * delete. Both must be refused, not silently accepted.
 *
 * Real Postgres throughout — same convention as
 * `tests/integration/cart-nested-transaction.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { prisma, withRlsBypass } from '@ebda/database';
import { AppError } from '@api/middleware/error-handler';
import { CartService } from '@api/services/cart.service';
import { OrderService } from '@api/services/order.service';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  cartSessionId,
  addItemToCart,
  DEFAULT_TEST_SHIPPING_ADDRESS,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

/** Mirrors exactly what ProductService.delete does: sets `deletedAt`, leaves `status` at 'active' — the premise `tests/unit/soft-delete-and-csrf-failopen.test.ts` also pins via source text. */
async function softDeleteProduct(productId: string): Promise<void> {
  await withRlsBypass(tx =>
    tx.product.update({ where: { id: productId }, data: { deletedAt: new Date() } })
  );
}

describe.skipIf(!hasDb)('soft-deleted products are excluded end to end (#1764)', () => {
  it('a freshly soft-deleted product cannot be added to a NEW cart', async () => {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const store: FixtureStore = await seedBundleStore(suffix);
    const productId = await seedProduct(store.storeId, `${suffix}-fresh-add`, {
      inventory: 100,
      price: 1_000,
    });

    await softDeleteProduct(productId);

    const sessionId = cartSessionId('soft-deleted-fresh-add');
    await expect(CartService.addItem(store.storeId, sessionId, productId, 1)).rejects.toMatchObject(
      { statusCode: 404 }
    );

    // Belt-and-suspenders: the cart really did not gain the line.
    const cart = await CartService.getOrCreate(store.storeId, sessionId);
    expect(cart.items.some(i => i.productId === productId)).toBe(false);
  });

  it(
    'a product soft-deleted AFTER cart-load is refused at checkout, before any money or ' +
      'stock moves — the "vanished between cart load and order creation" scenario',
    async () => {
      const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      const store: FixtureStore = await seedBundleStore(suffix);
      const productId = await seedProduct(store.storeId, `${suffix}-vanishes`, {
        inventory: 50,
        price: 2_000,
      });

      const sessionId = cartSessionId('soft-deleted-checkout');
      // Product is still live at cart-load time — this must succeed.
      await addItemToCart(store.storeId, sessionId, productId, 1);

      // Merchant deletes it from another tab while the shopper is on the
      // checkout page.
      await softDeleteProduct(productId);

      const before = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
        select: { inventory: true },
      });

      let thrown: AppError | undefined;
      try {
        await OrderService.create(store.storeId, undefined, sessionId, {
          shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
          paymentMethod: 'paymob',
        });
      } catch (err) {
        thrown = err as AppError;
      }

      expect(
        thrown,
        'OrderService.create must refuse, not silently order a deleted product'
      ).toBeInstanceOf(AppError);
      expect(thrown?.statusCode).toBe(409);
      expect(thrown?.code).toBe('PRODUCT_NO_LONGER_AVAILABLE');
      // Ids travel in `details`, never interpolated into the (untranslated,
      // user-facing) message — same assertion the source-text test made,
      // now proven against the real thrown error instead of a regex.
      expect(thrown?.details).toMatchObject({ productIds: [productId] });
      expect(thrown?.message).not.toContain(productId);

      // No stock or order was created for the refused checkout.
      const after = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
        select: { inventory: true },
      });
      expect(after.inventory).toBe(before.inventory);
      const orderCount = await prisma.order.count({ where: { storeId: store.storeId } });
      expect(orderCount).toBe(0);
    }
  );
});
