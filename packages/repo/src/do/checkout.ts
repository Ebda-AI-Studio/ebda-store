import { normalizePhoneForStorage } from '../../../shared/src/region';
import {
  GOLD_PREPAID_ERROR_CODE,
  GOLD_PREPAID_MESSAGE,
  checkGoldPayment,
  goldAllowsDeferredPayment,
} from '../../../shared/src/commerce/payment-policy';
import { MoneyError, type SyncSql } from './sync-sql';
import { decrementProduct, decrementVariant, forceDecrementVariant, recordMovement } from './stock';
import { issueSaleDocument } from './fiscal';
import { assertMoqSatisfied, resolveCartPrices, type Buyer } from './pricing';
import {
  cartItemsForTargeting,
  computeDiscount,
  matchesTargeting,
  resolveBundles,
  resolvePromotions,
  type BundleRequest,
} from './promotions';
import { calculateShipping } from './shipping';
import { computeOrderTaxFields } from './tax';
import { codFeeForCheckout } from './cod-fee';
import { assertGoldLinesPriceable, type GoldGateLine } from './gold';
import { quoteRedemption, redeemPoints } from './loyalty';
import { indexEntity } from './payments';

export interface CheckoutLine {
  productId: string;
  variantId?: string;
  quantity: number;
  /** gold-rate lines: the unit price the shopper was shown (the gate refuses a stale quote). */
  quotedUnitPrice?: number | null;
  /** the shopper's personalisation text for this line (order_items.personalisation, Ruling CF-FINAL-1) */
  note?: string | null;
}
export interface HoldCaps {
  /** open unpaid orders per phone/email for COD and InstaPay (default 2) */
  manual?: number;
  /** same, any other payment label (default 5) */
  gateway?: number;
  /** open unpaid orders per checkout IP (default 40: shared CGNAT, QA-HOLDS-1) */
  ip?: number;
  /** only holds created in the last N hours count toward the IP cap (default 24, QA-HOLDS-1) */
  ipWindowHours?: number;
}
/**
 * TRUST BOUNDARY: this core trusts `buyer`/`customerId`, `wholesaleEntitled`, `loyaltyFeatureEnabled`,
 * `backorderEnabled` and `goldRequireQuote` (the store Worker resolves them from the verified session and the platform
 * database; the shopper never supplies them). Amounts are NEVER trusted: prices, discounts, shipping, tax, COD fee and
 * totals are all computed here from the rows. `customerId` is the shopper's users.id (Ruling CF-FIX-2): no CRM row is required.
 */
export interface CheckoutInput {
  storeId: string;
  lines: CheckoutLine[];
  /** bundle boxes (bundles table), priced and stocked in the same transaction */
  bundles?: BundleRequest[];
  buyer?: Buyer;
  customerId?: string;
  couponCode?: string;
  /** piastres the shopper wants to pay from their wallet (capped to the order total and the balance). */
  walletAmount?: number;
  /** points the shopper wants to redeem; the server quote decides what applies. */
  pointsToRedeem?: number;
  paymentMethod?: string;
  currency?: string;
  idempotencyKey?: string;
  /**
   * The cart this checkout consumes (audit M-012 / P07). It is claimed in the SAME section as the order: the rows still in
   * it must be exactly the lines and boxes being ordered (compared by content, not count), and they are deleted here, so a
   * second concurrent checkout of the same cart (no key, or a different key) finds it empty and fails with CART_CHANGED
   * instead of creating a second order. Also scopes `idempotencyKey` to this cart.
   */
  cart?: { id: string };
  shippingAddress: Record<string, unknown>;
  billingAddress?: unknown;
  checkoutIp?: string;
  holdCaps?: HoldCaps;
  /** `b2b.wholesale` feature (tiers + group prices only apply when literally true). */
  wholesaleEntitled?: boolean;
  /** platform `loyalty` feature */
  loyaltyFeatureEnabled?: boolean;
  /** the store's `inventory.backorder` feature */
  backorderEnabled?: boolean;
  /** web checkout: a gold-rate line must carry the shopper's quote (default true) */
  goldRequireQuote?: boolean;
  /** the total the shopper last saw: a different server total aborts with PRICE_CHANGED (Ruling B2B-9). */
  expectedTotal?: number;
  customerNotes?: string;
  /**
   * A QUOTE (Ruling CF-FINAL-1): price the cart exactly as an order would, take no stock, no wallet, no hold slot, write
   * nothing, and answer with the totals and the per-line prices (`quoteOrder`). Only `quoteOrder` sets it.
   */
  dryRun?: boolean;
  now?: number;
}
export interface OrderQuoteResult {
  subtotal: number;
  discount: number;
  shipping: number;
  codFee: number;
  tax: number;
  total: number;
  taxIncludedInPrice: boolean;
  /** one entry per loose line, in the order of `lines` of the input (bundle components are not quoted, as on Postgres) */
  lines: Array<{
    index: number;
    productId: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    listPrice: number;
    priceSource: string;
    priceTierMinQty: number | null;
  }>;
}
class QuoteSignal {
  constructor(readonly quote: OrderQuoteResult) {}
}
/** Price a cart as an order would (Ruling CF-FINAL-1): the section is abandoned, so a quote writes nothing at all. */
export function quoteOrder(db: SyncSql, input: CheckoutInput): OrderQuoteResult {
  try {
    placeOrder(db, {
      ...input,
      dryRun: true,
      idempotencyKey: undefined,
      cart: undefined,
    });
  } catch (e) {
    if (e instanceof QuoteSignal) return e.quote;
    throw e;
  }
  throw new MoneyError('QUOTE_FAILED', 'the quote did not complete', 500);
}
export interface PlacedOrder {
  orderId: string;
  orderNumber: string;
  subtotal: number;
  discount: number;
  couponDiscount: number;
  promotionDiscount: number;
  bundleDiscount: number;
  loyaltyDiscount: number;
  shipping: number;
  codFee: number;
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

interface OrderLine {
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  variantNameAr: string | null;
  sku: string | null;
  qty: number;
  price: number;
  costPrice: number | null;
  snapshot?: {
    listPrice: number;
    priceSource: string;
    priceTierMinQty: number | null;
    priceGroupApplied: boolean;
    tierLadder?: unknown;
  };
  goldSnapshot?: string;
  personalisation?: string | null;
  bundle?: { bundleId: string; groupId: string; name: string; nameAr: string | null };
}

/**
 * Place an order: ONE `transactionSync`. Everything money is computed here from the rows in the Postgres order
 * (OrderService.create): cart pricing (tiers, groups, wholesale audience, MOQ, gold gate), bundles, coupon targeting,
 * promotions (best-of with the coupon), loyalty redemption, shipping zone/area, COD fee, tax; then stock, coupon claim,
 * wallet and the order rows. Parallel checkouts are serialised by the DO; a failure anywhere rolls the whole order back.
 * Not ported (recorded in Ruling DO-MONEY-2): delivery-slot enforcement, gift/personalisation fields, affiliate
 * attribution, fiscal document issue and notifications (those are side effects after commit, not money state).
 */
export function placeOrder(db: SyncSql, input: CheckoutInput): PlacedOrder {
  const now = input.now ?? Date.now();
  if (!input.storeId) throw new MoneyError('NO_STORE', 'storeId is required', 400);
  if (!Array.isArray(input.lines) || input.lines.length > 100)
    throw new MoneyError('BAD_LINES', 'an order has at most 100 lines', 400);
  if (input.lines.length + (input.bundles?.length ?? 0) < 1)
    throw new MoneyError('BAD_LINES', 'an order needs at least one line or bundle', 400);
  if (!input.shippingAddress || typeof input.shippingAddress !== 'object')
    throw new MoneyError('BAD_ADDRESS', 'a shipping address is required', 400);
  const wantWallet = int(input.walletAmount, 'walletAmount');
  const who = identity(input);
  const shippingAddress = {
    ...input.shippingAddress,
    ...(who.phone ? { phone: who.phone } : {}),
    ...(who.email ? { email: who.email } : {}),
  };
  const buyer: Buyer =
    input.buyer ??
    (input.customerId ? { kind: 'session', userId: input.customerId } : { kind: 'anonymous' });

  const bundleTotals = new Map<string, number>();
  for (const b of input.bundles ?? [])
    bundleTotals.set(b.bundleId, (bundleTotals.get(b.bundleId) ?? 0) + b.quantity);
  const bundleKey = [...bundleTotals]
    .map(([k, n]) => `${k}x${n}`)
    .sort()
    .join(',');

  // A key from a cart-claimed checkout is scoped to ITS cart (one cart per shopper session): another shopper who guesses a key
  // can no longer read this order back. Without a cart (admin / import callers) the key stays per store.
  const idemKey = input.idempotencyKey
    ? input.cart
      ? `${input.cart.id}:${input.idempotencyKey}`
      : input.idempotencyKey
    : undefined;

  return db.transactionSync(() => {
    const sameLines = (orderId: string): boolean => {
      const rows = db.all(
        'SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = ? AND bundle_id IS NULL',
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
      if (a !== b) return false;
      const boxes = db
        .all(
          'SELECT bundle_id, count(DISTINCT bundle_group_id) AS n FROM order_items WHERE order_id = ? AND bundle_id IS NOT NULL GROUP BY bundle_id',
          [orderId]
        )
        .map(r => `${r.bundle_id}x${r.n}`)
        .sort()
        .join(',');
      return boxes === bundleKey;
    };
    if (idemKey) {
      const prev = db.all(
        'SELECT id, customer_id, order_number, subtotal, discount, coupon_discount, promotion_discount, bundle_discount, loyalty_discount, shipping, cod_fee, tax, wallet_amount, total, payment_status FROM orders WHERE idempotency_key = ? AND store_id = ?',
        [idemKey, input.storeId]
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
        const n = (k: string) => (prev[k] as number | null) ?? 0;
        return {
          orderId: prev.id as string,
          orderNumber: prev.order_number as string,
          subtotal: n('subtotal'),
          discount: n('discount'),
          couponDiscount: n('coupon_discount'),
          promotionDiscount: n('promotion_discount'),
          bundleDiscount: n('bundle_discount'),
          loyaltyDiscount: n('loyalty_discount'),
          shipping: n('shipping'),
          codFee: n('cod_fee'),
          tax: n('tax'),
          walletAmount: n('wallet_amount'),
          total: n('total'),
          paymentStatus: prev.payment_status as 'unpaid' | 'paid',
          replayed: true,
        };
      }
    }

    let cartCustomerId: string | null = null;
    if (input.cart) {
      const owned = db.all('SELECT id, customer_id FROM carts WHERE id = ? AND store_id = ?', [
        input.cart.id,
        input.storeId,
      ])[0];
      // What the cart holds NOW must be exactly what is being ordered (the lines and boxes, not their number): the rows
      // are deleted below, so a quantity change or a swapped line in another tab must not be silently eaten.
      const sig = (rows: Array<Record<string, unknown>>, ...cols: string[]) =>
        rows
          .map(r => cols.map(c => String(r[c] ?? '')).join('|'))
          .sort()
          .join(',');
      const liveItems = sig(
        db.all('SELECT product_id, variant_id, quantity FROM cart_items WHERE cart_id = ?', [
          input.cart.id,
        ]),
        'product_id',
        'variant_id',
        'quantity'
      );
      const orderedItems = sig(
        input.lines.map(l => ({
          product_id: l.productId,
          variant_id: l.variantId,
          quantity: l.quantity,
        })),
        'product_id',
        'variant_id',
        'quantity'
      );
      const liveBoxes = sig(
        db.all('SELECT bundle_id, quantity FROM cart_bundles WHERE cart_id = ?', [input.cart.id]),
        'bundle_id',
        'quantity'
      );
      const orderedBoxes = sig(
        (input.bundles ?? []).map(b => ({ bundle_id: b.bundleId, quantity: b.quantity })),
        'bundle_id',
        'quantity'
      );
      if (!owned || liveItems !== orderedItems || liveBoxes !== orderedBoxes)
        throw new MoneyError(
          'CART_CHANGED',
          'The cart changed or was already checked out. Review it and try again.',
          409
        );
      // counted above, deleted here: the section is single-writer, so nothing slips between the two
      db.run('DELETE FROM cart_items WHERE cart_id = ?', [input.cart.id]);
      db.run('DELETE FROM cart_bundles WHERE cart_id = ?', [input.cart.id]);
      cartCustomerId = (owned!.customer_id as string | null) ?? null;
    }

    // `customerId` is the shopper's platform users.id (Ruling CF-FIX-2): the identity lives on the platform, the Worker
    // authenticated it, and the DO has no users table. It is NOT a CRM `customers.id`, so there is nothing to look up here.
    if (
      input.customerId !== undefined &&
      (typeof input.customerId !== 'string' || !input.customerId)
    )
      throw new MoneyError('BAD_ARGS', 'customerId', 400);

    for (const l of input.lines) {
      if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 1000)
        throw new MoneyError('BAD_QUANTITY', 'quantity must be an integer from 1 to 1000', 400);
      const hasVariants =
        (db.all('SELECT count(*) AS n FROM product_variants WHERE product_id = ?', [l.productId])[0]
          .n as number) > 0;
      if (hasVariants && !l.variantId)
        throw new MoneyError('VARIANT_REQUIRED', 'choose a variant', 400, {
          productId: l.productId,
        });
      if (!hasVariants && l.variantId)
        throw new MoneyError('VARIANT_UNAVAILABLE', 'this product has no variants', 409);
    }

    // ---- 1. price the cart from the rows (tiers, group price, wholesale audience), MOQ, bundles --------------------
    const orderId = crypto.randomUUID();
    const priced = input.lines.length
      ? resolveCartPrices(db, {
          storeId: input.storeId,
          buyer,
          wholesaleEntitled: input.wholesaleEntitled === true,
          lines: input.lines.map((l, i) => ({
            key: String(i),
            productId: l.productId,
            variantId: l.variantId ?? null,
            qty: l.quantity,
          })),
        })
      : {
          lines: [],
          byKey: new Map(),
          priceGroupName: null,
          groupPriceApplied: false,
          looseSubtotal: 0,
          couponBasisSubtotal: 0,
        };
    assertMoqSatisfied(priced.lines);
    const bundles = resolveBundles(db, {
      storeId: input.storeId,
      bundles: input.bundles ?? [],
      now,
    });

    // ---- 2. gold-rate lines: re-derive from the CURRENT rate, refuse a stale quote ------------------------------------
    const goldLines: GoldGateLine[] = [];
    for (const [i, l] of priced.lines.entries()) {
      const p = db.all('SELECT pricing_mode FROM products WHERE id = ? AND store_id = ?', [
        l.productId,
        input.storeId,
      ])[0];
      const v = l.variantId
        ? db.all('SELECT pricing_mode FROM product_variants WHERE id = ?', [l.variantId])[0]
        : undefined;
      const mode =
        (v?.pricing_mode as string | null | undefined) ?? (p?.pricing_mode as string | undefined);
      if (mode === 'gold_rate')
        goldLines.push({
          key: l.key,
          productId: l.productId,
          variantId: l.variantId,
          materialisedUnitPrice: l.resolved.listMinor,
          quotedUnitPrice: input.lines[i].quotedUnitPrice ?? null,
        });
    }
    const gold = goldLines.length
      ? assertGoldLinesPriceable(db, input.storeId, goldLines, {
          requireQuote: input.goldRequireQuote !== false,
          now,
        })
      : null;

    // ---- 3. stock: loose lines then bundle components, one conditional statement each --------------------------------
    const lines: OrderLine[] = [];
    const backorders: {
      lineIndex: number;
      productId: string;
      variantId: string | null;
      qty: number;
      stockTaken: number;
    }[] = [];
    const take = (productId: string, variantId: string | null, qty: number, lineIndex: number) => {
      if (input.dryRun) return; // a quote reserves nothing
      const p = db.all(
        'SELECT track_inventory, allow_backorder FROM products WHERE id = ? AND store_id = ?',
        [productId, input.storeId]
      )[0];
      if (!p || !p.track_inventory) return;
      if (variantId) {
        const v = db.all(
          'SELECT allow_backorder FROM product_variants WHERE id = ? AND product_id = ?',
          [variantId, productId]
        )[0];
        const r = decrementVariant(db, variantId, qty);
        if (r.ok)
          return void recordMovement(db, {
            storeId: input.storeId,
            productId,
            type: 'sale',
            quantity: -qty,
            previousStock: r.previousStock,
            newStock: r.newStock,
            reference: orderId,
            reason: 'Sold via order',
          });
        // a variant inherits the product's backorder flag (lineAllowsBackorder), and the store feature must be on
        if (input.backorderEnabled === true && (v?.allow_backorder || p.allow_backorder)) {
          const f = forceDecrementVariant(db, variantId, qty);
          recordMovement(db, {
            storeId: input.storeId,
            productId,
            type: 'sale',
            quantity: f.newStock - f.previousStock,
            previousStock: f.previousStock,
            newStock: f.newStock,
            reference: orderId,
            reason: 'backorder',
          });
          backorders.push({
            lineIndex,
            productId,
            variantId,
            qty,
            stockTaken: f.previousStock - f.newStock,
          });
          return;
        }
        throw new MoneyError('OUT_OF_STOCK', 'not enough stock', 409, {
          productId,
          variantId,
          available: r.newStock,
        });
      }
      let r = decrementProduct(db, productId, qty);
      if (!r.ok) {
        // backorder on a product WITHOUT variants: both the store feature and the product flag; the stock goes negative
        // (a real backorder debt, unlike a variant row which floors at 0) and the whole quantity counts as taken
        if (input.backorderEnabled !== true || !p.allow_backorder)
          throw new MoneyError('OUT_OF_STOCK', 'not enough stock', 409, {
            productId,
            available: r.newStock,
          });
        const cur = db.all('SELECT inventory FROM products WHERE id = ? AND store_id = ?', [
          productId,
          input.storeId,
        ])[0].inventory as number;
        db.run('UPDATE products SET inventory = ?1 WHERE id = ?2 AND store_id = ?3', [
          cur - qty,
          productId,
          input.storeId,
        ]);
        r = { ok: true, previousStock: cur, newStock: cur - qty };
        backorders.push({ lineIndex, productId, variantId: null, qty, stockTaken: qty });
        recordMovement(db, {
          storeId: input.storeId,
          productId,
          type: 'sale',
          quantity: -qty,
          previousStock: r.previousStock,
          newStock: r.newStock,
          reference: orderId,
          reason: 'backorder',
        });
        return;
      }
      recordMovement(db, {
        storeId: input.storeId,
        productId,
        type: 'sale',
        quantity: -qty,
        previousStock: r.previousStock,
        newStock: r.newStock,
        reference: orderId,
        reason: 'Sold via order',
      });
    };
    const costOf = (productId: string, variantId: string | null): number | null => {
      const v = variantId
        ? (db.all('SELECT cost_price FROM product_variants WHERE id = ?', [variantId])[0]
            ?.cost_price as number | null | undefined)
        : undefined;
      return (
        v ??
        (db.all('SELECT cost_price FROM products WHERE id = ? AND store_id = ?', [
          productId,
          input.storeId,
        ])[0]?.cost_price as number | null | undefined) ??
        null
      );
    };
    for (const l of priced.lines) {
      const prod = db.all('SELECT name, sku FROM products WHERE id = ? AND store_id = ?', [
        l.productId,
        input.storeId,
      ])[0];
      const v = l.variantId
        ? db.all('SELECT title, title_ar, sku FROM product_variants WHERE id = ?', [l.variantId])[0]
        : undefined;
      // the gate VALIDATES (stale rate, drift, quote) and supplies the snapshot; the charged price is the resolver's, so a
      // group percent_off applies to gold exactly as in Postgres (order.service.ts:987-1016)
      const unit = l.resolved.unitMinor;
      take(l.productId, l.variantId, l.qty, lines.length);
      lines.push({
        productId: l.productId,
        variantId: l.variantId,
        name: prod.name as string,
        variantName: (v?.title as string | undefined) ?? null,
        variantNameAr: (v?.title_ar as string | null | undefined) ?? null,
        sku: (v?.sku as string | null | undefined) ?? (prod.sku as string | null) ?? null,
        qty: l.qty,
        price: unit,
        costPrice: costOf(l.productId, l.variantId),
        snapshot: l.snapshot as OrderLine['snapshot'],
        goldSnapshot: gold?.snapshotJson.get(l.key),
        personalisation: input.lines[Number(l.key)]?.note ?? null,
      });
    }
    for (const box of bundles.boxes) {
      const groupId = crypto.randomUUID();
      for (const c of box.components) {
        const qty = c.quantity * box.quantity;
        if (c.trackInventory) take(c.productId, c.variantId, qty, lines.length);
        const prod = db.all('SELECT name, sku FROM products WHERE id = ? AND store_id = ?', [
          c.productId,
          input.storeId,
        ])[0];
        lines.push({
          productId: c.productId,
          variantId: c.variantId,
          name: (prod?.name as string) ?? '',
          variantName: null,
          variantNameAr: null,
          sku: (prod?.sku as string | null) ?? null,
          qty,
          price: c.unitAllocated,
          costPrice: costOf(c.productId, c.variantId),
          bundle: { bundleId: box.bundleId, groupId, name: box.name, nameAr: box.nameAr },
        });
      }
    }

    const looseSubtotal = priced.looseSubtotal;
    const subtotal = looseSubtotal + bundles.bundlesSubtotal;
    if (subtotal > MAX_TOTAL) throw new MoneyError('TOTAL_TOO_LARGE', 'order total too large', 400);

    // minimum order value (store setting)
    const settings = (() => {
      try {
        return JSON.parse(
          String(
            db.all('SELECT settings FROM store_config WHERE store_id = ?', [input.storeId])[0]
              ?.settings ?? '{}'
          )
        ) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    // Ruling SHARIA-GOLD-1 (the Postgres twin is assertGoldPaymentAllowed): gold is prepaid online unless the merchant allowed COD / installments.
    if (
      !checkGoldPayment({
        hasGold: gold !== null,
        allowDeferred: goldAllowsDeferredPayment(settings),
        provider: input.paymentMethod,
      }).ok
    )
      throw new MoneyError(GOLD_PREPAID_ERROR_CODE, GOLD_PREPAID_MESSAGE.en, 409);
    const minOrder = typeof settings.minimumOrderFils === 'number' ? settings.minimumOrderFils : 0;
    if (minOrder > 0 && subtotal < minOrder)
      throw new MoneyError(
        'MINIMUM_ORDER_NOT_MET',
        `minimum order value of ${minOrder} piastres not met`,
        400
      );

    // ---- 4. shipping from the zone / area rates (never from the client) ------------------------------------------------
    const addr = input.shippingAddress as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const area = str(addr.area) || str(addr.governorate) || str(addr.city) || str(addr.state);
    const governorate = str(addr.governorate) || undefined;
    let shipping = 0;
    const quote = calculateShipping(db, input.storeId, area, subtotal, governorate);
    if (!quote.matched && quote.storeHasAreaRates)
      throw new MoneyError(
        'AREA_NOT_DELIVERABLE',
        'Delivery is not available for the selected area',
        400
      );
    shipping = quote.freeShipping ? 0 : quote.shippingCost;

    // ---- 5. coupon (targeting, per-customer limit by phone/email) and promotions (best-of, never stacked) --------------
    const cartItems = cartItemsForTargeting(db, input.storeId, priced);
    let appliedCoupon: Record<string, unknown> | undefined;
    let couponValueDiscount = 0;
    let couponEval: { matchingSubtotal: number } | undefined;
    if (input.couponCode) {
      const c = db.all(
        'SELECT id, code, type, value, min_order_amount, max_discount, usage_limit, usage_limit_per_user, is_active, starts_at, expires_at, customer_group_id, first_order_only, min_quantity, scope_product_ids, scope_category_ids FROM coupons WHERE store_id = ? AND code = ? COLLATE NOCASE',
        [input.storeId, input.couponCode]
      )[0];
      if (!c || !c.is_active) throw new MoneyError('COUPON_INVALID', 'coupon is not valid', 409);
      // QA-COUPON-1: parity with CouponService.getByCode, a percentage/fixed coupon with no value is refused, never "applied".
      if (c.type !== 'free_shipping' && !((c.value as number) > 0))
        throw new MoneyError('COUPON_INVALID', 'coupon has no discount value', 409);
      if (
        (c.starts_at !== null && (c.starts_at as number) > now) ||
        (c.expires_at !== null && (c.expires_at as number) <= now)
      )
        throw new MoneyError('COUPON_EXPIRED', 'coupon is outside its dates', 409);
      const freeShip = c.type === 'free_shipping';
      const basis = freeShip ? priced.looseSubtotal : priced.couponBasisSubtotal;
      if (c.min_order_amount && basis < (c.min_order_amount as number))
        throw new MoneyError('MIN_ORDER_NOT_MET', 'order is below the coupon minimum', 400);
      const idCtx = { customerId: input.customerId ?? null, phone: who.phone, email: who.email };
      const ids = resolveCustomerCtx(db, input.storeId, idCtx, buyer);
      const t = matchesTargeting(
        {
          customerGroupId: (c.customer_group_id as string | null) ?? null,
          firstOrderOnly: !!c.first_order_only,
          minOrderAmount: null,
          minQuantity: (c.min_quantity as number | null) ?? null,
          scopeProductIds: jsonList(c.scope_product_ids),
          scopeCategoryIds: jsonList(c.scope_category_ids),
        },
        {
          ...ids,
          cartItems: freeShip ? cartItemsForTargeting(db, input.storeId, priced, true) : cartItems,
        }
      );
      if (!t.eligible)
        throw new MoneyError(
          'COUPON_NOT_ELIGIBLE',
          'coupon does not apply to this cart or customer',
          409
        );
      appliedCoupon = c;
      couponEval = t;
      if (freeShip) shipping = 0;
      else
        couponValueDiscount = Math.max(
          0,
          computeDiscount(
            c.type as 'percentage' | 'fixed',
            c.value as number,
            (c.max_discount as number | null) ?? null,
            t.matchingSubtotal
          )
        );
    }
    const promo = resolvePromotions(db, {
      storeId: input.storeId,
      buyer,
      customerId: input.customerId ?? null,
      phone: who.phone,
      email: who.email,
      cartItems,
      couponDiscount: couponValueDiscount,
      couponType:
        (appliedCoupon?.type as 'percentage' | 'fixed' | 'free_shipping' | undefined) ?? null,
      now,
    });
    const primaryDiscount = Math.min(promo.primaryDiscount, subtotal);
    void couponEval;

    // per-customer limit + the claim of ONE redemption, only when the coupon actually applies
    let couponCode: string | null = null;
    if (appliedCoupon && promo.couponApplied) {
      const c = appliedCoupon;
      const identityWhere = input.customerId
        ? 'customer_id = ?'
        : `((? IS NOT NULL AND json_extract(shipping_address, '$.phone') = ?) OR (? IS NOT NULL AND lower(json_extract(shipping_address, '$.email')) = ?))`;
      const identityParams = input.customerId
        ? [input.customerId]
        : [who.phone, who.phone, who.email, who.email];
      const hasIdentity = !!(input.customerId || who.phone || who.email);
      const perUser = (c.usage_limit_per_user as number | null) || 0;
      if (perUser > 0) {
        if (!hasIdentity)
          throw new MoneyError(
            'COUPON_NEEDS_CONTACT',
            'this coupon is limited per customer: a phone number or email is required',
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
      couponCode = c.code as string;
    }

    // ---- 6. loyalty redemption quote (the debit is written after the order row exists) ---------------------------------
    let loyaltyPoints = 0;
    let loyaltyDiscount = 0;
    if (input.customerId && typeof input.pointsToRedeem === 'number' && input.pointsToRedeem > 0) {
      const redeemable = Math.max(
        0,
        subtotal - (priced.looseSubtotal - priced.couponBasisSubtotal) - primaryDiscount
      );
      const q = quoteRedemption(db, {
        storeId: input.storeId,
        customerId: input.customerId,
        requestedPoints: input.pointsToRedeem,
        subtotal: redeemable,
        featureEnabled: input.loyaltyFeatureEnabled === true,
      });
      if (q.applied) {
        loyaltyPoints = q.pointsToRedeem;
        loyaltyDiscount = q.discountFils;
      }
    }

    // ---- 7. COD fee, tax, total ---------------------------------------------------------------------------------------
    const discount = primaryDiscount + loyaltyDiscount;
    const codFee = codFeeForCheckout(db, input.storeId, input.paymentMethod, {
      subtotal,
      discount,
      shipping,
    });
    const taxFields = computeOrderTaxFields(db, input.storeId, {
      subtotal,
      discount,
      shipping,
      codFee,
    });
    const total = taxFields.total;
    if (total < 0) throw new MoneyError('NEGATIVE_TOTAL', 'order total cannot be negative', 500);
    if (total > MAX_TOTAL) throw new MoneyError('TOTAL_TOO_LARGE', 'order total too large', 400);
    if (input.dryRun)
      throw new QuoteSignal({
        subtotal,
        discount,
        shipping,
        codFee,
        tax: taxFields.tax,
        total,
        taxIncludedInPrice: taxFields.taxIncludedInPrice === 1,
        lines: priced.lines.map((l, index) => ({
          index,
          productId: l.productId,
          quantity: l.qty,
          unitPrice: l.resolved.unitMinor,
          lineTotal: l.resolved.unitMinor * l.qty,
          listPrice: l.resolved.listMinor,
          priceSource: l.resolved.source,
          priceTierMinQty: l.resolved.tierMinQty,
        })),
      });
    if (input.expectedTotal !== undefined && input.expectedTotal !== total)
      throw new MoneyError(
        'PRICE_CHANGED',
        'the total changed since the shopper last saw it',
        409,
        { expected: input.expectedTotal, actual: total }
      );

    // ---- 8. wallet: one conditional debit, capped to the total ---------------------------------------------------------
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
    const fullyWalletPaid = walletAmount > 0 && walletAmount >= total;

    // ---- 9. stock-hold cap from the FINAL payment state (a token wallet amount buys no exemption) -----------------------
    if (!fullyWalletPaid && (who.phone || who.email || input.checkoutIp)) {
      const manual = MANUAL.has(input.paymentMethod ?? 'cod');
      const cap = manual ? (input.holdCaps?.manual ?? 2) : (input.holdCaps?.gateway ?? 5);
      const ipCap = input.holdCaps?.ip ?? 40;
      const ipWindowMs = (input.holdCaps?.ipWindowHours ?? 24) * 3_600_000;
      if (who.phone || who.email) {
        const n = db.all(
          `SELECT count(*) AS n FROM orders WHERE store_id = ? AND ${OPEN} AND ((? IS NOT NULL AND json_extract(shipping_address, '$.phone') = ?) OR (? IS NOT NULL AND lower(json_extract(shipping_address, '$.email')) = ?))`,
          [input.storeId, who.phone, who.phone, who.email, who.email]
        )[0].n as number;
        if (n >= cap)
          throw new MoneyError('TOO_MANY_OPEN_ORDERS', 'too many unpaid open orders', 429);
      }
      if (input.checkoutIp) {
        const n = db.all(
          `SELECT count(*) AS n FROM orders WHERE store_id = ? AND ${OPEN} AND checkout_ip = ? AND created_at >= ?`,
          [input.storeId, input.checkoutIp, now - ipWindowMs]
        )[0].n as number;
        if (n >= ipCap)
          throw new MoneyError('TOO_MANY_OPEN_ORDERS', 'too many unpaid open orders', 429);
      }
    }

    // ---- 10. rows ------------------------------------------------------------------------------------------------------
    const num = orderNumber(now);
    const paymentStatus = fullyWalletPaid ? 'paid' : 'unpaid';
    db.run(
      `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, tax, tax_included_in_price, tax_rate_bps, taxable_amount, seller_tax_registration_number, seller_tax_legal_name, price_group_name, shipping, discount, cod_fee, total, currency, coupon_code, coupon_discount, promotion_discount, applied_promotion_id, bundle_discount, loyalty_points_redeemed, loyalty_discount, wallet_amount, customer_notes, shipping_address, billing_address, checkout_ip, idempotency_key, manual_hold_admitted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        input.storeId,
        input.customerId ?? null,
        num,
        fullyWalletPaid ? 'confirmed' : 'pending',
        paymentStatus,
        subtotal,
        taxFields.tax,
        taxFields.taxIncludedInPrice,
        taxFields.taxRateBps,
        taxFields.taxableAmount,
        taxFields.sellerTaxRegistrationNumber,
        taxFields.sellerTaxLegalName,
        priced.groupPriceApplied ? priced.priceGroupName : null,
        shipping,
        discount,
        codFee,
        total,
        input.currency ?? 'EGP',
        couponCode,
        promo.couponDiscount,
        promo.promotionDiscount,
        promo.appliedPromotionId,
        bundles.bundleDiscount,
        loyaltyPoints > 0 ? loyaltyPoints : null,
        loyaltyDiscount,
        walletAmount,
        input.customerNotes ?? null,
        JSON.stringify(shippingAddress),
        JSON.stringify(input.billingAddress ?? shippingAddress),
        input.checkoutIp ?? null,
        idemKey ?? null,
        !fullyWalletPaid && MANUAL.has(input.paymentMethod ?? '') ? 1 : 0,
        now,
        now,
      ]
    );
    const itemIds: string[] = [];
    for (const it of lines) {
      const itemId = crypto.randomUUID();
      itemIds.push(itemId);
      db.run(
        'INSERT INTO order_items (id, order_id, product_id, variant_id, product_name, variant_name, variant_name_ar, sku, quantity, price, cost_price, total, list_price, price_source, price_tier_min_qty, price_group_applied, tier_ladder, gold_snapshot, bundle_id, bundle_group_id, bundle_name, bundle_name_ar, personalisation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          itemId,
          orderId,
          it.productId,
          it.variantId,
          it.name,
          it.variantName,
          it.variantNameAr,
          it.sku,
          it.qty,
          it.price,
          it.costPrice,
          it.price * it.qty,
          it.snapshot?.listPrice ?? null,
          it.snapshot?.priceSource ?? null,
          it.snapshot?.priceTierMinQty ?? null,
          it.snapshot?.priceGroupApplied ? 1 : 0,
          it.snapshot?.tierLadder ? JSON.stringify(it.snapshot.tierLadder) : null,
          it.goldSnapshot ?? null,
          it.bundle?.bundleId ?? null,
          it.bundle?.groupId ?? null,
          it.bundle?.name ?? null,
          it.bundle?.nameAr ?? null,
          it.personalisation ?? null,
        ]
      );
    }
    for (const b of backorders) {
      db.run('UPDATE order_items SET cost_price_deferred = 1 WHERE id = ?', [itemIds[b.lineIndex]]);
      db.run(
        'INSERT INTO backorder_lines (id, store_id, order_item_id, product_id, variant_id, qty, stock_taken) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          crypto.randomUUID(),
          input.storeId,
          itemIds[b.lineIndex],
          b.productId,
          b.variantId,
          b.qty,
          b.stockTaken,
        ]
      );
    }
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
    if (loyaltyPoints > 0 && input.customerId)
      redeemPoints(db, {
        storeId: input.storeId,
        customerId: input.customerId,
        orderId,
        points: loyaltyPoints,
        featureEnabled: input.loyaltyFeatureEnabled === true,
        now,
      });
    // entity index (audit DB-2): queued in the SAME section as the order; `StoreDO.moneyOp` writes it to D1 (awaitEntityIndexed)
    // before it answers, and refuses 503 when a keyed checkout's row did not land (Ruling NZ-MONEY-2)
    indexEntity(db, input.storeId, 'order', orderId, now);
    // The sale's fiscal document (tax invoice or receipt) with its gapless serial, in THIS section: the order and its number
    // commit or roll back together (Ruling MONEYB-1, CF-R2-1).
    issueSaleDocument(db, { storeId: input.storeId, orderId, now });
    // Abandoned-cart recovery (best effort on Postgres, a plain UPDATE here): the cart's own row, else the same customer's open
    // one. A guest cart (no customer) matches only its own row.
    if (input.cart)
      db.run(
        `UPDATE abandoned_carts SET status = 'recovered', recovered_at = ?1, recovered_order_id = ?2, updated_at = ?1
         WHERE id = (SELECT id FROM abandoned_carts WHERE store_id = ?3 AND status IN ('pending', 'step1_sent', 'step2_sent', 'step3_sent')
           AND (cart_id = ?4 OR (?5 IS NOT NULL AND customer_id = ?5)) ORDER BY (cart_id = ?4) DESC, created_at LIMIT 1)`,
        [now, orderId, input.storeId, input.cart.id, cartCustomerId]
      );
    return {
      orderId,
      orderNumber: num,
      subtotal,
      discount,
      couponDiscount: promo.couponDiscount,
      promotionDiscount: promo.promotionDiscount,
      bundleDiscount: bundles.bundleDiscount,
      loyaltyDiscount,
      shipping,
      codFee,
      tax: taxFields.tax,
      walletAmount,
      total,
      paymentStatus,
      replayed: false,
    };
  });
}

import { resolveCustomerContext as resolveCustomerCtx } from './promotions';
