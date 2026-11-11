import { normalizePhoneForStorage } from '../../../shared/src/region';
import { MoneyError, type SyncSql } from './sync-sql';
import { freshOrderNumber } from './order-number';
import { issueSaleDocument } from './fiscal';
import { decrementProduct, decrementVariant, recordMovement, takeUpTo } from './stock';
import { applyRoute, planRoute, recordAllocations, type Allocation } from './warehouse-route';
import { assertGoldLinesPriceable, type GoldGateLine } from './gold';
import { indexEntity } from './payments';
import { assertMoqSatisfied, resolveCartPrices, type Buyer } from './pricing';
import {
  cartItemsForTargeting,
  couponCartDiscount,
  matchesTargeting,
  resolveCustomerContext,
} from './promotions';
import { calculateShipping } from './shipping';
import { computeOrderAmounts, frozenTaxInvoiceFields, resolveActiveTaxRate } from './tax';

/**
 * A merchant's manual (phone) order on the StoreDO (INFRA-CF-1 PR R4, Ruling CF-R4-2): the port of
 * `OrderService.createAdminOrder`'s `withMoneyTx` and everything that feeds it, in ONE section like `placeOrder`.
 *
 * What it shares with `placeOrder` (the same functions, not copies): the cart price resolver (tiers, group, wholesale,
 * MOQ), the gold-rate gate, the shipping rates, the tax maths and the frozen seller identity, the entity index and the
 * gapless fiscal sale document. Stock (Ruling STOCK-SYMMETRY-1, superseded 2026-11-11): the order RESERVES stock atomically in
 * this section, like checkout, and is refused 422 INSUFFICIENT_STOCK when short. A store admin may override with a reason: the
 * order then takes what is on hand, the short units are recorded as a `stock_not_taken` marker (so a cancel / refund puts back
 * only what was taken) and a `stock_override` event keeps the audit. What it does NOT do, exactly like Postgres: take a cart,
 * apply promotions / bundles / loyalty / wallet / COD fee, enforce the stock-hold cap or the minimum-order value, or refuse an
 * area with no rate (an admin may order for any area).
 *
 * Trust boundary as `placeOrder`: `buyer`, `wholesaleEntitled`, `actorRole`/`actorId` and the override permissions are resolved
 * by the API Worker from the verified session (it has already refused an override from a role that may not make it, and one
 * without a reason); amounts are never taken from the caller.
 */
/** Units an order did NOT take from stock: `{ items: [{ orderItemId, quantity }] }` (#633; legacy phone orders list every line, new ones only an overridden shortage). */
const STOCK_NOT_TAKEN_EVENT = 'stock_not_taken';

export interface AdminOrderInput {
  storeId: string;
  lines: Array<{ productId: string; variantId?: string; quantity: number }>;
  customerId?: string;
  buyer?: Buyer;
  wholesaleEntitled?: boolean;
  shippingAddress: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
  currency?: string;
  notes?: string;
  couponCode?: string;
  /** apply the coupon outside its rules (Ruling M-OVR-1); the API has checked role and reason */
  overrideCouponRules?: boolean;
  couponOverrideReason?: string;
  /** below-MOQ order (B2B); the API has checked role and reason */
  overrideMoq?: boolean;
  moqOverrideReason?: string;
  /** take what is on hand and place the order although stock is short; the API has checked role and reason */
  overrideStock?: boolean;
  stockOverrideReason?: string;
  /** negotiated shipping fee in piastres, replaces the computed one */
  shippingOverride?: number;
  actorId: string;
  actorRole?: string | null;
  now?: number;
}
export interface AdminOrderResult {
  orderId: string;
  orderNumber: string;
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
  /** true when the order was placed over a stock shortage (the admin override) */
  stockOverridden?: boolean;
}

const COUPON_OVERRIDE_EVENT = 'coupon_override';
const STOCK_OVERRIDE_EVENT = 'stock_override';
const MAX_TOTAL = 2_000_000_000;
const LIVE = "status NOT IN ('cancelled', 'refunded')";
const jsonList = (v: unknown): string[] => {
  try {
    const a = JSON.parse(String(v ?? '[]'));
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const withStoredPhone = (addr: Record<string, unknown>): Record<string, unknown> =>
  typeof addr.phone === 'string' ? { ...addr, phone: normalizePhoneForStorage(addr.phone) } : addr;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function placeAdminOrder(db: SyncSql, input: AdminOrderInput): AdminOrderResult {
  const now = input.now ?? Date.now();
  const storeId = input.storeId;
  if (!storeId) throw new MoneyError('NO_STORE', 'storeId is required', 400);
  if (!Array.isArray(input.lines) || input.lines.length === 0)
    throw new MoneyError('NO_ITEMS', 'Order must have at least one item', 400);
  if (input.lines.length > 100)
    throw new MoneyError('BAD_LINES', 'an order has at most 100 lines', 400);
  if (!input.shippingAddress || typeof input.shippingAddress !== 'object')
    throw new MoneyError('BAD_ADDRESS', 'a shipping address is required', 400);
  const buyer: Buyer =
    input.buyer ??
    (input.customerId
      ? { kind: 'merchant-selected', shopperUserId: input.customerId }
      : { kind: 'anonymous' });

  return db.transactionSync(() => {
    // `customerId` is the registered shopper's users.id (Ruling CF-FIX-2); the Worker validated it against the store's
    // identity before the call, and the DO has no users table.
    if (
      input.customerId !== undefined &&
      (typeof input.customerId !== 'string' || !input.customerId)
    )
      throw new MoneyError('BAD_ARGS', 'customerId', 400);

    // ---- lines: the same refusals, in the same order, as the Postgres hydration --------------------------------------
    const lines = input.lines.map(it => {
      const product = db.all(
        "SELECT id, name, sku, cost_price FROM products WHERE id = ? AND store_id = ? AND status = 'active' AND deleted_at IS NULL",
        [it.productId, storeId]
      )[0];
      if (!product)
        throw new MoneyError('PRODUCT_NOT_FOUND', `Product ${it.productId} not found`, 404);
      const variants = db.all(
        'SELECT id, title, title_ar, sku, price, cost_price, is_active FROM product_variants WHERE product_id = ?',
        [it.productId]
      );
      if (!it.variantId && variants.length > 0)
        throw new MoneyError(
          'VARIANT_REQUIRED',
          `Choose a size or option for “${product.name as string}”`,
          400,
          { productId: product.id, productName: product.name }
        );
      const variant = it.variantId ? variants.find(v => v.id === it.variantId) : undefined;
      if (it.variantId) {
        if (!variant)
          throw new MoneyError(
            'VARIANT_NOT_FOUND',
            `Variant ${it.variantId} not found for product ${product.name as string}`,
            404
          );
        if (variant.is_active !== 1)
          throw new MoneyError(
            'VARIANT_INACTIVE',
            `Variant ${(variant.title as string | null) ?? it.variantId} of ${product.name as string} is disabled`,
            409,
            { productId: product.id, variantId: it.variantId }
          );
      }
      return {
        productId: product.id as string,
        variantId: it.variantId ?? null,
        name: product.name as string,
        sku: ((variant?.sku as string | null) ?? (product.sku as string | null)) || null,
        variantName: (variant?.title as string | null) ?? null,
        variantNameAr: ((variant?.title_ar as string | null) || null) as string | null,
        cost:
          (variant?.cost_price as number | null | undefined) ??
          (product.cost_price as number | null) ??
          null,
        quantity: Math.max(1, Math.floor(it.quantity)),
      };
    });

    // ---- price (tiers, group, wholesale), gold gate, MOQ ----------------------------------------------------------
    const priced = resolveCartPrices(db, {
      storeId,
      buyer,
      wholesaleEntitled: input.wholesaleEntitled === true,
      lines: lines.map((l, i) => ({
        key: String(i),
        productId: l.productId,
        variantId: l.variantId,
        qty: l.quantity,
      })),
    });
    const goldLines: GoldGateLine[] = [];
    for (const l of priced.lines) {
      const p = db.all('SELECT pricing_mode FROM products WHERE id = ? AND store_id = ?', [
        l.productId,
        storeId,
      ])[0];
      const v = l.variantId
        ? db.all('SELECT pricing_mode FROM product_variants WHERE id = ?', [l.variantId])[0]
        : undefined;
      if (
        ((v?.pricing_mode as string | null | undefined) ?? (p?.pricing_mode as string)) ===
        'gold_rate'
      )
        goldLines.push({
          key: l.key,
          productId: l.productId,
          variantId: l.variantId,
          materialisedUnitPrice: l.resolved.listMinor,
          quotedUnitPrice: null,
        });
    }
    const gold = goldLines.length
      ? assertGoldLinesPriceable(db, storeId, goldLines, { requireQuote: false, now })
      : null;
    const belowMoqProducts = priced.lines.filter(l => l.resolved.belowMoq).map(l => l.productId);
    if (input.overrideMoq !== true) assertMoqSatisfied(priced.lines);
    const subtotal = priced.looseSubtotal;
    if (subtotal > MAX_TOTAL) throw new MoneyError('TOTAL_TOO_LARGE', 'order total too large', 400);

    // ---- shipping: computed, never fatal; a negotiated fee replaces it ----------------------------------------------
    const addr = input.shippingAddress;
    const area = str(addr.area) || str(addr.city);
    let shipping = 0;
    try {
      const q = calculateShipping(db, storeId, area, subtotal, str(addr.governorate) || undefined);
      shipping = q.freeShipping ? 0 : q.shippingCost;
    } catch {
      shipping = 0;
    }
    if (typeof input.shippingOverride === 'number') shipping = input.shippingOverride;

    // ---- coupon: its rules are enforced unless a permitted override says otherwise (Ruling M-OVR-1) ----------------
    const override = !!input.couponCode && input.overrideCouponRules === true;
    const violations: string[] = [];
    let couponDiscount = 0;
    let couponCode: string | null = null;
    let coupon: Record<string, unknown> | undefined;
    if (input.couponCode) {
      coupon = db.all(
        'SELECT id, code, type, value, min_order_amount, max_discount, usage_limit, usage_count, usage_limit_per_user, starts_at, expires_at, customer_group_id, first_order_only, min_quantity, scope_product_ids, scope_category_ids FROM coupons WHERE store_id = ? AND code = ? COLLATE NOCASE AND is_active = 1',
        [storeId, input.couponCode]
      )[0];
      if (!coupon) throw new MoneyError('NOT_FOUND', 'Coupon not found or inactive', 404);
      const phone = str(addr.phone) || null;
      const email = str(addr.email) || null;
      const ctx = resolveCustomerContext(
        db,
        storeId,
        { customerId: input.customerId, phone, email },
        buyer
      );
      const freeShip = coupon.type === 'free_shipping';
      const targetingCtx = {
        ...ctx,
        cartItems: cartItemsForTargeting(db, storeId, priced, freeShip),
      };
      const basis = freeShip ? subtotal : priced.couponBasisSubtotal;
      const t = {
        customerGroupId: (coupon.customer_group_id as string | null) ?? null,
        firstOrderOnly: !!coupon.first_order_only,
        minOrderAmount: (coupon.min_order_amount as number | null) ?? null,
        minQuantity: (coupon.min_quantity as number | null) ?? null,
        scopeProductIds: jsonList(coupon.scope_product_ids),
        scopeCategoryIds: jsonList(coupon.scope_category_ids),
      };
      if (coupon.starts_at !== null && now < (coupon.starts_at as number))
        violations.push('COUPON_NOT_STARTED');
      if (coupon.expires_at !== null && now > (coupon.expires_at as number))
        violations.push('COUPON_EXPIRED');
      if (coupon.usage_limit && (coupon.usage_count as number) >= (coupon.usage_limit as number))
        violations.push('COUPON_LIMIT_REACHED');
      if (coupon.min_order_amount && basis < (coupon.min_order_amount as number))
        violations.push('MIN_ORDER_NOT_MET');
      const targeting = matchesTargeting(t, targetingCtx);
      if (!targeting.eligible) violations.push('COUPON_NOT_ELIGIBLE');
      if (violations.length > 0 && !override)
        throw new MoneyError(violations[0], violations[0], 400);
      if (freeShip) shipping = 0;
      else
        couponDiscount = couponCartDiscount(
          {
            ...t,
            type: coupon.type as 'percentage' | 'fixed',
            value: coupon.value as number,
            maxDiscount: (coupon.max_discount as number | null) ?? null,
          },
          targetingCtx,
          { override, overrideBase: priced.couponBasisSubtotal }
        ).discount;
      couponCode = coupon.code as string;

      // per-customer limit (identity: the customer, else the guest's phone / e-mail)
      const perUser = (coupon.usage_limit_per_user as number | null) || 0;
      if (perUser > 0) {
        const who = {
          phone: phone ? normalizePhoneForStorage(phone) : null,
          email: email ? email.trim().toLowerCase() : null,
        };
        if (!input.customerId && !who.phone && !who.email) {
          if (!override)
            throw new MoneyError(
              'COUPON_NEEDS_CONTACT',
              'This coupon is limited per customer: add a phone number or email to use it.',
              400
            );
          violations.push('COUPON_NEEDS_CONTACT');
        } else {
          const where = input.customerId
            ? 'customer_id = ?'
            : `((? IS NOT NULL AND json_extract(shipping_address, '$.phone') = ?) OR (? IS NOT NULL AND lower(json_extract(shipping_address, '$.email')) = ?))`;
          const params = input.customerId
            ? [input.customerId]
            : [who.phone, who.phone, who.email, who.email];
          const used = db.all(
            `SELECT count(*) AS n FROM orders WHERE store_id = ? AND deleted_at IS NULL AND ${LIVE} AND coupon_code = ? AND ${where}`,
            [storeId, coupon.code, ...params]
          )[0].n as number;
          if (used >= perUser) {
            if (!override)
              throw new MoneyError('COUPON_LIMIT_REACHED', 'Coupon usage limit reached', 400);
            violations.push('COUPON_LIMIT_REACHED');
          }
        }
      }
      // reserve the redemption; an override still counts the use and only skips the `< usage_limit` guard
      const limit = (coupon.usage_limit as number | null) || 0;
      const claimed = db.all(
        'UPDATE coupons SET usage_count = usage_count + 1 WHERE id = ?1 AND is_active = 1 AND (?2 = 1 OR ?3 = 0 OR usage_count < ?3) RETURNING id',
        [coupon.id, override ? 1 : 0, limit]
      );
      if (claimed.length !== 1)
        throw override
          ? new MoneyError('NOT_FOUND', 'Coupon not found or inactive', 404)
          : new MoneyError('COUPON_LIMIT_REACHED', 'Coupon usage limit reached', 400);
    }

    // ---- amounts (no COD fee on an admin order), then the rows ---------------------------------------------------------
    const active = resolveActiveTaxRate(db, storeId);
    const { tax, total, taxableAmount } = computeOrderAmounts({
      subtotal,
      discount: couponDiscount,
      shipping,
      ratePercent: active.ratePercent,
      includedInPrice: active.includedInPrice,
    });
    if (total < 0) throw new MoneyError('NEGATIVE_TOTAL', 'order total cannot be negative', 500);
    if (total > MAX_TOTAL) throw new MoneyError('TOTAL_TOO_LARGE', 'order total too large', 400);
    const frozen = frozenTaxInvoiceFields(active);
    const orderId = crypto.randomUUID();
    const num = freshOrderNumber(db, now);
    const shippingAddress = withStoredPhone(addr);
    db.run(
      `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, tax, tax_included_in_price, tax_rate_bps, taxable_amount, seller_tax_registration_number, seller_tax_legal_name, price_group_name, shipping, discount, total, currency, coupon_code, notes, shipping_address, billing_address, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        storeId,
        input.customerId ?? null,
        num,
        subtotal,
        tax,
        active.includedInPrice ? 1 : 0,
        frozen.taxRateBps,
        taxableAmount,
        frozen.sellerTaxRegistrationNumber,
        frozen.sellerTaxLegalName,
        priced.groupPriceApplied ? priced.priceGroupName : null,
        shipping,
        couponDiscount,
        total,
        input.currency ?? 'EGP',
        couponCode,
        input.notes ?? null,
        JSON.stringify(shippingAddress),
        JSON.stringify(withStoredPhone(input.billingAddress ?? addr)),
        now,
        now,
      ]
    );
    const notTaken: Array<{ orderItemId: string; quantity: number }> = [];
    const shortages: Array<{
      productId: string;
      variantId: string | null;
      requested: number;
      available: number;
    }> = [];
    for (const [i, l] of priced.lines.entries()) {
      const src = lines[i];
      const s = l.snapshot;
      const itemId = crypto.randomUUID();
      db.run(
        'INSERT INTO order_items (id, order_id, product_id, variant_id, product_name, variant_name, variant_name_ar, sku, quantity, price, cost_price, total, list_price, price_source, price_tier_min_qty, price_group_applied, tier_ladder, gold_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          itemId,
          orderId,
          l.productId,
          l.variantId,
          src.name,
          src.variantName,
          src.variantNameAr,
          src.sku,
          l.qty,
          l.resolved.unitMinor,
          src.cost,
          l.resolved.unitMinor * l.qty,
          s.listPrice,
          s.priceSource,
          s.priceTierMinQty,
          s.priceGroupApplied ? 1 : 0,
          s.tierLadder ? JSON.stringify(s.tierLadder) : null,
          gold?.snapshotJson.get(l.key) ?? null,
        ]
      );
    }
    // ---- stock: reserve every tracked line atomically (one conditional UPDATE each, so a concurrent order can never
    // oversell); a short line is collected, then the order is refused (the section rolls back) unless overridden
    const itemRows = db.all(
      'SELECT id, product_id, variant_id, quantity FROM order_items WHERE order_id = ?',
      [orderId]
    );
    const allocations: Allocation[] = []; // WAREHOUSE-ROUTE-1
    for (const row of itemRows) {
      const productId = row.product_id as string;
      const variantId = (row.variant_id as string | null) ?? null;
      const qty = row.quantity as number;
      const p = db.all('SELECT track_inventory FROM products WHERE id = ? AND store_id = ?', [
        productId,
        storeId,
      ])[0];
      if (!p || !p.track_inventory) continue; // an untracked line has no stock to take or give back
      const move = (n: number) =>
        variantId ? decrementVariant(db, variantId, n) : decrementProduct(db, productId, n);
      // Ruling WAREHOUSE-ROUTE-2: a reasoned stock override skips routing (it must never be refused NO_SINGLE_WAREHOUSE);
      // no allocation is written, so a cancel gives back like a pre-routing order (aggregate + reconcile to the default)
      const route =
        input.overrideStock === true ? null : planRoute(db, storeId, productId, variantId, qty);
      const full = move(qty);
      if (full.ok && route)
        allocations.push(
          applyRoute(db, storeId, route, productId, variantId, qty, {
            orderItemId: row.id as string,
          })
        );
      if (full.ok) {
        recordMovement(db, {
          storeId,
          productId,
          type: 'sale',
          quantity: -qty,
          previousStock: full.previousStock,
          newStock: full.newStock,
          reference: orderId,
          reason: 'Sold via phone order',
        });
        continue;
      }
      if (input.overrideStock !== true) {
        shortages.push({
          productId,
          variantId,
          requested: qty,
          available: Math.max(0, full.newStock),
        });
        continue; // refused below; nothing partial is kept
      }
      // override: take what is ACTUALLY on hand in one clamped statement; the ledger and the marker use the units taken
      const part = takeUpTo(
        db,
        variantId ? 'product_variants' : 'products',
        variantId ?? productId,
        qty
      );
      const taken = part.previousStock - part.newStock;
      if (taken > 0)
        recordMovement(db, {
          storeId,
          productId,
          type: 'sale',
          quantity: -taken,
          previousStock: part.previousStock,
          newStock: part.newStock,
          reference: orderId,
          reason: taken === qty ? 'Sold via phone order' : 'Sold via phone order (stock override)',
        });
      if (taken < qty) {
        shortages.push({ productId, variantId, requested: qty, available: taken });
        notTaken.push({ orderItemId: row.id as string, quantity: qty - taken });
      }
    }
    if (shortages.length > 0 && input.overrideStock !== true)
      throw new MoneyError('INSUFFICIENT_STOCK', 'not enough stock for this order', 422, {
        shortages,
      });

    recordAllocations(db, storeId, orderId, allocations, now);
    // the durable record of an override, in the order's own section: an overridden order cannot exist without it
    const event = (toStatus: string, metadata: Record<string, unknown>) =>
      db.run(
        'INSERT INTO order_events (id, store_id, order_id, from_status, to_status, actor_id, metadata, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
        [
          crypto.randomUUID(),
          storeId,
          orderId,
          toStatus,
          input.actorId,
          JSON.stringify(metadata),
          now,
        ]
      );
    // #633: the units this order did not take (only an overridden shortage); cancel / refund restock puts back only what was taken
    if (notTaken.length > 0) event(STOCK_NOT_TAKEN_EVENT, { items: notTaken });
    if (shortages.length > 0 && input.overrideStock === true)
      event(STOCK_OVERRIDE_EVENT, {
        reason: input.stockOverrideReason?.trim() ?? '',
        actorRole: input.actorRole ?? null,
        shortages,
      });
    if (override && couponCode)
      event(COUPON_OVERRIDE_EVENT, {
        couponCode,
        reason: input.couponOverrideReason?.trim() ?? '',
        actorRole: input.actorRole ?? null,
        violations,
        discount: couponDiscount,
      });
    if (input.overrideMoq === true && belowMoqProducts.length > 0)
      event('moq_override', {
        reason: input.moqOverrideReason?.trim() ?? '',
        actorRole: input.actorRole ?? null,
        productIds: [...new Set(belowMoqProducts)],
      });
    indexEntity(db, storeId, 'order', orderId, now);
    issueSaleDocument(db, { storeId, orderId, now });
    return {
      orderId,
      orderNumber: num,
      subtotal,
      discount: couponDiscount,
      shipping,
      tax,
      total,
      stockOverridden: shortages.length > 0 && input.overrideStock === true,
    };
  });
}
