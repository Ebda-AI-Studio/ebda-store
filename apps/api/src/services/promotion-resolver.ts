/**
 * Promotion resolver — DB-facing orchestration for the checkout discount
 * pipeline. Resolves the customer targeting context (group + first-order) and
 * picks the single best automatic promotion for a cart. The eligibility/
 * discount math itself lives in the pure `promotion-targeting` module; this
 * layer only queries Prisma and feeds it a fully-resolved context.
 */
import { storeDb } from '../lib/repo-factory';
import { matchesTargeting, computeDiscount, TargetingCtx } from './promotion-targeting';
import { loadBuyerGroup } from './price-resolver.service';
import { ANONYMOUS_BUYER, type BuyerIdentity } from '../lib/buyer-identity';

/**
 * Resolve the customer's targeting context: the customer GROUP and first-order status.
 *
 * GROUP (Ruling B2B-2c/2e): group membership gates money benefits (group-targeted promotions and coupons, and group prices),
 * so it is decided by a `BuyerIdentity` and nothing else: the signed-in customer SESSION (via the `customers.user_id` link)
 * or a merchant's explicit Customer pick. A typed shipping phone / email and the account's self-edited `User.phone` are NOT
 * identities for this purpose: before 2026-10-21 they were, and anyone who typed a VIP's phone received the VIP promotion.
 * Guests (anonymous) get no group benefits.
 *
 * FIRST ORDER is unchanged: a registered customer is decided by a `customerId`-keyed order count (not the mutable shipping
 * fields, or varying them would re-qualify `firstOrderOnly` promotions on every order); a guest by the typed identity. That
 * path can only ever REDUCE what a typed identity gets (a prior order for that phone/email), it does not grant a group.
 */
export async function resolveCustomerContext(
  storeId: string,
  id: { phone?: string | null; email?: string | null; customerId?: string | null },
  buyer: BuyerIdentity = ANONYMOUS_BUYER
): Promise<{ customerGroupId: string | null; isFirstOrder: boolean }> {
  const group = await loadBuyerGroup(storeId, buyer);
  const customerGroupId = group?.id ?? null;
  const customerId = id.customerId ?? (buyer.kind === 'session' ? buyer.userId : null);

  if (customerId) {
    const priorCount = await (
      await storeDb(storeId)
    ).order.count({
      where: { storeId, customerId, deletedAt: null, status: { not: 'cancelled' } },
    });
    return { customerGroupId, isFirstOrder: priorCount === 0 };
  }

  // Guest checkout: no reliable identity beyond what was typed into the shipping form this order. Used ONLY for
  // first-order status, never for group membership.
  if (!id.phone && !id.email) return { customerGroupId, isFirstOrder: true };
  const priorCount = await (
    await storeDb(storeId)
  ).order.count({
    where: {
      storeId,
      deletedAt: null,
      status: { not: 'cancelled' },
      OR: [
        ...(id.phone ? [{ shippingAddress: { path: ['phone'], equals: id.phone } }] : []),
        ...(id.email ? [{ shippingAddress: { path: ['email'], equals: id.email } }] : []),
      ],
    },
  });
  return { customerGroupId, isFirstOrder: priorCount === 0 };
}

/**
 * Pick the single best automatic promotion for a cart. Only value-bearing
 * promotions (percentage/fixed) are considered here — `free_shipping`
 * promotions act on the shipping line and are resolved separately. Promotions
 * are queried priority-desc so that ties on discount are broken by priority
 * (the strict `>` comparison keeps the first, higher-priority winner).
 */
export async function resolveBestPromotion(
  storeId: string,
  ctx: TargetingCtx
): Promise<{ promotionId: string; discount: number } | null> {
  const now = new Date();
  const promos = await (
    await storeDb(storeId)
  ).promotion.findMany({
    where: {
      storeId,
      isActive: true,
      type: { not: 'free_shipping' },
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] },
      ],
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  });

  let best: { promotionId: string; discount: number } | null = null;
  for (const p of promos) {
    const r = matchesTargeting(p, ctx);
    if (!r.eligible) continue;
    const discount = computeDiscount(p.type, p.value, p.maxDiscount, r.matchingSubtotal);
    if (discount <= 0) continue;
    // priority already ordered desc; first eligible with max discount stands.
    if (!best || discount > best.discount) best = { promotionId: p.id, discount };
  }
  return best;
}
