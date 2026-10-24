// Drizzle on Durable Object SQLite: the SYNCHRONOUS driver (drizzle-orm/durable-sqlite).
// No engine, no wasm, no per-request client construction: `drizzle(ctx.storage)` is a thin wrapper
// created once in the DO constructor. Transactions are `ctx.storage.transactionSync` (session.ts:70).
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { and, desc, eq, sql } from 'drizzle-orm';
import * as schema from '../src/schema';

export type Db = ReturnType<typeof makeDrizzle>;
export const makeDrizzle = (storage: DurableObjectStorage) => drizzle(storage, { schema });

export function listProducts(db: Db, storeId: string, limit: number) {
  return db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.storeId, storeId), eq(schema.products.status, 'active')))
    .orderBy(desc(schema.products.createdAt))
    .limit(limit)
    .all();
}

export function addCartItem(
  db: Db,
  storeId: string,
  sessionId: string,
  productId: string,
  qty: number
) {
  return db.transaction(tx => {
    const now = Date.now();
    const product = tx
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.id, productId), eq(schema.products.storeId, storeId)))
      .get();
    if (!product || product.status !== 'active') throw new Error('PRODUCT_NOT_FOUND');
    let cart = tx
      .select()
      .from(schema.carts)
      .where(and(eq(schema.carts.storeId, storeId), eq(schema.carts.sessionId, sessionId)))
      .get();
    if (!cart) {
      cart = {
        id: crypto.randomUUID(),
        storeId,
        sessionId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(schema.carts).values(cart).run();
    }
    tx.insert(schema.cartItems)
      .values({
        id: crypto.randomUUID(),
        cartId: cart.id,
        storeId,
        productId,
        quantity: qty,
        unitPrice: product.price,
        createdAt: now,
      })
      .run();
    return { cartId: cart.id };
  });
}

export function createOrder(db: Db, storeId: string, sessionId: string) {
  return db.transaction(tx => {
    const now = Date.now();
    const cart = tx
      .select()
      .from(schema.carts)
      .where(and(eq(schema.carts.storeId, storeId), eq(schema.carts.sessionId, sessionId)))
      .get();
    if (!cart) throw new Error('CART_NOT_FOUND');
    const items = tx
      .select()
      .from(schema.cartItems)
      .where(eq(schema.cartItems.cartId, cart.id))
      .all();
    if (!items.length) throw new Error('CART_EMPTY');
    let subtotal = 0;
    for (const it of items) {
      const res = tx
        .update(schema.products)
        .set({ inventory: sql`${schema.products.inventory} - ${it.quantity}`, updatedAt: now })
        .where(
          and(
            eq(schema.products.id, it.productId),
            sql`${schema.products.inventory} >= ${it.quantity}`
          )
        )
        .returning({ id: schema.products.id })
        .all();
      if (res.length === 0) throw new Error('OUT_OF_STOCK');
      subtotal += it.unitPrice * it.quantity;
    }
    const last = tx
      .select({ n: sql<number>`coalesce(max(${schema.orders.orderNumber}), 1000)` })
      .from(schema.orders)
      .where(eq(schema.orders.storeId, storeId))
      .get();
    const order = {
      id: crypto.randomUUID(),
      storeId,
      orderNumber: (last?.n ?? 1000) + 1,
      cartId: cart.id,
      status: 'pending' as const,
      paymentMethod: 'cod' as const,
      subtotal,
      total: subtotal,
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(schema.orders).values(order).run();
    tx.insert(schema.orderItems)
      .values(
        items.map(it => ({
          id: crypto.randomUUID(),
          orderId: order.id,
          storeId,
          productId: it.productId,
          variantId: it.variantId,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
        }))
      )
      .run();
    tx.update(schema.carts)
      .set({ status: 'converted', updatedAt: now })
      .where(eq(schema.carts.id, cart.id))
      .run();
    return { orderId: order.id, orderNumber: order.orderNumber, total: subtotal };
  });
}
