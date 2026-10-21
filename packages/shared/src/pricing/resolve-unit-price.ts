/**
 * resolveUnitPrice - the ONE pure place a tier / wholesale unit price is decided.
 * docs/plans/2026-10-21-b2b-wholesale.md, Task 2. Rulings B2B-3 (resolution order), B2B-4 (quantity scope),
 * B2B-5 (provenance drives coupon exclusion), B2B-2 (identity is decided by the LOADER; this function only
 * receives the already-authenticated buyer's group, or null).
 *
 * PURITY CONTRACT (enforced by the `no-restricted-imports` override in packages/shared/eslint.config.mjs for this
 * folder): no imports at all, no Date, no Math.random, no I/O, no mutation of inputs. Every number is an integer
 * number of piastres (or a quantity / basis-point count); the arithmetic below stays inside Number.MAX_SAFE_INTEGER
 * because every input is capped at Int4 (2_147_483_647), so no float ever touches a money value.
 *
 * Resolution (most specific wins, then deterministic):
 *   candidates = tiers visible to this buyer whose minQty has been reached
 *     visible : tier.variantId is null or equals the line's variant;
 *               tier.groupId is null (a PUBLIC tier) or equals the buyer's ACTIVE group
 *     reached : tier.minQty <= (variantId ? variantQty : qty)          [Ruling B2B-4]
 *   level 1 (variant, group) > 2 (product, group) > 3 (variant, all) > 4 (product, all);
 *   inside a level the largest reached minQty; a duplicate (DB-forbidden) picks the LOWER price so the answer never
 *   depends on input order.
 *   no candidate -> the buyer's active `percent_off` group discount (round half up on piastres) -> else base.
 *   The result is clamped to [0, base]; a result equal to base is reported as source 'base' (a price with no
 *   discount carries no wholesale margin to protect, so it must not exclude coupons, Ruling B2B-5).
 *
 * MOQ is reported, never enforced here: below MOQ the price is still resolved (the shopper builds the cart up) and the
 * caller refuses at order / payment-link time.
 */

export type PriceSource = 'base' | 'tier' | 'group';

export interface PriceTierRow {
  variantId: string | null;
  groupId: string | null;
  minQty: number;
  priceMinor: number;
}

export interface BuyerGroup {
  id: string;
  pricingMode: 'none' | 'percent_off';
  /** Basis points, 1250 = 12.5%. */
  discountBps: number;
  isActive: boolean;
}

export interface ResolveInput {
  /** variant.price ?? product.price, in piastres. */
  baseMinor: number;
  /** Total quantity of this PRODUCT across the cart (Ruling B2B-4). Tiers with variantId null and MOQ use this. */
  qty: number;
  /** Total quantity of this VARIANT across the cart. Variant-level tiers use it. Defaults to `qty`. */
  variantQty?: number;
  variantId: string | null;
  /** The authenticated buyer's group, or null (guest, non-member, not approved). Never derived from a typed phone/email. */
  buyerGroup: BuyerGroup | null;
  /** Only this product's tier rows. */
  tiers: readonly PriceTierRow[];
  /** Product minimum order quantity (null / undefined = none). */
  moq?: number | null;
}

export interface Resolved {
  unitMinor: number;
  source: PriceSource;
  /** The minQty of the tier that applied; null unless source === 'tier'. */
  tierMinQty: number | null;
  /** The retail unit price (== baseMinor) this was resolved from. */
  listMinor: number;
  /** True when qty is below the product MOQ. The price above is still valid. */
  belowMoq: boolean;
  moqRequired: number | null;
}

const INT4_MAX = 2_147_483_647;
const BPS_FULL = 10_000;

function assertInt(
  name: string,
  v: unknown,
  min: number,
  max: number = INT4_MAX
): asserts v is number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(
      `resolveUnitPrice: ${name} must be an integer in [${min}, ${max}], got ${String(v)}`
    );
  }
}

/** Lower rank = more specific: 0 (variant, group), 1 (product, group), 2 (variant, all), 3 (product, all). */
function levelRank(t: PriceTierRow): number {
  return (t.groupId !== null ? 0 : 2) + (t.variantId !== null ? 0 : 1);
}

/** Exact integer round-half-up of base * (10000 - bps) / 10000. No float is involved. */
function applyPercentOff(baseMinor: number, discountBps: number): number {
  const numerator = baseMinor * (BPS_FULL - discountBps) + BPS_FULL / 2; // <= 2.2e13, exact in a double
  return (numerator - (numerator % BPS_FULL)) / BPS_FULL;
}

export function resolveUnitPrice(i: ResolveInput): Resolved {
  assertInt('baseMinor', i.baseMinor, 0);
  assertInt('qty', i.qty, 0);
  const variantQty = i.variantQty ?? i.qty;
  assertInt('variantQty', variantQty, 0);
  if (i.moq !== undefined && i.moq !== null) assertInt('moq', i.moq, 1);
  const group = i.buyerGroup;
  if (group !== null) {
    if (group.pricingMode !== 'none' && group.pricingMode !== 'percent_off') {
      throw new RangeError(`resolveUnitPrice: unknown pricingMode ${String(group.pricingMode)}`);
    }
    assertInt('discountBps', group.discountBps, 0, BPS_FULL);
  }
  // Validate EVERY tier up front, including ones that will be skipped: a corrupt row must be loud, not silently ignored.
  for (const t of i.tiers) {
    assertInt('tier.minQty', t.minQty, 2);
    assertInt('tier.priceMinor', t.priceMinor, 0);
  }

  const base = i.baseMinor;
  const activeGroupId = group !== null && group.isActive ? group.id : null;
  const moqRequired = i.moq ?? null;
  const belowMoq = moqRequired !== null && i.qty < moqRequired;
  const out = (unitMinor: number, source: PriceSource, tierMinQty: number | null): Resolved => ({
    unitMinor,
    source,
    tierMinQty,
    listMinor: base,
    belowMoq,
    moqRequired,
  });

  let best: PriceTierRow | null = null;
  for (const t of i.tiers) {
    if (t.variantId !== null && t.variantId !== i.variantId) continue;
    if (t.groupId !== null && t.groupId !== activeGroupId) continue;
    if (t.minQty > (t.variantId !== null ? variantQty : i.qty)) continue;
    if (best === null) {
      best = t;
      continue;
    }
    const a = levelRank(t);
    const b = levelRank(best);
    if (
      a < b ||
      (a === b &&
        (t.minQty > best.minQty || (t.minQty === best.minQty && t.priceMinor < best.priceMinor)))
    ) {
      best = t;
    }
  }

  if (best !== null) {
    const unit = Math.min(best.priceMinor, base);
    return unit === base ? out(base, 'base', null) : out(unit, 'tier', best.minQty);
  }

  if (
    group !== null &&
    group.isActive &&
    group.pricingMode === 'percent_off' &&
    group.discountBps > 0
  ) {
    const unit = Math.min(applyPercentOff(base, group.discountBps), base);
    return unit === base ? out(base, 'base', null) : out(unit, 'group', null);
  }

  return out(base, 'base', null);
}
