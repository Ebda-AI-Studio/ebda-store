/**
 * PriceResolver - the server-side loader around the pure `resolveUnitPrice` (@ebda/shared/pricing).
 * docs/plans/done/2026-10-21-b2b-wholesale.md, Task 2 + design review 2026-10-21. SERVER ONLY: never import this from a client
 * bundle, and never accept a price, a group id or a buyer identifier from a request body, query or header.
 *
 * Ruling B2B-2c - a wholesale price is granted ONLY through `customers.user_id`, the link between the CRM row and the
 * registered shopper, and never through an email or a phone match (those are steerable by typed input: a profile phone is
 * self-editable and unverified, and `assignByIdentity` matches phone first). `forBuyer` takes a `BuyerIdentity` (a branded
 * type minted only by lib/buyer-identity.ts), so there is no overload that takes a phone, an email or a bare string.
 *   anonymous         retail + PUBLIC tiers
 *   session           the verified customer session. The user must be THIS store's customer-role account, active, not
 *                     deleted; then group = customers WHERE store_id AND user_id = session user. No link => retail.
 *   merchant-selected a merchant staff session picked a Customer BY ID (Ruling B2B-2d): that row's group, same store.
 * The group must belong to THIS store (the DB also enforces it with a composite FK) and is passed to the pure function with
 * its isActive flag (inactive => retail).
 *
 * Plan gate (Ruling B2B-1b - restrictions survive a downgrade, benefits do not): with `b2b.wholesale` off, tiers (public AND
 * group) and group pricing are dropped; MOQ stays enforced whatever the plan (and so does wholesale-only visibility, Task 6).
 * The entitlement is read through `featureService.isFeatureEnabled`, a cached read that is fine for DISPLAY (cart, PDP).
 * Order, payment-link and admin-order creation must read it UNCACHED inside the order transaction (review I2, Task 3):
 * `forBuyer(..., { uncachedEntitlement })` is the seam for that and is wired in Task 3. A failure of the read PROPAGATES: a
 * buyer silently charged the wrong audience's price because a cache read hiccuped is a wrong charge; a 5xx is the safe failure.
 *
 * Quantities (Ruling B2B-4): tier lookup and MOQ use the PRODUCT total across the lines handed to `priceCart`; variant-level
 * tiers use the VARIANT total. The caller passes only orderable, loose (non-bundle) lines (review I4).
 * Memoisation: per instance (= per request) only. Never cache a resolved price across requests.
 */
import { customerRow, customerRows, isLiveCustomer } from '../lib/customer-directory';
import { prisma } from '@ebda/database';
import { resolveUnitPrice, type BuyerGroup, type PriceTierRow, type Resolved } from '@ebda/shared';
import { featureService } from './feature.service';
import { getAutomationFlags } from './plan-entitlements';
import type { BuyerIdentity } from '../lib/buyer-identity';
import { storeDb } from '../lib/repo-factory';

/**
 * The `b2b.wholesale` entitlement read straight from the database (no Redis / KV / in-memory cache): the per-store override
 * row first, else the plan limit. Order, payment-link and admin-order creation use this (design review I2): a just-made
 * downgrade or override must bind the very next order, and KV deletes are eventually consistent across colos.
 */
export async function wholesaleEntitledUncached(storeId: string): Promise<boolean> {
  const override = await prisma.storeFeature.findFirst({
    where: { storeId, featureKey: 'b2b.wholesale' },
    select: { enabled: true },
  });
  if (override) return override.enabled;
  const flags = await getAutomationFlags(storeId);
  return flags?.wholesalePricing ?? false;
}

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
    private readonly group: (BuyerGroup & { name: string }) | null,
    private readonly readEntitlement?: (storeId: string) => Promise<boolean>
  ) {}

  /**
   * @param buyer minted by lib/buyer-identity.ts only (anonymous, the customer session, or a merchant's Customer pick).
   * @param opts.uncachedEntitlement read `b2b.wholesale` straight from the database instead of the cached feature map
   *   (order / payment-link / admin-order creation, review I2). Defaults to the cached read for display paths.
   */
  static async forBuyer(
    storeId: string,
    buyer: BuyerIdentity,
    opts: { uncachedEntitlement?: (storeId: string) => Promise<boolean> } = {}
  ): Promise<PriceResolver> {
    if (!storeId) throw new Error('PriceResolver.forBuyer: storeId is required');
    const group = await loadBuyerGroup(storeId, buyer);
    return new PriceResolver(storeId, group, opts.uncachedEntitlement);
  }

  /** Name of the buyer's group (snapshotted onto Order.priceGroupName when a group price applied), else null. */
  get groupName(): string | null {
    return this.group?.name ?? null;
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
    // Only tiers and group pricing are plan benefits; MOQ is a restriction and survives a downgrade (Ruling B2B-1b).
    const on = anyTier || this.group !== null ? await this.wholesaleEnabled() : false;

    const result = new Map<string, Resolved>();
    for (const l of lines) {
      result.set(
        l.key,
        resolveUnitPrice({
          baseMinor: l.variant?.price ?? l.product.price,
          productPriceMinor: l.product.price,
          qty: productQty.get(l.product.id)!,
          variantQty: l.variant ? variantQty.get(l.variant.id)! : undefined,
          variantId: l.variant?.id ?? null,
          buyerGroup: on ? this.group : null,
          tiers: on ? (tiersByProduct.get(l.product.id) ?? []) : [],
          moq: l.product.moq ?? null,
        })
      );
    }
    return result;
  }

  private async wholesaleEnabled(): Promise<boolean> {
    this.featureOn ??= this.readEntitlement
      ? await this.readEntitlement(this.storeId)
      : await featureService.isFeatureEnabled(this.storeId, 'b2b.wholesale');
    return this.featureOn;
  }

  private async loadTiers(productIds: string[]): Promise<Map<string, PriceTierRow[]>> {
    const missing = productIds.filter(id => !this.tierCache.has(id));
    if (missing.length > 0) {
      // the store's own backend (Ruling CF-R4-3): Postgres, or its Durable Object's rows
      const rows = await (
        await storeDb(this.storeId)
      ).productPriceTier.findMany({
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

const GROUP_SELECT = {
  select: {
    id: true,
    storeId: true,
    name: true,
    isWholesale: true,
    pricingMode: true,
    discountBps: true,
    isActive: true,
  },
} as const;

/**
 * The buyer's group, or null. See the file header for every pinned link. Shared with promotion / coupon targeting
 * (promotion-resolver.ts): group membership for money benefits is decided by ONE function, from a BuyerIdentity.
 */
export async function loadBuyerGroup(
  storeId: string,
  buyer: BuyerIdentity
): Promise<(BuyerGroup & { name: string; isWholesale: boolean }) | null> {
  let customer: { group: GroupRow | null } | null = null;
  if (buyer.kind === 'session') {
    const doUser = await customerRow(storeId, buyer.userId);
    const user =
      doUser !== undefined
        ? doUser && isLiveCustomer(doUser)
          ? doUser
          : null
        : await prisma.user.findFirst({
            where: {
              id: buyer.userId,
              storeId,
              role: 'customer',
              status: 'active',
              deletedAt: null,
            },
            select: { id: true },
          });
    if (!user) return null;
    customer = await (
      await storeDb(storeId)
    ).customer.findFirst({
      where: { storeId, userId: user.id, groupId: { not: null } },
      select: { group: GROUP_SELECT },
    });
  } else if (buyer.kind === 'merchant-selected') {
    if (!buyer.customerId && !buyer.shopperUserId) return null;
    if (buyer.shopperUserId) {
      // Same account tests as the session branch (design review M-5): a suspended / deleted account is never priced as a
      // group member, even when a merchant picked it.
      const doShopper = await customerRow(storeId, buyer.shopperUserId);
      const shopper =
        doShopper !== undefined
          ? doShopper && isLiveCustomer(doShopper)
            ? doShopper
            : null
          : await prisma.user.findFirst({
              where: {
                id: buyer.shopperUserId,
                storeId,
                role: 'customer',
                status: 'active',
                deletedAt: null,
              },
              select: { id: true },
            });
      if (!shopper) return null;
    }
    customer = await (
      await storeDb(storeId)
    ).customer.findFirst({
      where: {
        storeId,
        groupId: { not: null },
        ...(buyer.customerId ? { id: buyer.customerId } : { userId: buyer.shopperUserId }),
      },
      select: { group: GROUP_SELECT },
    });
  } else {
    return null;
  }
  const g = customer?.group;
  if (!g || g.storeId !== storeId) return null;
  if (g.pricingMode !== 'none' && g.pricingMode !== 'percent_off') return null;
  return {
    id: g.id,
    name: g.name,
    isWholesale: g.isWholesale,
    pricingMode: g.pricingMode,
    discountBps: g.discountBps,
    isActive: g.isActive,
  };
}

type GroupRow = {
  id: string;
  name: string;
  isWholesale: boolean;
  storeId: string;
  pricingMode: string;
  discountBps: number;
  isActive: boolean;
};
