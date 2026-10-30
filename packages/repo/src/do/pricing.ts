/**
 * DO port of apps/api/src/services/price-resolver.service.ts (B2B tiers, group pricing, wholesale audience, MOQ).
 * PURE SYNCHRONOUS: every function takes `db: SyncSql`, nothing awaits, so it can run INSIDE checkout's single
 * `transactionSync` (the entitlement and the group are therefore read atomically with the order write, which is the
 * "uncached entitlement inside the order transaction" requirement, review I2).
 *
 * The tier / group maths is NOT re-implemented: it imports the Postgres original's pure `resolveUnitPrice`
 * (packages/shared/src/pricing, zero imports) so rounding (exact integer round-half-up, no float) and precedence
 * (Rulings B2B-3b, B2B-4, B2B-5) are the same code, not a copy. This file ports only the DATA LOADING.
 *
 * TRUST BOUNDARY: `buyer` and `wholesaleEntitled` come from the store Worker, never from a request body.
 *   - `session.userId` is the VERIFIED customer session. The DO has no users table (platform database), so the
 *     "user is an active customer-role account" test of the Postgres loader is the caller's: it mints a `session`
 *     buyer only for such an account. A price is granted ONLY through `customers.user_id` (Ruling B2B-2c), never by
 *     a typed phone or email: there is no input here that takes one.
 *   - `wholesaleEntitled` is the `b2b.wholesale` plan feature read UNCACHED by the caller (Ruling B2B-1b). Anything
 *     but literal `true` drops tiers and group pricing (fail closed). MOQ and wholesale-only visibility are
 *     restrictions and survive a downgrade, so they never depend on it.
 *
 * NOT PORTED / DIFFERENCES (see RULINGS DO-MONEY-2):
 *   - wholesale visibility = Postgres `canSeeWholesaleOnly`: the buyer's group is wholesale AND active, reached via
 *     customers.user_id. `wholesale_applications` is not consulted: approve() writes the group link (linkApprovedBuyer)
 *     and revoke removes it, so the group IS the approval. Adding a second source would deny buyers Postgres allows.
 *   - a corrupt price/tier/moq row throws MoneyError PRICE_DATA_CORRUPT (500) instead of a RangeError.
 *   - gold-rate pricing is a separate gate (not ported).
 */
import { MoneyError, type SyncSql } from './sync-sql';
import {
  resolveUnitPrice,
  type BuyerGroup,
  type PriceTierRow,
  type Resolved,
} from '../../../shared/src/pricing/resolve-unit-price';

export type { Resolved, PriceTierRow, BuyerGroup };

export type Buyer =
  | { kind: 'anonymous' }
  | { kind: 'session'; userId: string }
  /** a merchant staff session picked a Customer (CRM row) BY ID (Ruling B2B-2d), or a registered shopper by users.id (CF-FIX-2). */
  | { kind: 'merchant-selected'; customerId?: string; shopperUserId?: string };

export const ANONYMOUS: Buyer = { kind: 'anonymous' };

export interface PriceLineInput {
  /** caller's key, unique within one call */
  key: string;
  productId: string;
  variantId?: string | null;
  qty: number;
}

export interface PricingCtx {
  storeId: string;
  buyer: Buyer;
  /** `b2b.wholesale` read uncached by the caller; only literal `true` enables tiers and group prices. */
  wholesaleEntitled: boolean;
  lines: readonly PriceLineInput[];
}

export interface PricedLine {
  key: string;
  productId: string;
  variantId: string | null;
  qty: number;
  /** product name, for BELOW_MOQ messages */
  name: string;
  nameAr: string | null;
  resolved: Resolved;
  /** the fields checkout stores on order_items (Postgres `priceSnapshot`). */
  snapshot: ReturnType<typeof priceSnapshot>;
  /** true when the line may feed coupon / promotion bases (Ruling B2B-5: only base-priced lines). */
  couponEligible: boolean;
}

export interface PricedCart {
  lines: PricedLine[];
  byKey: Map<string, PricedLine>;
  /** name of the buyer's group when a group price applied to any line (orders.price_group_name), else null. */
  priceGroupName: string | null;
  groupPriceApplied: boolean;
  /** Σ unit × qty over every line */
  looseSubtotal: number;
  /** same, base-priced lines only: the coupon / promotion / loyalty base */
  couponBasisSubtotal: number;
}

export interface BuyerGroupRow extends BuyerGroup {
  name: string;
  isWholesale: boolean;
}

const MAX_QTY = 1_000_000;
const ID_MAX = 200;
const INT4_MAX = 2_147_483_647;

function id(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > ID_MAX)
    throw new MoneyError('BAD_ID', `${name} must be a non-empty string`, 400);
  return v;
}
function qtyOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_QTY)
    throw new MoneyError('BAD_QUANTITY', `quantity must be an integer from 1 to ${MAX_QTY}`, 400);
  return v;
}
function dbInt(v: unknown, name: string, min: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > INT4_MAX)
    throw new MoneyError('PRICE_DATA_CORRUPT', `${name} is not a valid stored amount`, 500);
  return v;
}

/**
 * The buyer's group, or null. Port of `loadBuyerGroup`: session -> customers.user_id; merchant pick -> customers.id;
 * the group must belong to THIS store and have a known pricing mode (inactive groups are returned with isActive=false,
 * and the pure resolver treats them as retail).
 */
export function loadBuyerGroup(db: SyncSql, storeId: string, buyer: Buyer): BuyerGroupRow | null {
  id(storeId, 'storeId');
  let customerSql: string;
  let param: string;
  if (buyer.kind === 'session') {
    customerSql = 'c.user_id = ?';
    param = id(buyer.userId, 'userId');
  } else if (buyer.kind === 'merchant-selected') {
    // a CRM row picked by id, or a registered shopper (users.id) the merchant picked: that shopper's group is read through
    // customers.user_id exactly as for their own session (Ruling CF-FIX-2)
    if (buyer.customerId) {
      customerSql = 'c.id = ?';
      param = id(buyer.customerId, 'customerId');
    } else {
      customerSql = 'c.user_id = ?';
      param = id(buyer.shopperUserId, 'shopperUserId');
    }
  } else if (buyer.kind === 'anonymous') {
    return null;
  } else {
    return null; // unknown kind: fail closed to retail
  }
  const r = db.all(
    `SELECT g.id, g.name, g.store_id, g.is_wholesale, g.pricing_mode, g.discount_bps, g.is_active
       FROM customers c JOIN customer_groups g ON g.id = c.group_id
      WHERE c.store_id = ? AND c.group_id IS NOT NULL AND ${customerSql}
      ORDER BY c.id LIMIT 1`,
    [storeId, param]
  )[0];
  if (!r || r.store_id !== storeId) return null;
  if (r.pricing_mode !== 'none' && r.pricing_mode !== 'percent_off') return null;
  return {
    id: r.id as string,
    name: r.name as string,
    isWholesale: r.is_wholesale === 1,
    pricingMode: r.pricing_mode,
    discountBps: dbInt(r.discount_bps, 'discount_bps', 0),
    isActive: r.is_active === 1,
  };
}

/** True for a buyer in an ACTIVE wholesale group. Anonymous buyers are never members. */
export function canSeeWholesaleOnly(db: SyncSql, storeId: string, buyer: Buyer): boolean {
  if (buyer.kind === 'anonymous') return false;
  const g = loadBuyerGroup(db, storeId, buyer);
  return !!g && g.isWholesale && g.isActive;
}

/** Port of `priceSnapshot` (lib/order-pricing.ts): the order_items price columns. */
export function priceSnapshot(r: Resolved) {
  return {
    listPrice: r.listMinor,
    priceSource: r.source,
    priceTierMinQty: r.tierMinQty,
    priceGroupApplied: r.groupApplied,
    tierLadder:
      r.ladder.length > 0
        ? { rungs: r.ladder.map(x => ({ ...x })), groupPercentMinor: r.groupPercentMinor }
        : undefined,
  };
}

/** Port of `eligibleForCoupon`: a tier- or group-priced line is excluded from coupon/promotion bases. */
export const eligibleForCoupon = (r: Resolved): boolean => r.source === 'base';

/**
 * Port of `assertMoqSatisfied`: throws BELOW_MOQ (422) listing every offending product once. The pure resolver reports
 * `belowMoq`; the refusal happens here, before any stock moves.
 */
export function assertMoqSatisfied(lines: readonly PricedLine[]): void {
  const productQty = new Map<string, number>();
  for (const l of lines) productQty.set(l.productId, (productQty.get(l.productId) ?? 0) + l.qty);
  const offending = new Map<
    string,
    { productId: string; name: string; nameAr: string | null; required: number; current: number }
  >();
  for (const l of lines) {
    if (l.resolved.belowMoq && l.resolved.moqRequired !== null && !offending.has(l.productId))
      offending.set(l.productId, {
        productId: l.productId,
        name: l.name,
        nameAr: l.nameAr,
        required: l.resolved.moqRequired,
        current: productQty.get(l.productId) ?? l.qty,
      });
  }
  if (offending.size === 0) return;
  const list = [...offending.values()];
  throw new MoneyError(
    'BELOW_MOQ',
    `Minimum order quantity not met: ${list.map(o => `${o.name} (min ${o.required})`).join(', ')}`,
    422,
    { lines: list }
  );
}

/**
 * Price a whole cart in one pass (port of `PriceResolver.priceCart` + the order-time audience gate): quantities are
 * summed per PRODUCT and per VARIANT across lines (Ruling B2B-4), tiers are loaded scoped to the store, and every
 * amount comes from the database, never from the caller. Throws:
 *   PRODUCT_UNAVAILABLE 409  unknown / deleted / non-active product, a variant that is not this product's, or a
 *                            wholesale-only product for a buyer who is not an active wholesale member (no oracle)
 *   BAD_QUANTITY / BAD_ID 400, PRICE_DATA_CORRUPT 500
 * MOQ is NOT enforced here (it is reported on `resolved.belowMoq` so a quote can show it): call `assertMoqSatisfied`.
 */
export function resolveCartPrices(db: SyncSql, ctx: PricingCtx): PricedCart {
  const storeId = id(ctx.storeId, 'storeId');
  if (!Array.isArray(ctx.lines) || ctx.lines.length === 0)
    throw new MoneyError('EMPTY_CART', 'at least one line is required', 400);

  const keys = new Set<string>();
  const productQty = new Map<string, number>();
  const variantQty = new Map<string, number>();
  const norm = ctx.lines.map(l => {
    const key = id(l.key, 'line key');
    if (keys.has(key)) throw new MoneyError('BAD_ID', `duplicate line key ${key}`, 400);
    keys.add(key);
    const productId = id(l.productId, 'productId');
    const variantId = l.variantId == null ? null : id(l.variantId, 'variantId');
    const qty = qtyOf(l.qty);
    productQty.set(productId, (productQty.get(productId) ?? 0) + qty);
    if (variantId) variantQty.set(variantId, (variantQty.get(variantId) ?? 0) + qty);
    return { key, productId, variantId, qty };
  });

  const unavailable = (productId: string) =>
    new MoneyError('PRODUCT_UNAVAILABLE', 'a product in the cart is not available', 409, {
      productId,
    });

  const products = new Map<string, Record<string, unknown>>();
  const variants = new Map<string, Record<string, unknown>>();
  for (const l of norm) {
    if (!products.has(l.productId)) {
      const p = db.all(
        'SELECT id, name, name_ar, price, moq, audience, status, deleted_at FROM products WHERE id = ? AND store_id = ?',
        [l.productId, storeId]
      )[0];
      if (!p || p.deleted_at !== null || p.status !== 'active') throw unavailable(l.productId);
      products.set(l.productId, p);
    }
    if (l.variantId && !variants.has(l.variantId)) {
      const v = db.all(
        'SELECT id, product_id, price, is_active FROM product_variants WHERE id = ?',
        [l.variantId]
      )[0];
      if (!v || v.product_id !== l.productId) throw unavailable(l.productId);
      if (v.is_active !== 1)
        throw new MoneyError('VARIANT_INACTIVE', 'this variant is not available', 409, {
          variantId: l.variantId,
        });
      variants.set(l.variantId, v);
    }
    if (l.variantId && variants.get(l.variantId)!.product_id !== l.productId)
      throw unavailable(l.productId);
  }

  // Wholesale-only visibility: a RESTRICTION, independent of the plan entitlement (Ruling B2B-1b / B2B-7b).
  const group = loadBuyerGroup(db, storeId, ctx.buyer);
  const wholesaleOnly = [...products.values()].filter(p => p.audience === 'wholesale_only');
  if (wholesaleOnly.length > 0 && !(group !== null && group.isWholesale && group.isActive))
    throw new MoneyError('PRODUCT_UNAVAILABLE', 'a product in the cart is not available', 409, {
      productIds: wholesaleOnly.map(p => p.id),
    });
  for (const p of products.values())
    if (p.audience !== 'public' && p.audience !== 'wholesale_only')
      throw unavailable(p.id as string); // unknown audience: fail closed

  // Tiers and group pricing are plan benefits (dropped when not entitled); only literal true enables them.
  const on = ctx.wholesaleEntitled === true;
  const tiersByProduct = new Map<string, PriceTierRow[]>();
  if (on) {
    for (const pid of productQty.keys()) {
      const rows = db.all(
        'SELECT variant_id, group_id, min_qty, price_minor FROM product_price_tiers WHERE store_id = ? AND product_id = ? ORDER BY min_qty, price_minor, id',
        [storeId, pid]
      );
      tiersByProduct.set(
        pid,
        rows.map(r => ({
          variantId: (r.variant_id as string | null) ?? null,
          groupId: (r.group_id as string | null) ?? null,
          minQty: dbInt(r.min_qty, 'min_qty', 2),
          priceMinor: dbInt(r.price_minor, 'price_minor', 0),
        }))
      );
    }
  }

  const lines: PricedLine[] = norm.map(l => {
    const p = products.get(l.productId)!;
    const v = l.variantId ? variants.get(l.variantId)! : null;
    const productPrice = dbInt(p.price, 'price', 0);
    const variantPrice = v && v.price !== null ? dbInt(v.price, 'variant price', 0) : null;
    let resolved: Resolved;
    try {
      resolved = resolveUnitPrice({
        baseMinor: variantPrice ?? productPrice,
        productPriceMinor: productPrice,
        qty: productQty.get(l.productId)!,
        variantQty: l.variantId ? variantQty.get(l.variantId)! : undefined,
        variantId: l.variantId,
        buyerGroup: on ? group : null,
        tiers: on ? (tiersByProduct.get(l.productId) ?? []) : [],
        moq: p.moq === null ? null : dbInt(p.moq, 'moq', 1),
      });
    } catch (e) {
      if (e instanceof RangeError) throw new MoneyError('PRICE_DATA_CORRUPT', e.message, 500);
      throw e;
    }
    return {
      key: l.key,
      productId: l.productId,
      variantId: l.variantId,
      qty: l.qty,
      name: p.name as string,
      nameAr: (p.name_ar as string | null) ?? null,
      resolved,
      snapshot: priceSnapshot(resolved),
      couponEligible: eligibleForCoupon(resolved),
    };
  });

  let looseSubtotal = 0;
  let couponBasisSubtotal = 0;
  for (const l of lines) {
    const t = l.resolved.unitMinor * l.qty;
    looseSubtotal += t;
    if (l.couponEligible) couponBasisSubtotal += t;
  }
  const groupPriceApplied = lines.some(l => l.resolved.groupApplied);
  return {
    lines,
    byKey: new Map(lines.map(l => [l.key, l])),
    priceGroupName: groupPriceApplied && on ? (group?.name ?? null) : null,
    groupPriceApplied,
    looseSubtotal,
    couponBasisSubtotal,
  };
}

/** Price ONE line in isolation (qty = this line's quantity for both product and variant scope). */
export function resolveLinePrice(
  db: SyncSql,
  ctx: Omit<PricingCtx, 'lines'> & { line: Omit<PriceLineInput, 'key'> }
): Resolved {
  const { line, ...rest } = ctx;
  return resolveCartPrices(db, { ...rest, lines: [{ ...line, key: 'line' }] }).byKey.get('line')!
    .resolved;
}
