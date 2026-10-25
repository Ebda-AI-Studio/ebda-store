import { MoneyError, type SyncSql } from './sync-sql';
import { normalizePhoneForStorage } from '../../../shared/src/region';
import { decrementProduct, decrementVariant, forceDecrementVariant, recordMovement } from './stock';

export interface CheckoutLine {
  productId: string;
  variantId?: string;
  quantity: number;
}
export interface HoldCaps {
  /** open unpaid orders per phone/email for COD and InstaPay (default 2) */
  manual?: number;
  /** same, any other payment label (default 5) */
  gateway?: number;
  /** open unpaid orders per checkout IP (default 8: shared CGNAT) */
  ip?: number;
}
/**
 * TRUST BOUNDARY (Opus review 2026-10-25, finding 2): this core trusts `customerId`, `shipping`, `tax`,
 * `backorderEnabled` and `expectedTotal`. The ONLY caller is the store Worker, which must derive `customerId`
 * from the verified session (never from the request body) and compute shipping/tax server-side. The core still
 * checks that the customer exists in THIS store.
 */
export interface CheckoutInput {
  storeId: string;
  lines: CheckoutLine[];
  customerId?: string;
  couponCode?: string;
  /** piastres the shopper wants to pay from their wallet (capped to the order total and the balance). */
  walletAmount?: number;
  /** piastres, resolved by the caller from the shipping zone/rate engine. A free_shipping coupon zeroes it here. */
  shipping?: number;
  /** piastres, resolved by the tax engine (a later slice). */
  tax?: number;
  currency?: string;
  idempotencyKey?: string;
  shippingAddress: Record<string, unknown>;
  billingAddress?: unknown;
  checkoutIp?: string;
  /** cod | instapay | any gateway label: selects the stock-hold cap. Omit for no hold cap (e.g. already paid). */
  paymentMethod?: string;
  holdCaps?: HoldCaps;
  /** the store's `inventory.backorder` feature (resolved by the caller from the platform database). */
  backorderEnabled?: boolean;
  /** the total the shopper last saw: a different server total aborts with PRICE_CHANGED (Ruling B2B-9). */
  expectedTotal?: number;
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

const MAX_TOTAL = 2_000_000_000;
const orderNumber = (now: number) =>
  `ORD-${Math.floor(now / 1000)
    .toString(36)
    .toUpperCase()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`;
const int = (v: unknown, name: string): number => {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_TOTAL)
    throw new MoneyError('BAD_AMOUNT', `${name} must be a non-negative integer (piastres)`, 400);
  return v;
};
const MANUAL = new Set(['cod', 'instapay']);

/** Pure targeting rules, copied from apps/api/src/services/promotion-targeting.ts (keep in sync). */
interface Targeting {
  customerGroupId: string | null;
  firstOrderOnly: boolean;
  minOrderAmount: number | null;
  minQuantity: number | null;
  scopeProductIds: string[];
  scopeCategoryIds: string[];
}
interface CartItem {
  productId: string;
  categoryIds: string[];
  quantity: number;
  lineTotal: number;
}
export function matchesTargeting(
  t: Targeting,
  ctx: { customerGroupId: string | null; isFirstOrder: boolean; cartItems: CartItem[] }
): { eligible: boolean; matchingSubtotal: number; matchingQty: number } {
  const miss = { eligible: false, matchingSubtotal: 0, matchingQty: 0 };
  if (t.customerGroupId && t.customerGroupId !== ctx.customerGroupId) return miss;
  if (t.firstOrderOnly && !ctx.isFirstOrder) return miss;
  const scoped = t.scopeProductIds.length > 0 || t.scopeCategoryIds.length > 0;
  const inScope = (i: CartItem) =>
    t.scopeProductIds.includes(i.productId) ||
    i.categoryIds.some(c => t.scopeCategoryIds.includes(c));
  const matching = scoped ? ctx.cartItems.filter(inScope) : ctx.cartItems;
  const matchingSubtotal = matching.reduce((s, i) => s + i.lineTotal, 0);
  const matchingQty = matching.reduce((s, i) => s + i.quantity, 0);
  if (scoped && matchingSubtotal <= 0) return miss;
  if (t.minOrderAmount != null && matchingSubtotal < t.minOrderAmount) return miss;
  if (t.minQuantity != null && matchingQty < t.minQuantity) return miss;
  return { eligible: true, matchingSubtotal, matchingQty };
}
export function computeDiscount(
  type: string,
  value: number,
  maxDiscount: number | null,
  base: number
): number {
  if (type === 'percentage') {
    const d = Math.round((base * value) / 100);
    return maxDiscount != null && d > maxDiscount ? maxDiscount : d;
  }
  if (type === 'fixed') return value > base ? base : value;
  return 0; // free_shipping is handled on the shipping line
}
const jsonList = (v: unknown): string[] => {
  try {
    const a = JSON.parse(String(v ?? '[]'));
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** Stable guest identity: E.164 phone and lowercased email, normalised the way the buyer key will be. */
function identity(input: CheckoutInput): { phone: string | null; email: string | null } {
  const rawPhone =
    typeof input.shippingAddress?.phone === 'string' ? input.shippingAddress.phone : '';
  const rawEmail =
    typeof input.shippingAddress?.email === 'string' ? input.shippingAddress.email : '';
  const phone = rawPhone ? normalizePhoneForStorage(rawPhone) : '';
  const email = rawEmail.trim().toLowerCase();
  return { phone: phone || null, email: email || null };
}
const OPEN =
  "status IN ('pending', 'awaiting_payment_confirmation') AND payment_status = 'unpaid' AND deleted_at IS NULL";
const LIVE = "status NOT IN ('cancelled', 'refunded')";

/**
 * Place an order: ONE `transactionSync`. Prices come from the rows (never the client); stock, coupon usage and the
 * wallet debit are conditional single statements, so under any number of parallel checkouts on one SKU exactly
 * `stock` of them succeed and nothing goes negative. A failure anywhere rolls the whole order back, stock included.
 * Not yet ported (later slices, same transaction): promotions, bundles, gold-rate gate, loyalty, tier/group prices,
 * COD fee, wholesale audience, MOQ, shipping/tax engines (caller-supplied, see the trust boundary above).
 */
export function placeOrder(db: SyncSql, input: CheckoutInput): PlacedOrder {
  const now = input.now ?? Date.now();
  if (!input.storeId) throw new MoneyError('NO_STORE', 'storeId is required', 400);
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100)
    throw new MoneyError('BAD_LINES', 'an order needs 1 to 100 lines', 400);
  if (!input.shippingAddress || typeof input.shippingAddress !== 'object')
    throw new MoneyError('BAD_ADDRESS', 'a shipping address is required', 400);
  let shipping = int(input.shipping, 'shipping');
  const tax = int(input.tax, 'tax');
  const wantWallet = int(input.walletAmount, 'walletAmount');
  const who = identity(input);
  // the stored address carries the normalised identity so later per-user and hold-cap counts match on the same form
  const shippingAddress = {
    ...input.shippingAddress,
    ...(who.phone ? { phone: who.phone } : {}),
    ...(who.email ? { email: who.email } : {}),
  };

  return db.transactionSync(() => {
    const sameLines = (orderId: string): boolean => {
      const rows = db.all(
        'SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = ?',
        [orderId]
      );
      const key = (p: string, v: unknown, q: number) => `${p}|${v ?? ''}|${q}`;
      const a = rows
        .map(r => key(r.product_id as string, r.variant_id, r.quantity as number))
        .sort()
        .join(',');
      const b = input.lines
        .map(l => key(l.productId, l.variantId, l.quantity))
        .sort()
        .join(',');
      return a === b;
    };
    if (input.idempotencyKey) {
      const prev = db.all(
        'SELECT id, customer_id, order_number, subtotal, coupon_discount, shipping, tax, wallet_amount, total, payment_status FROM orders WHERE idempotency_key = ? AND store_id = ?',
        [input.idempotencyKey, input.storeId]
      )[0];
      if (prev) {
        if (
          (prev.customer_id ?? null) !== (input.customerId ?? null) ||
          !sameLines(prev.id as string)
        )
          throw new MoneyError(
            'IDEMPOTENCY_CONFLICT',
            'this idempotency key was used for a different order',
            409
          );
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
    }

    let customerGroupId: string | null = null;
    if (input.customerId) {
      const c = db.all('SELECT id, group_id FROM customers WHERE id = ? AND store_id = ?', [
        input.customerId,
        input.storeId,
      ])[0];
      if (!c) throw new MoneyError('CUSTOMER_NOT_FOUND', 'unknown customer for this store', 404);
      customerGroupId = (c.group_id as string | null) ?? null;
    }

    // stock-hold cap (lib/stock-hold-cap.ts): bounds unpaid holds per phone / email / IP. Race-free here: the DO is the
    // only writer and this runs in the same synchronous transaction as the order insert.
    if (input.paymentMethod && wantWallet === 0 && (who.phone || who.email || input.checkoutIp)) {
      const manual = MANUAL.has(input.paymentMethod);
      const cap = manual ? (input.holdCaps?.manual ?? 2) : (input.holdCaps?.gateway ?? 5);
      const ipCap = input.holdCaps?.ip ?? 8;
      if (who.phone || who.email) {
        const n = db.all(
          `SELECT count(*) AS n FROM orders WHERE store_id = ? AND ${OPEN} AND ((?1 IS NOT NULL AND json_extract(shipping_address, '$.phone') = ?1) OR (?2 IS NOT NULL AND lower(json_extract(shipping_address, '$.email')) = ?2))`
            .replace('?1', '?')
            .replace('?1', '?')
            .replace('?2', '?')
            .replace('?2', '?'),
          [input.storeId, who.phone, who.phone, who.email, who.email]
        )[0].n as number;
        if (n >= cap)
          throw new MoneyError('TOO_MANY_OPEN_ORDERS', 'too many unpaid open orders', 429);
      }
      if (input.checkoutIp) {
        const n = db.all(
          `SELECT count(*) AS n FROM orders WHERE store_id = ? AND ${OPEN} AND checkout_ip = ?`,
          [input.storeId, input.checkoutIp]
        )[0].n as number;
        if (n >= ipCap)
          throw new MoneyError('TOO_MANY_OPEN_ORDERS', 'too many unpaid open orders', 429);
      }
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
    const cart: CartItem[] = [];
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
      const tracked = !!p.track_inventory;
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
        price = (v.price as number | null) ?? price; // a variant without its own price inherits the product's
        variantName = v.title as string;
        sku = (v.sku as string | null) ?? sku;
        if (tracked) {
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
          else if (v.allow_backorder && input.backorderEnabled === true) {
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
        }
      } else {
        if (line.variantId)
          throw new MoneyError('VARIANT_UNAVAILABLE', 'this product has no variants', 409);
        if (tracked) {
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
      cart.push({
        productId: line.productId,
        quantity: qty,
        lineTotal: price * qty,
        categoryIds: db
          .all('SELECT category_id FROM product_categories WHERE product_id = ?', [line.productId])
          .map(r => r.category_id as string),
      });
    }
    if (subtotal > MAX_TOTAL) throw new MoneyError('TOTAL_TOO_LARGE', 'order total too large', 400);

    // coupon: targeting, per-customer limit (guests by normalised phone/email), then ONE conditional statement claims a use
    let couponDiscount = 0;
    let couponCode: string | null = null;
    if (input.couponCode) {
      const c = db.all(
        'SELECT id, code, type, value, min_order_amount, max_discount, usage_limit, usage_limit_per_user, is_active, starts_at, expires_at, customer_group_id, first_order_only, min_quantity, scope_product_ids, scope_category_ids FROM coupons WHERE store_id = ? AND code = ? COLLATE NOCASE',
        [input.storeId, input.couponCode]
      )[0];
      if (!c || !c.is_active) throw new MoneyError('COUPON_INVALID', 'coupon is not valid', 409);
      if (
        (c.starts_at !== null && (c.starts_at as number) > now) ||
        (c.expires_at !== null && (c.expires_at as number) <= now)
      )
        throw new MoneyError('COUPON_EXPIRED', 'coupon is outside its dates', 409);

      // "has this shopper ordered before": a registered customer by id, a guest by phone or email (cancelled/refunded do not count)
      const identityWhere = input.customerId
        ? 'customer_id = ?'
        : `((? IS NOT NULL AND json_extract(shipping_address, '$.phone') = ?) OR (? IS NOT NULL AND lower(json_extract(shipping_address, '$.email')) = ?))`;
      const identityParams = input.customerId
        ? [input.customerId]
        : [who.phone, who.phone, who.email, who.email];
      const hasIdentity = !!(input.customerId || who.phone || who.email);
      const priorOrders = hasIdentity
        ? (db.all(
            `SELECT count(*) AS n FROM orders WHERE store_id = ? AND deleted_at IS NULL AND ${LIVE} AND ${identityWhere}`,
            [input.storeId, ...identityParams]
          )[0].n as number)
        : 0;

      const t = matchesTargeting(
        {
          customerGroupId: (c.customer_group_id as string | null) ?? null,
          firstOrderOnly: !!c.first_order_only,
          minOrderAmount: (c.min_order_amount as number | null) ?? null,
          minQuantity: (c.min_quantity as number | null) ?? null,
          scopeProductIds: jsonList(c.scope_product_ids),
          scopeCategoryIds: jsonList(c.scope_category_ids),
        },
        { customerGroupId, isFirstOrder: priorOrders === 0, cartItems: cart }
      );
      if (!t.eligible)
        throw new MoneyError(
          'COUPON_NOT_ELIGIBLE',
          'coupon does not apply to this cart or customer',
          409
        );

      // per-customer limit; 0 means unlimited (same truthiness as the Postgres path)
      const perUser = (c.usage_limit_per_user as number | null) || 0;
      if (perUser > 0) {
        if (!hasIdentity)
          throw new MoneyError(
            'COUPON_NEEDS_CONTACT',
            'this coupon needs a phone number or email (حسابك أو رقم الموبايل أو الإيميل مطلوب لاستخدام الكوبون)',
            400
          );
        const used = db.all(
          `SELECT count(*) AS n FROM orders WHERE store_id = ? AND deleted_at IS NULL AND ${LIVE} AND coupon_code = ? AND ${identityWhere}`,
          [input.storeId, c.code, ...identityParams]
        )[0].n as number;
        if (used >= perUser)
          throw new MoneyError(
            'COUPON_USER_LIMIT',
            'coupon already used the allowed number of times',
            409
          );
      }
      const limit = (c.usage_limit as number | null) || 0;
      const claimed = db.all(
        'UPDATE coupons SET usage_count = usage_count + 1 WHERE id = ?1 AND (?2 = 0 OR usage_count < ?2) RETURNING id',
        [c.id, limit]
      );
      if (claimed.length !== 1)
        throw new MoneyError('COUPON_EXHAUSTED', 'coupon has no uses left', 409);
      if (c.type === 'free_shipping') shipping = 0;
      else
        couponDiscount = Math.max(
          0,
          Math.min(
            computeDiscount(
              c.type as string,
              c.value as number,
              (c.max_discount as number | null) ?? null,
              t.matchingSubtotal
            ),
            subtotal
          )
        );
      couponCode = c.code as string;
    }

    const total = subtotal - couponDiscount + shipping + tax;
    if (total < 0) throw new MoneyError('NEGATIVE_TOTAL', 'order total cannot be negative', 500);
    if (total > MAX_TOTAL) throw new MoneyError('TOTAL_TOO_LARGE', 'order total too large', 400);
    if (input.expectedTotal !== undefined && input.expectedTotal !== total)
      throw new MoneyError(
        'PRICE_CHANGED',
        'the total changed since the shopper last saw it',
        409,
        { expected: input.expectedTotal, actual: total }
      );

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
      if (walletAmount > 0) {
        const w = db.all(
          'UPDATE customer_wallets SET balance = balance - ?1, updated_at = ?3 WHERE store_id = ?2 AND customer_id = ?4 AND balance >= ?1 RETURNING id, balance',
          [walletAmount, input.storeId, now, input.customerId]
        );
        if (w.length !== 1)
          throw new MoneyError('INSUFFICIENT_WALLET', 'wallet balance is not enough', 409);
        walletTx = { walletId: w[0].id as string, balanceAfter: w[0].balance as number };
      }
    }

    const num = orderNumber(now);
    const fullyWalletPaid = walletAmount > 0 && walletAmount >= total;
    const paymentStatus = fullyWalletPaid ? 'paid' : 'unpaid';
    db.run(
      `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, tax, shipping, discount, total, currency, coupon_code, coupon_discount, wallet_amount, shipping_address, billing_address, checkout_ip, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        input.storeId,
        input.customerId ?? null,
        num,
        fullyWalletPaid ? 'confirmed' : 'pending',
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
        JSON.stringify(shippingAddress),
        JSON.stringify(input.billingAddress ?? shippingAddress),
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
