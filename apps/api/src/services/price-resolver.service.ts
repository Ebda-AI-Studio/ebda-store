/**
 * PriceResolver - the server-side loader around the pure `resolveUnitPrice` (@ebda/shared/pricing).
 * docs/plans/2026-10-21-b2b-wholesale.md, Task 2. SERVER ONLY: never import this from a client bundle, and never
 * accept a price, a group id or a "buyer" identifier from a request body, query or header.
 *
 * Ruling B2B-2 - the buyer is decided by the AUTHENTICATED user id and nothing else. `forBuyer(storeId, userId)` takes the
 * id from the verified session (`customerUserId(req)`); there is deliberately no overload that takes a phone or an email.
 * Guests, WhatsApp-bot sessions and payment-link payers pass `null` and get retail + PUBLIC tiers. Group membership is
 * then looked up from that user's OWN account, with every link in the chain pinned:
 *   user      : id = session id AND storeId = this store AND role customer AND status active AND not deleted
 *               AND emailVerified (an unverified address proves nothing: anyone can register "wholesaler@x.com")
 *   customer  : storeId = this store AND email = the user's own (verified) account email, case-insensitive. The user's
 *               phone is NOT used: there is no verified-phone flag, so a phone match would be a typed identity again.
 *   group     : the customer's group, which must belong to THIS store (a cross-store id resolves to retail) and is passed
 *               to the pure function with its isActive flag (inactive => retail, Review Focus 10).
 *
 * Plan gate (Review Focus 13): when the store's `b2b.wholesale` feature is off, tiers, group pricing and MOQ are all
 * ignored (resolved as retail). The check runs only when there is something to gate (a tier row, a buyer group or a
 * product MOQ), through `featureService.isFeatureEnabled`, whose cache is busted by every plan / override write
 * (staleness class NEVER-stale, invalidated on write; it is not a TTL-only cache). A failure of that read PROPAGATES: a
 * wholesale buyer silently charged retail (or a retail buyer silently charged wholesale) because a cache read hiccuped
 * is a wrong charge; a 5xx is the safe failure.
 *
 * Quantities (Ruling B2B-4): tier lookup and MOQ use the PRODUCT total across the cart lines handed to `priceCart`;
 * variant-level tiers use the VARIANT total. Cart storage keeps quantity only; the price is derived here, per request.
 * Memoisation: per instance (= per request) only. Never cache a resolved price across requests.
 */
import { prisma } from '@ebda/database';
import { resolveUnitPrice, type BuyerGroup, type PriceTierRow, type Resolved } from '@ebda/shared';
import { featureService } from './feature.service';

export interface PriceProduct {
  id: string;
  /** Product retail price in piastres. */
  price: number;
  moq?: number | null;
}
export interface PriceVariant {
  id: string;
  /** Variant override price; null / undefined = use the product price. */
  price?: number | null;
}
export interface PriceLine {
  /** Caller's key for the result (cart item id, order line index ...). Must be unique within one priceCart call. */
  key: string;
  product: PriceProduct;
  variant?: PriceVariant | null;
  qty: number;
}

const TIER_SELECT = {
  productId: true,
  variantId: true,
  groupId: true,
  minQty: true,
  priceMinor: true,
} as const;

export class PriceResolver {
  private readonly tierCache = new Map<string, PriceTierRow[]>();
  private featureOn: boolean | undefined;

  private constructor(
    private readonly storeId: string,
    private readonly group: BuyerGroup | null
  ) {}

  /**
   * @param buyerUserId the AUTHENTICATED shopper's user id (`customerUserId(req)`), or null for anyone else.
   */
  static async forBuyer(
    storeId: string,
    buyerUserId: string | null | undefined
  ): Promise<PriceResolver> {
    if (!storeId) throw new Error('PriceResolver.forBuyer: storeId is required');
    const group = buyerUserId ? await loadBuyerGroup(storeId, buyerUserId) : null;
    return new PriceResolver(storeId, group);
  }

  /** Price one line in isolation (qty = this line's quantity for both product and variant scope). */
  async priceLine(
    product: PriceProduct,
    variant: PriceVariant | null | undefined,
    qty: number
  ): Promise<Resolved> {
    const out = await this.priceCart([{ key: 'line', product, variant, qty }]);
    return out.get('line')!;
  }

  /**
   * Price a whole cart / order in one pass: ONE tier query for every product id, quantities summed per product and per
   * variant across lines (Ruling B2B-4), then one pure call per line.
   */
  async priceCart(lines: readonly PriceLine[]): Promise<Map<string, Resolved>> {
    const keys = new Set<string>();
    const productQty = new Map<string, number>();
    const variantQty = new Map<string, number>();
    for (const l of lines) {
      if (keys.has(l.key)) throw new Error(`PriceResolver.priceCart: duplicate line key ${l.key}`);
      keys.add(l.key);
      productQty.set(l.product.id, (productQty.get(l.product.id) ?? 0) + l.qty);
      if (l.variant) variantQty.set(l.variant.id, (variantQty.get(l.variant.id) ?? 0) + l.qty);
    }

    const tiersByProduct = await this.loadTiers([...productQty.keys()]);
    const anyTier = [...tiersByProduct.values()].some(t => t.length > 0);
    const anyMoq = lines.some(l => l.product.moq != null);
    const gated = anyTier || anyMoq || this.group !== null;
    const on = gated ? await this.wholesaleEnabled() : false;

    const result = new Map<string, Resolved>();
    for (const l of lines) {
      result.set(
        l.key,
        resolveUnitPrice({
          baseMinor: l.variant?.price ?? l.product.price,
          qty: productQty.get(l.product.id)!,
          variantQty: l.variant ? variantQty.get(l.variant.id)! : undefined,
          variantId: l.variant?.id ?? null,
          buyerGroup: on ? this.group : null,
          tiers: on ? (tiersByProduct.get(l.product.id) ?? []) : [],
          moq: on ? (l.product.moq ?? null) : null,
        })
      );
    }
    return result;
  }

  private async wholesaleEnabled(): Promise<boolean> {
    this.featureOn ??= await featureService.isFeatureEnabled(this.storeId, 'b2b.wholesale');
    return this.featureOn;
  }

  private async loadTiers(productIds: string[]): Promise<Map<string, PriceTierRow[]>> {
    const missing = productIds.filter(id => !this.tierCache.has(id));
    if (missing.length > 0) {
      const rows = await prisma.productPriceTier.findMany({
        where: { storeId: this.storeId, productId: { in: missing } },
        select: TIER_SELECT,
      });
      for (const id of missing) this.tierCache.set(id, []);
      for (const r of rows) {
        this.tierCache.get(r.productId)!.push({
          variantId: r.variantId,
          groupId: r.groupId,
          minQty: r.minQty,
          priceMinor: r.priceMinor,
        });
      }
    }
    return new Map(productIds.map(id => [id, this.tierCache.get(id)!]));
  }
}

/** The authenticated user's own group, or null. See the file header for every pinned link. */
async function loadBuyerGroup(storeId: string, userId: string): Promise<BuyerGroup | null> {
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      storeId,
      role: 'customer',
      status: 'active',
      deletedAt: null,
      emailVerified: true,
    },
    select: { email: true },
  });
  if (!user?.email) return null;

  const customer = await prisma.customer.findFirst({
    where: { storeId, email: { equals: user.email, mode: 'insensitive' }, groupId: { not: null } },
    select: {
      group: {
        select: { id: true, storeId: true, pricingMode: true, discountBps: true, isActive: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  const g = customer?.group;
  if (!g || g.storeId !== storeId) return null;
  if (g.pricingMode !== 'none' && g.pricingMode !== 'percent_off') return null;
  return { id: g.id, pricingMode: g.pricingMode, discountBps: g.discountBps, isActive: g.isActive };
}
