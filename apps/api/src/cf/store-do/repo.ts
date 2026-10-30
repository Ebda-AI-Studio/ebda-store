// Phase 0 demo operations of the StoreDO (INFRA-CF-1): list products, add to cart, order. They run on the REAL
// generated cf-schema tables (no thin spike copy any more) and the order goes through the real money core
// (`placeOrder`, packages/repo/src/do/checkout.ts), not a stand-in. Reachable only for a store whose server-side
// flag says 'do' (lib/store-backend.ts). Every statement is bound to `storeId` (no RLS inside a DO).
import { MoneyError, placeOrder, type SyncSql } from '@ebda-src/repo';

export class StoreError extends Error {
  constructor(
    public readonly code:
      | 'PRODUCT_NOT_FOUND'
      | 'CART_NOT_FOUND'
      | 'CART_EMPTY'
      | 'OUT_OF_STOCK'
      | 'VARIANT_REQUIRED',
    public readonly status: number
  ) {
    super(code);
  }
}

export interface SeedRows {
  store?: { id: string };
  products: Array<{
    id: string;
    storeId: string;
    name: string;
    nameAr?: string | null;
    slug: string;
    price: number;
    compareAtPrice?: number | null;
    inventory?: number;
    status?: string;
    hasVariants?: boolean;
    createdAt?: number;
    updatedAt?: number;
  }>;
  variants?: Array<{
    id: string;
    productId: string;
    sku?: string | null;
    price: number;
    inventory?: number;
    isActive?: boolean;
    createdAt?: number;
    updatedAt?: number;
  }>;
}

export function seed(db: SyncSql, rows: SeedRows): { products: number; variants: number } {
  return db.transactionSync(() => {
    for (const p of rows.products) {
      const now = Date.now();
      db.run(
        `INSERT OR REPLACE INTO products
           (id, store_id, name, name_ar, slug, price, compare_at_price, inventory, status, has_variants, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id,
          p.storeId,
          p.name,
          p.nameAr ?? null,
          p.slug,
          p.price,
          p.compareAtPrice ?? null,
          p.inventory ?? 0,
          p.status ?? 'active',
          p.hasVariants ? 1 : 0,
          p.createdAt ?? now,
          p.updatedAt ?? now,
        ]
      );
    }
    for (const v of rows.variants ?? []) {
      const now = Date.now();
      db.run(
        `INSERT OR REPLACE INTO product_variants (id, product_id, title, sku, price, inventory, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          v.id,
          v.productId,
          v.sku ?? v.id,
          v.sku ?? null,
          v.price,
          v.inventory ?? 0,
          v.isActive === false ? 0 : 1,
          v.createdAt ?? now,
          v.updatedAt ?? now,
        ]
      );
    }
    return { products: rows.products.length, variants: rows.variants?.length ?? 0 };
  });
}

export function listProducts(db: SyncSql, storeId: string, limit: number) {
  return db
    .all(
      `SELECT id, name, name_ar, slug, price, compare_at_price, inventory, status, has_variants, created_at
         FROM products WHERE store_id = ? AND status = 'active' AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT ?`,
      [storeId, limit]
    )
    .map(r => ({
      id: r.id,
      name: r.name,
      nameAr: r.name_ar,
      slug: r.slug,
      price: r.price,
      compareAtPrice: r.compare_at_price,
      inventory: r.inventory,
      status: r.status,
      hasVariants: r.has_variants === 1,
      createdAt: r.created_at,
    }));
}

export function addCartItem(
  db: SyncSql,
  storeId: string,
  sessionId: string,
  productId: string,
  qty: number,
  variantId?: string
): { cartId: string } {
  return db.transactionSync(() => {
    const product = db.all(
      `SELECT id, has_variants FROM products WHERE id = ? AND store_id = ? AND status = 'active' AND deleted_at IS NULL`,
      [productId, storeId]
    )[0];
    if (!product) throw new StoreError('PRODUCT_NOT_FOUND', 404);
    // Inventory model: a variant product is priced and stocked by its variant row, never the product row.
    if (product.has_variants === 1) {
      if (!variantId) throw new StoreError('VARIANT_REQUIRED', 400);
      const v = db.all(
        'SELECT id FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1',
        [variantId, productId]
      )[0];
      if (!v) throw new StoreError('PRODUCT_NOT_FOUND', 404);
    } else if (variantId) throw new StoreError('PRODUCT_NOT_FOUND', 404);
    let cart = db.all('SELECT id FROM carts WHERE store_id = ? AND session_id = ?', [
      storeId,
      sessionId,
    ])[0];
    if (!cart) {
      cart = { id: crypto.randomUUID() };
      db.run('INSERT INTO carts (id, store_id, session_id) VALUES (?, ?, ?)', [
        cart.id,
        storeId,
        sessionId,
      ]);
    }
    db.run(
      'INSERT INTO cart_items (id, cart_id, product_id, variant_id, quantity) VALUES (?, ?, ?, ?, ?)',
      [crypto.randomUUID(), cart.id as string, productId, variantId ?? null, qty]
    );
    return { cartId: cart.id as string };
  });
}

export function createOrder(db: SyncSql, storeId: string, sessionId: string) {
  const cart = db.all('SELECT id FROM carts WHERE store_id = ? AND session_id = ?', [
    storeId,
    sessionId,
  ])[0];
  if (!cart) throw new StoreError('CART_NOT_FOUND', 404);
  const items = db.all(
    'SELECT product_id, variant_id, SUM(quantity) AS quantity FROM cart_items WHERE cart_id = ? GROUP BY product_id, variant_id',
    [cart.id as string]
  );
  if (!items.length) throw new StoreError('CART_EMPTY', 409);
  try {
    const o = placeOrder(db, {
      storeId,
      cart: { id: cart.id as string },
      lines: items.map(i => ({
        productId: i.product_id as string,
        variantId: (i.variant_id as string | null) ?? undefined,
        quantity: i.quantity as number,
      })),
      paymentMethod: 'cod',
      shippingAddress: {},
    });
    return { orderId: o.orderId, orderNumber: o.orderNumber, total: o.total };
  } catch (e) {
    // The demo path keeps its own small error vocabulary; any other money error keeps its code and status.
    if (e instanceof MoneyError && e.code === 'OUT_OF_STOCK')
      throw new StoreError('OUT_OF_STOCK', 409);
    throw e;
  }
}
