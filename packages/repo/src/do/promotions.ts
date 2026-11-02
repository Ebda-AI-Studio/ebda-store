/**
 * DO port of automatic promotions + bundles. PURE SYNCHRONOUS (`db: SyncSql`, no awaits) so it runs inside checkout's
 * single `transactionSync`.
 *
 * Ported from: apps/api/src/services/promotion-resolver.ts (resolveCustomerContext, resolveBestPromotion),
 * promotion-targeting.ts (matchesTargeting, computeDiscount: copied, `Math.round` kept, differential-tested against the
 * original in do-promotions.test.ts), order.service.ts ~1275-1305 (coupon vs promotion best-of, exact-tie rule),
 * bundle.service.ts (resolveBundle: purchasability, availability, price) and order.service.ts ~905-990 (allocation guard,
 * bundlesSubtotal, bundleDiscount). The bundle price/allocation maths is the shared package's own pure code
 * (packages/shared/src/bundle-pricing.ts), imported, not copied.
 *
 * TRUST BOUNDARY: `buyer`, `customerId`, `couponDiscount` and `now` come from the store Worker / checkout core, never a
 * request body. Cart amounts are the checkout core's own priced lines (base-priced loose lines only, Ruling B2B-5).
 *
 * DIFFERENCES FROM POSTGRES (fail-closed, see RULINGS DO-MONEY-2):
 *   - a promotion whose scope JSON is corrupt is SKIPPED (Postgres arrays cannot be corrupt; the old DO helper turned a
 *     corrupt scope into "no scope" = a wider discount).
 *   - a percentage promotion above 100 (impossible through the admin schema) cannot discount more than the matching base.
 *   - a session buyer without a `customerId` is resolved to its customers row by user_id for the first-order count
 *     (Postgres passes the users.id as customer_id, which never matches and so over-grants first-order promotions).
 *   - guest first-order matching compares the typed phone AND its E.164 normalisation (only ever REDUCES eligibility).
 *   - ties between promotions of equal discount: priority desc, then newest created_at, then id (Postgres leaves the
 *     last tie-break unspecified).
 *   - promotions whose customer-group target is set need the buyer's group: only a session / merchant-selected buyer
 *     has one (Ruling B2B-2c/2e), a guest never does.
 */
import { MoneyError, type SyncSql } from './sync-sql';
import { normalizePhoneForStorage } from '../../../shared/src/region';
import {
  allocateBundlePrice,
  computeBundlePrice,
  type AllocatedLine,
  type BundleLine,
  type BundlePricingType,
} from '../../../shared/src/bundle-pricing';
import { loadBuyerGroup, type Buyer, type PricedCart } from './pricing';

const ID_MAX = 200;
const INT4_MAX = 2_147_483_647;

const bad = (m: string) => new MoneyError('BAD_INPUT', m, 400);
function id(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > ID_MAX)
    throw bad(`${name} must be a non-empty string`);
  return v;
}
function nonNeg(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > INT4_MAX)
    throw bad(`${name} must be a non-negative integer`);
  return v;
}
function now(v: number | undefined): number {
  const n = v ?? Date.now();
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw bad('now must be epoch ms');
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// Targeting maths (copied from promotion-targeting.ts, keep in sync; differential-tested)
// ---------------------------------------------------------------------------------------------------------------------

export interface CartItemForTargeting {
  productId: string;
  categoryIds: string[];
  quantity: number;
  lineTotal: number;
}
export interface TargetingCtx {
  customerGroupId: string | null;
  isFirstOrder: boolean;
  cartItems: CartItemForTargeting[];
}
export interface Targeting {
  customerGroupId: string | null;
  firstOrderOnly: boolean;
  minOrderAmount: number | null;
  minQuantity: number | null;
  scopeProductIds: string[];
  scopeCategoryIds: string[];
}
export interface TargetingResult {
  eligible: boolean;
  matchingSubtotal: number;
  matchingQty: number;
}

export function matchesTargeting(t: Targeting, ctx: TargetingCtx): TargetingResult {
  const miss: TargetingResult = { eligible: false, matchingSubtotal: 0, matchingQty: 0 };
  if (t.customerGroupId && t.customerGroupId !== ctx.customerGroupId) return miss;
  if (t.firstOrderOnly && !ctx.isFirstOrder) return miss;
  const scoped = t.scopeProductIds.length > 0 || t.scopeCategoryIds.length > 0;
  const inScope = (i: CartItemForTargeting) =>
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
  type: 'percentage' | 'fixed' | 'free_shipping',
  value: number,
  maxDiscount: number | null,
  base: number
): number {
  if (type === 'percentage') {
    const d = Math.round((base * value) / 100);
    return maxDiscount != null && d > maxDiscount ? maxDiscount : d;
  }
  if (type === 'fixed') return value > base ? base : value;
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Customer context + best automatic promotion
// ---------------------------------------------------------------------------------------------------------------------

export interface CustomerIdentity {
  customerId?: string | null;
  /** typed shipping phone / email: used ONLY for the guest first-order count, never for group membership. */
  phone?: string | null;
  email?: string | null;
}

/** Port of `resolveCustomerContext`: group (from the buyer identity only) + first-order status. */
export function resolveCustomerContext(
  db: SyncSql,
  storeId: string,
  who: CustomerIdentity,
  buyer: Buyer
): { customerGroupId: string | null; isFirstOrder: boolean } {
  id(storeId, 'storeId');
  const group = loadBuyerGroup(db, storeId, buyer);
  const customerGroupId = group?.id ?? null;

  // `orders.customer_id` is the shopper's users.id (Ruling CF-FIX-2), so a session buyer's prior orders are counted by it
  // directly; the CRM row (its own id) is only the group link.
  let customerId = who.customerId ?? null;
  if (!customerId && buyer.kind === 'session') customerId = id(buyer.userId, 'userId');
  if (customerId) {
    const n = db.all(
      `SELECT count(*) AS n FROM orders WHERE store_id = ? AND customer_id = ? AND deleted_at IS NULL AND status <> 'cancelled'`,
      [storeId, id(customerId, 'customerId')]
    )[0].n as number;
    return { customerGroupId, isFirstOrder: n === 0 };
  }
  const phones = new Set<string>();
  if (who.phone) {
    phones.add(who.phone);
    const norm = normalizePhoneForStorage(who.phone);
    if (norm) phones.add(norm);
  }
  const emails = new Set<string>();
  if (who.email) {
    emails.add(who.email);
    emails.add(who.email.trim().toLowerCase());
  }
  if (phones.size === 0 && emails.size === 0) return { customerGroupId, isFirstOrder: true };
  const conds = [
    ...[...phones].map(() => `json_extract(shipping_address, '$.phone') = ?`),
    ...[...emails].map(() => `json_extract(shipping_address, '$.email') = ?`),
  ];
  const n = db.all(
    `SELECT count(*) AS n FROM orders WHERE store_id = ? AND deleted_at IS NULL AND status <> 'cancelled' AND (${conds.join(' OR ')})`,
    [storeId, ...phones, ...emails]
  )[0].n as number;
  return { customerGroupId, isFirstOrder: n === 0 };
}

/** Targeting cart snapshot (product + category ids, per-line totals) from the priced cart: base-priced lines only. */
export function cartItemsForTargeting(
  db: SyncSql,
  storeId: string,
  priced: PricedCart,
  /** every loose line, not only the coupon-eligible ones (free-shipping coupons judge the whole cart, Ruling B2B-M2) */
  allLines = false
): CartItemForTargeting[] {
  id(storeId, 'storeId');
  const catCache = new Map<string, string[]>();
  const cats = (productId: string) => {
    let c = catCache.get(productId);
    if (!c) {
      c = db
        .all(
          `SELECT pc.category_id AS c FROM product_categories pc JOIN products p ON p.id = pc.product_id
            WHERE pc.product_id = ? AND p.store_id = ? ORDER BY pc.category_id`,
          [productId, storeId]
        )
        .map(r => r.c as string);
      catCache.set(productId, c);
    }
    return c;
  };
  return priced.lines
    .filter(l => allLines || l.couponEligible)
    .map(l => ({
      productId: l.productId,
      categoryIds: cats(l.productId),
      quantity: l.qty,
      lineTotal: l.resolved.unitMinor * l.qty,
    }));
}

function strList(raw: unknown): string[] | null {
  try {
    const a = JSON.parse(String(raw));
    if (!Array.isArray(a) || !a.every(x => typeof x === 'string')) return null;
    return a as string[];
  } catch {
    return null;
  }
}

export interface BestPromotion {
  promotionId: string;
  discount: number;
}

/**
 * Port of `resolveBestPromotion`: the single largest eligible value-bearing promotion (percentage / fixed; free_shipping
 * is never resolved here), active and inside its [starts_at, expires_at] window (both inclusive). Ordered
 * priority desc, created_at desc, id; the strict `>` keeps the first (highest priority) winner on equal discounts.
 */
export function resolveBestPromotion(
  db: SyncSql,
  storeId: string,
  ctx: TargetingCtx,
  at?: number
): BestPromotion | null {
  id(storeId, 'storeId');
  const t = now(at);
  for (const i of ctx.cartItems) {
    nonNeg(i.quantity, 'quantity');
    nonNeg(i.lineTotal, 'lineTotal');
  }
  const promos = db.all(
    `SELECT * FROM promotions
      WHERE store_id = ? AND is_active = 1 AND type <> 'free_shipping'
        AND (starts_at IS NULL OR starts_at <= ?) AND (expires_at IS NULL OR expires_at >= ?)
      ORDER BY priority DESC, created_at DESC, id`,
    [storeId, t, t]
  );
  let best: BestPromotion | null = null;
  for (const p of promos) {
    const scopeProductIds = strList(p.scope_product_ids);
    const scopeCategoryIds = strList(p.scope_category_ids);
    if (scopeProductIds === null || scopeCategoryIds === null) continue; // corrupt scope: skip, never widen
    if (p.type !== 'percentage' && p.type !== 'fixed') continue;
    const r = matchesTargeting(
      {
        customerGroupId: (p.customer_group_id as string | null) ?? null,
        firstOrderOnly: p.first_order_only === 1,
        minOrderAmount: (p.min_order_amount as number | null) ?? null,
        minQuantity: (p.min_quantity as number | null) ?? null,
        scopeProductIds,
        scopeCategoryIds,
      },
      ctx
    );
    if (!r.eligible) continue;
    let discount = computeDiscount(
      p.type,
      p.value as number,
      (p.max_discount as number | null) ?? null,
      r.matchingSubtotal
    );
    discount = Math.min(discount, r.matchingSubtotal); // an out-of-range stored percentage cannot over-discount
    if (!Number.isFinite(discount) || discount <= 0) continue;
    if (!best || discount > best.discount) best = { promotionId: p.id as string, discount };
  }
  return best;
}

export interface PromotionsCtx extends CustomerIdentity {
  storeId: string;
  buyer: Buyer;
  /** base-priced loose lines (see `cartItemsForTargeting`) */
  cartItems: CartItemForTargeting[];
  /** the coupon's computed discount in piastres (0 = none; a free_shipping coupon passes 0 and couponType). */
  couponDiscount?: number;
  couponType?: 'percentage' | 'fixed' | 'free_shipping' | null;
  now?: number;
}
export interface PromotionsResult {
  /** best eligible promotion before the coupon comparison, or null */
  best: BestPromotion | null;
  /** the single discount that applies: max(coupon, promotion). They never stack. */
  primaryDiscount: number;
  /** orders.applied_promotion_id: set when the promotion matches-or-beats the coupon (EXACT TIE: the promotion wins). */
  appliedPromotionId: string | null;
  /** orders.promotion_discount: the promotion's discount when it applied, else 0. */
  promotionDiscount: number;
  /** whether the coupon was actually applied (consume its redemption / persist its code and discount). */
  couponApplied: boolean;
  /** orders.coupon_discount: the coupon's discount when it applied, else 0. */
  couponDiscount: number;
}

/** Ports the best-of rule at order.service.ts 1275-1305. */
export function resolvePromotions(db: SyncSql, ctx: PromotionsCtx): PromotionsResult {
  const couponDiscount = nonNeg(ctx.couponDiscount ?? 0, 'couponDiscount');
  const cust = resolveCustomerContext(
    db,
    ctx.storeId,
    { customerId: ctx.customerId, phone: ctx.phone, email: ctx.email },
    ctx.buyer
  );
  const best = resolveBestPromotion(
    db,
    ctx.storeId,
    { ...cust, cartItems: ctx.cartItems },
    ctx.now
  );
  const promoDiscount = best ? best.discount : 0;
  const primaryDiscount = Math.max(couponDiscount, promoDiscount);
  const appliedPromotionId =
    best && promoDiscount >= couponDiscount && promoDiscount > 0 ? best.promotionId : null;
  // free_shipping coupons act on the shipping line and always apply alongside any promotion; a value coupon applied
  // only if it matched-or-beat the promotion and the promotion did not take the (tie) slot.
  const hasCoupon = ctx.couponType != null || couponDiscount > 0;
  const couponApplied =
    hasCoupon &&
    (ctx.couponType === 'free_shipping' ||
      (couponDiscount === primaryDiscount && couponDiscount > 0 && !appliedPromotionId));
  return {
    best,
    primaryDiscount,
    appliedPromotionId,
    promotionDiscount: appliedPromotionId ? promoDiscount : 0,
    couponApplied,
    couponDiscount: couponApplied ? couponDiscount : 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------------------------------------------------

export const UNTRACKED_AVAILABILITY_CAP = 1_000_000;

/** min(floor(stock/qty)) over tracked components; empty = 0; all untracked = the cap (bundle.service.ts). */
export function bundleAvailability(
  items: { quantity: number; trackInventory: boolean; availableStock: number }[]
): number {
  if (items.length === 0) return 0;
  let min = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (!item.trackInventory) continue;
    min = Math.min(min, Math.floor(item.availableStock / item.quantity));
  }
  return min === Number.POSITIVE_INFINITY ? UNTRACKED_AVAILABILITY_CAP : Math.max(0, min);
}

function compareComponents(
  a: { productId: string; variantId: string | null },
  b: { productId: string; variantId: string | null }
): number {
  if (a.productId !== b.productId) return a.productId < b.productId ? -1 : 1;
  const av = a.variantId ?? '';
  const bv = b.variantId ?? '';
  if (av !== bv) return av < bv ? -1 : 1;
  return 0;
}

export interface BundleRequest {
  bundleId: string;
  /** boxes of this bundle, 1..1000 */
  quantity: number;
}
export interface BundleComponent extends AllocatedLine {
  /** bundle_items.id (== the BundleLine key) */
  bundleItemId: string;
  productId: string;
  variantId: string | null;
  trackInventory: boolean;
}
export interface ResolvedBundleBox {
  bundleId: string;
  name: string;
  nameAr: string | null;
  quantity: number;
  /** Σ component retail price of ONE box */
  componentSum: number;
  /** price of ONE box */
  price: number;
  available: number;
  isPurchasable: boolean;
  /** allocation of ONE box's price across its components (identical for every box) */
  components: BundleComponent[];
}
export interface BundlesResult {
  boxes: ResolvedBundleBox[];
  /** Σ price × quantity: added to the order subtotal */
  bundlesSubtotal: number;
  /** orders.bundle_discount = Σ (componentSum - price) × quantity. Reporting only: never subtracted again. */
  bundleDiscount: number;
  bundleIds: string[];
}
export interface BundlesCtx {
  storeId: string;
  /** explicit boxes (checkout) ... */
  bundles?: BundleRequest[];
  /** ... or the cart whose cart_bundles rows to read (tenant-checked through carts.store_id). */
  cartId?: string;
  now?: number;
}

const bool = (v: unknown) => v === 1;

function resolveOne(db: SyncSql, storeId: string, bundleId: string, at: number): ResolvedBundleBox {
  const b = db.all('SELECT * FROM bundles WHERE id = ? AND store_id = ?', [bundleId, storeId])[0];
  if (!b) throw new MoneyError('NOT_FOUND', 'Bundle not found for this store', 404);
  if (!['fixed_price', 'percentage', 'fixed'].includes(b.pricing_type as string))
    throw new MoneyError('PRICE_DATA_CORRUPT', 'unknown bundle pricing type', 500);
  const pricingValue = nonNeg(b.pricing_value, 'pricing_value');

  const rows = db
    .all('SELECT id, product_id, variant_id, quantity FROM bundle_items WHERE bundle_id = ?', [
      bundleId,
    ])
    .map(r => ({
      itemId: r.id as string,
      productId: r.product_id as string,
      variantId: (r.variant_id as string | null) ?? null,
      quantity: r.quantity as number,
    }))
    .sort(compareComponents);

  let componentsOk = true;
  const lines: BundleLine[] = [];
  const meta: { productId: string; variantId: string | null; trackInventory: boolean }[] = [];
  const avail: { quantity: number; trackInventory: boolean; availableStock: number }[] = [];
  for (const it of rows) {
    // tenant-scoped: a component of another store (or a missing one) makes the bundle unsellable
    const p = db.all(
      'SELECT price, track_inventory, inventory, status, deleted_at, audience FROM products WHERE id = ? AND store_id = ?',
      [it.productId, storeId]
    )[0];
    if (!p) {
      componentsOk = false;
      lines.push({ key: it.itemId, unitPrice: 0, quantity: Math.max(1, it.quantity) });
      meta.push({ productId: it.productId, variantId: it.variantId, trackInventory: false });
      avail.push({ quantity: Math.max(1, it.quantity), trackInventory: true, availableStock: 0 });
      continue;
    }
    const variants = db.all(
      'SELECT inventory, is_active FROM product_variants WHERE product_id = ?',
      [it.productId]
    );
    const v = it.variantId
      ? db.all(
          'SELECT price, inventory, is_active FROM product_variants WHERE id = ? AND product_id = ?',
          [it.variantId, it.productId]
        )[0]
      : undefined;
    if (it.variantId && !v) componentsOk = false;
    if (p.deleted_at !== null || p.status !== 'active') componentsOk = false;
    if (
      p.audience === 'wholesale_only' ||
      (p.audience !== 'public' && p.audience !== 'wholesale_only')
    )
      componentsOk = false; // fail closed (Ruling B2B-I1)
    if (it.variantId && v && !bool(v.is_active)) componentsOk = false;
    if (!it.variantId && variants.length > 0) componentsOk = false; // variant product pinned without a variant (P1-3)
    const unit = (v?.price ?? null) !== null ? (v!.price as number) : (p.price as number);
    nonNeg(unit, 'component price');
    const quantity = it.quantity;
    lines.push({ key: it.itemId, unitPrice: unit, quantity });
    const tracked = bool(p.track_inventory);
    meta.push({ productId: it.productId, variantId: it.variantId, trackInventory: tracked });
    const stock = it.variantId
      ? ((v?.inventory as number | undefined) ?? 0)
      : variants.length === 0
        ? (p.inventory as number)
        : variants.filter(x => bool(x.is_active)).reduce((s, x) => s + (x.inventory as number), 0);
    avail.push({ quantity, trackInventory: tracked, availableStock: stock });
  }
  if (lines.some(l => !Number.isInteger(l.quantity) || l.quantity < 1))
    throw new MoneyError('PRICE_DATA_CORRUPT', 'bundle component quantity is invalid', 500);

  const componentSum = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const price = computeBundlePrice(componentSum, b.pricing_type as BundlePricingType, pricingValue);
  const available = bundleAvailability(avail);
  const startsAt = (b.starts_at as number | null) ?? null;
  const expiresAt = (b.expires_at as number | null) ?? null;
  const within = (startsAt === null || startsAt <= at) && (expiresAt === null || at <= expiresAt);
  // a zero price is sellable only when the components are themselves free (drift guard, P1)
  const priceIsSellable = price > 0 || componentSum === 0;
  const isPurchasable =
    bool(b.is_active) && available >= 1 && componentsOk && priceIsSellable && within;

  let components: BundleComponent[] = [];
  if (isPurchasable) {
    const allocated = allocateBundlePrice(lines, price);
    // money invariant: the allocation must sum to exactly the price quoted
    if (allocated.reduce((s, l) => s + l.totalAllocated, 0) !== price)
      throw new MoneyError(
        'BUNDLE_PRICE_NOT_ALLOCATABLE',
        `"${b.name}" can no longer be priced exactly at checkout. Please try again.`,
        409
      );
    components = allocated.map((a, i) => ({
      ...a,
      bundleItemId: a.key,
      productId: meta[i].productId,
      variantId: meta[i].variantId,
      trackInventory: meta[i].trackInventory,
    }));
  }
  return {
    bundleId,
    name: b.name as string,
    nameAr: (b.name_ar as string | null) ?? null,
    quantity: 1,
    componentSum,
    price,
    available,
    isPurchasable,
    components,
  };
}

/**
 * Port of the bundle block of order.service.ts: every box is re-resolved from CURRENT component prices (never trusted
 * from the cart), refused when no longer purchasable (BUNDLE_NOT_PURCHASABLE 409: inactive, outside its window, a
 * component sold out / draft / deleted / wholesale-only, or a drifted zero price), and its allocation must sum to the
 * quoted price (BUNDLE_PRICE_NOT_ALLOCATABLE 409). A coupon never discounts a bundle (Ruling B1): bundles are NOT part of
 * the promotion / coupon base.
 */
export function resolveBundles(db: SyncSql, ctx: BundlesCtx): BundlesResult {
  const storeId = id(ctx.storeId, 'storeId');
  const at = now(ctx.now);
  let requests: BundleRequest[];
  if (ctx.bundles && ctx.cartId !== undefined) throw bad('pass bundles OR cartId, not both');
  if (ctx.bundles) requests = ctx.bundles;
  else {
    const cartId = id(ctx.cartId, 'cartId');
    requests = db
      .all(
        `SELECT cb.bundle_id, cb.quantity FROM cart_bundles cb JOIN carts c ON c.id = cb.cart_id
          WHERE cb.cart_id = ? AND c.store_id = ? ORDER BY cb.created_at, cb.id`,
        [cartId, storeId]
      )
      .map(r => ({ bundleId: r.bundle_id as string, quantity: r.quantity as number }));
  }
  const boxes: ResolvedBundleBox[] = [];
  for (const req of requests) {
    const bundleId = id(req.bundleId, 'bundleId');
    if (!Number.isInteger(req.quantity) || req.quantity < 1 || req.quantity > 1000)
      throw new MoneyError(
        'BAD_QUANTITY',
        'bundle quantity must be an integer from 1 to 1000',
        400
      );
    const box = resolveOne(db, storeId, bundleId, at);
    if (!box.isPurchasable)
      throw new MoneyError(
        'BUNDLE_NOT_PURCHASABLE',
        `"${box.name}" is no longer available. Remove it from your cart and try again.`,
        409,
        { bundleId }
      );
    boxes.push({ ...box, quantity: req.quantity });
  }
  return {
    boxes,
    bundlesSubtotal: boxes.reduce((s, b) => s + b.price * b.quantity, 0),
    bundleDiscount: boxes.reduce((s, b) => s + (b.componentSum - b.price) * b.quantity, 0),
    bundleIds: [...new Set(boxes.map(b => b.bundleId))],
  };
}
