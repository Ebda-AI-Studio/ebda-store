import { MoneyError, type SyncSql } from './sync-sql';
import { decrementProduct, decrementVariant, forceDecrementVariant, recordMovement } from './stock';

export interface CheckoutLine {
  productId: string;
  variantId?: string;
  quantity: number;
}
export interface CheckoutInput {
  storeId: string;
  lines: CheckoutLine[];
  customerId?: string;
  couponCode?: string;
  /** piastres the shopper wants to pay from their wallet (capped to the order total and the balance). */
  walletAmount?: number;
  /** piastres, resolved by the caller from the shipping zone/rate engine (a later slice ports that engine). */
  shipping?: number;
  /** piastres, resolved by the tax engine (a later slice). */
  tax?: number;
  currency?: string;
  idempotencyKey?: string;
  shippingAddress: unknown;
  billingAddress?: unknown;
  checkoutIp?: string;
  now?: number;
}
export interface PlacedOrder {
  orderId: string;
  orderNumber: string;
  subtotal: number;
  couponDiscount: number;
  shipping: number;
  tax: number;
  walletAmount: number;
  total: number;
  paymentStatus: 'unpaid' | 'paid';
  replayed: boolean;
}

const orderNumber = (now: number) =>
  `ORD-${Math.floor(now / 1000)
    .toString(36)
    .toUpperCase()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`;
const int = (v: unknown, name: string): number => {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 2_000_000_000)
    throw new MoneyError('BAD_AMOUNT', `${name} must be a non-negative integer (piastres)`, 400);
  return v;
};

/**
 * Place an order: ONE `transactionSync`. Prices come from the rows (never the client); stock, coupon usage and the
 * wallet debit are conditional single statements, so under any number of parallel checkouts on one SKU exactly
 * `stock` of them succeed and nothing goes negative. A failure anywhere rolls the whole order back, stock included.
 * Not yet ported (later slices, same transaction): promotions, bundles, gold-rate gate, loyalty, tier/group prices.
 */
export function placeOrder(db: SyncSql, input: CheckoutInput): PlacedOrder {
  const now = input.now ?? Date.now();
  if (!input.storeId) throw new MoneyError('NO_STORE', 'storeId is required', 400);
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100)
    throw new MoneyError('BAD_LINES', 'an order needs 1 to 100 lines', 400);
  const shipping = int(input.shipping, 'shipping');
  const tax = int(input.tax, 'tax');
  const wantWallet = int(input.walletAmount, 'walletAmount');

  return db.transactionSync(() => {
    if (input.idempotencyKey) {
      const prev = db.all(
        'SELECT id, order_number, subtotal, coupon_discount, shipping, tax, wallet_amount, total, payment_status FROM orders WHERE idempotency_key = ? AND store_id = ?',
        [input.idempotencyKey, input.storeId]
      )[0];
      if (prev)
        return {
          orderId: prev.id as string,
          orderNumber: prev.order_number as string,
          subtotal: prev.subtotal as number,
          couponDiscount: (prev.coupon_discount as number) ?? 0,
          shipping: (prev.shipping as number) ?? 0,
          tax: (prev.tax as number) ?? 0,
          walletAmount: (prev.wallet_amount as number) ?? 0,
          total: prev.total as number,
          paymentStatus: prev.payment_status as 'unpaid' | 'paid',
          replayed: true,
        };
    }
    const orderId = crypto.randomUUID();
    const items: {
      productId: string;
      variantId: string | null;
      name: string;
      variantName: string | null;
      sku: string | null;
      qty: number;
      price: number;
    }[] = [];
    let subtotal = 0;

    for (const line of input.lines) {
      const qty = line.quantity;
      if (!Number.isInteger(qty) || qty < 1 || qty > 1000)
        throw new MoneyError('BAD_QUANTITY', 'quantity must be an integer from 1 to 1000', 400);
      const p = db.all(
        'SELECT id, name, price, sku, status, deleted_at, audience, track_inventory FROM products WHERE id = ? AND store_id = ?',
        [line.productId, input.storeId]
      )[0];
      if (!p || p.deleted_at !== null || p.status !== 'active' || p.audience !== 'public')
        throw new MoneyError('PRODUCT_UNAVAILABLE', 'a product in the cart is not available', 409, {
          productId: line.productId,
        });
      const hasVariants =
        (db.all('SELECT count(*) AS n FROM product_variants WHERE product_id = ?', [
          line.productId,
        ])[0].n as number) > 0;
      let price = p.price as number;
      let variantName: string | null = null;
      let sku = p.sku as string | null;
      let vid: string | null = null;
      if (hasVariants) {
        if (!line.variantId)
          throw new MoneyError('VARIANT_REQUIRED', 'choose a variant', 400, {
            productId: line.productId,
          });
        const v = db.all(
          'SELECT id, title, price, sku, is_active, allow_backorder FROM product_variants WHERE id = ? AND product_id = ?',
          [line.variantId, line.productId]
        )[0];
        if (!v || !v.is_active)
          throw new MoneyError('VARIANT_UNAVAILABLE', 'the variant is not available', 409, {
            variantId: line.variantId,
          });
        vid = v.id as string;
        price = v.price as number;
        variantName = v.title as string;
        sku = (v.sku as string | null) ?? sku;
        const r = decrementVariant(db, vid, qty);
        if (r.ok)
          recordMovement(db, {
            storeId: input.storeId,
            productId: line.productId,
            type: 'sale',
            quantity: qty,
            previousStock: r.previousStock,
            newStock: r.newStock,
            reference: orderId,
          });
        else if (v.allow_backorder) {
          const f = forceDecrementVariant(db, vid, qty);
          recordMovement(db, {
            storeId: input.storeId,
            productId: line.productId,
            type: 'sale',
            quantity: qty,
            previousStock: f.previousStock,
            newStock: f.newStock,
            reference: orderId,
            reason: 'backorder',
          });
        } else
          throw new MoneyError('OUT_OF_STOCK', 'not enough stock', 409, {
            productId: line.productId,
            variantId: vid,
            available: r.newStock,
          });
      } else {
        if (line.variantId)
          throw new MoneyError('VARIANT_UNAVAILABLE', 'this product has no variants', 409);
        if (p.track_inventory) {
          const r = decrementProduct(db, line.productId, qty);
          if (!r.ok)
            throw new MoneyError('OUT_OF_STOCK', 'not enough stock', 409, {
              productId: line.productId,
              available: r.newStock,
            });
          recordMovement(db, {
            storeId: input.storeId,
            productId: line.productId,
            type: 'sale',
            quantity: qty,
            previousStock: r.previousStock,
            newStock: r.newStock,
            reference: orderId,
          });
        }
      }
      subtotal += price * qty;
      items.push({
        productId: line.productId,
        variantId: vid,
        name: p.name as string,
        variantName,
        sku,
        qty,
        price,
      });
    }
    if (subtotal > 2_000_000_000)
      throw new MoneyError('TOTAL_TOO_LARGE', 'order total too large', 400);

    // coupon: validity checks, then ONE conditional statement claims a use (no oversubscription under any concurrency)
    let couponDiscount = 0;
    let couponCode: string | null = null;
    if (input.couponCode) {
      const c = db.all(
        'SELECT id, code, type, value, min_order_amount, max_discount, usage_limit, usage_limit_per_user, is_active, starts_at, expires_at FROM coupons WHERE store_id = ? AND code = ? COLLATE NOCASE',
        [input.storeId, input.couponCode]
      )[0];
      if (!c || !c.is_active) throw new MoneyError('COUPON_INVALID', 'coupon is not valid', 409);
      if (
        (c.starts_at !== null && (c.starts_at as number) > now) ||
        (c.expires_at !== null && (c.expires_at as number) <= now)
      )
        throw new MoneyError('COUPON_EXPIRED', 'coupon is outside its dates', 409);
      if (c.min_order_amount !== null && subtotal < (c.min_order_amount as number))
        throw new MoneyError('COUPON_MIN_ORDER', 'order is below the coupon minimum', 409);
      if (c.usage_limit_per_user !== null && input.customerId) {
        const used = db.all(
          'SELECT count(*) AS n FROM orders WHERE store_id = ? AND customer_id = ? AND coupon_code = ? AND deleted_at IS NULL',
          [input.storeId, input.customerId, c.code]
        )[0].n as number;
        if (used >= (c.usage_limit_per_user as number))
          throw new MoneyError(
            'COUPON_USER_LIMIT',
            'coupon already used the allowed number of times',
            409
          );
      }
      const claimed = db.run(
        'UPDATE coupons SET usage_count = usage_count + 1 WHERE id = ? AND (usage_limit IS NULL OR usage_count < usage_limit)',
        [c.id]
      ).changes;
      if (claimed !== 1) throw new MoneyError('COUPON_EXHAUSTED', 'coupon has no uses left', 409);
      if (c.type === 'percentage')
        couponDiscount = Math.floor((subtotal * (c.value as number)) / 100);
      else if (c.type === 'fixed') couponDiscount = c.value as number;
      if (c.max_discount !== null)
        couponDiscount = Math.min(couponDiscount, c.max_discount as number);
      couponDiscount = Math.max(0, Math.min(couponDiscount, subtotal));
      couponCode = c.code as string;
    }

    const total = subtotal - couponDiscount + shipping + tax;
    if (total < 0) throw new MoneyError('NEGATIVE_TOTAL', 'order total cannot be negative', 500);

    // wallet: one conditional debit, capped to the total; the balance can never go negative (CHECK + guard)
    let walletAmount = 0;
    let walletTx: { walletId: string; balanceAfter: number } | undefined;
    if (wantWallet > 0) {
      if (!input.customerId)
        throw new MoneyError(
          'WALLET_NEEDS_CUSTOMER',
          'wallet payment needs a signed-in customer',
          400
        );
      walletAmount = Math.min(wantWallet, total);
      const w = db.all(
        'UPDATE customer_wallets SET balance = balance - ?1, updated_at = ?3 WHERE store_id = ?2 AND customer_id = ?4 AND balance >= ?1 RETURNING id, balance',
        [walletAmount, input.storeId, now, input.customerId]
      );
      if (w.length !== 1)
        throw new MoneyError('INSUFFICIENT_WALLET', 'wallet balance is not enough', 409);
      walletTx = { walletId: w[0].id as string, balanceAfter: w[0].balance as number };
    }

    const num = orderNumber(now);
    const paymentStatus =
      total > 0 && walletAmount >= total ? 'paid' : total === 0 ? 'paid' : 'unpaid';
    db.run(
      `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, tax, shipping, discount, total, currency, coupon_code, coupon_discount, wallet_amount, shipping_address, billing_address, checkout_ip, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        input.storeId,
        input.customerId ?? null,
        num,
        paymentStatus,
        subtotal,
        tax,
        shipping,
        couponDiscount,
        total,
        input.currency ?? 'EGP',
        couponCode,
        couponDiscount,
        walletAmount,
        JSON.stringify(input.shippingAddress),
        JSON.stringify(input.billingAddress ?? input.shippingAddress),
        input.checkoutIp ?? null,
        input.idempotencyKey ?? null,
        now,
        now,
      ]
    );
    for (const it of items)
      db.run(
        'INSERT INTO order_items (id, order_id, product_id, variant_id, product_name, variant_name, sku, quantity, price, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          crypto.randomUUID(),
          orderId,
          it.productId,
          it.variantId,
          it.name,
          it.variantName,
          it.sku,
          it.qty,
          it.price,
          it.price * it.qty,
        ]
      );

    if (walletTx)
      db.run(
        'INSERT INTO wallet_transactions (id, store_id, wallet_id, customer_id, amount, balance_after, type, order_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          crypto.randomUUID(),
          input.storeId,
          walletTx.walletId,
          input.customerId,
          -walletAmount,
          walletTx.balanceAfter,
          'order_payment',
          orderId,
          `order:${orderId}:wallet`,
        ]
      );
    return {
      orderId,
      orderNumber: num,
      subtotal,
      couponDiscount,
      shipping,
      tax,
      walletAmount,
      total,
      paymentStatus,
      replayed: false,
    };
  });
}
