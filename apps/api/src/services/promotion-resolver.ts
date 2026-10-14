/**
 * Promotion resolver — DB-facing orchestration for the checkout discount
 * pipeline. Resolves the customer targeting context (group + first-order) and
 * picks the single best automatic promotion for a cart. The eligibility/
 * discount math itself lives in the pure `promotion-targeting` module; this
 * layer only queries Prisma and feeds it a fully-resolved context.
 */
import { prisma } from '@ebda/database';
import { matchesTargeting, computeDiscount, TargetingCtx } from './promotion-targeting';

/**
 * Resolve the customer's targeting context from their checkout identity.
 * Guests with no resolvable identity are treated as first-time customers with
 * no group (so only "everyone" promotions and first-order promotions apply).
 *
 * When `customerId` is present (a registered customer), both facets prefer
 * the reliable account identity over the mutable per-order shipping
 * phone/email:
 *  - first-order is decided by a `customerId`-keyed order count, not the
 *    shipping fields — otherwise a registered customer who varies their
 *    shipping contact would re-qualify for `firstOrderOnly` promotions on
 *    every order (a money leak).
 *  - group targeting (`Customer` table, phone/email keyed — the #874
 *    bridge) prefers the account's own contact (`User.phone`/`User.email`)
 *    over the shipping fields, falling back to the passed-in shipping
 *    phone/email only if the account itself lacks both.
 * Guests (no `customerId`) keep the original shipping-address-keyed
 * behavior unchanged.
 */
export async function resolveCustomerContext(
  storeId: string,
  id: { phone?: string | null; email?: string | null; customerId?: string | null }
): Promise<{ customerGroupId: string | null; isFirstOrder: boolean }> {
  let isFirstOrder: boolean;
  let groupPhone = id.phone;
  let groupEmail = id.email;

  if (id.customerId) {
    const priorCount = await prisma.order.count({
      where: {
        storeId,
        customerId: id.customerId,
        deletedAt: null,
        status: { not: 'cancelled' },
      },
    });
    isFirstOrder = priorCount === 0;

    const user = await prisma.user.findUnique({
      where: { id: id.customerId, storeId },
      select: { phone: true, email: true },
    });
    groupPhone = user?.phone ?? id.phone;
    groupEmail = user?.email ?? id.email;
  } else {
    // Guest checkout — no reliable identity beyond what was typed into the
    // shipping form this order.
    if (!id.phone && !id.email) return { customerGroupId: null, isFirstOrder: true };

    // First-order = no prior non-cancelled order for this identity. Matches
    // the JSON-path identity aggregation used elsewhere for guest orders.
    const priorCount = await prisma.order.count({
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
    isFirstOrder = priorCount === 0;
  }

  const or = [] as { phone?: string; email?: { equals: string; mode: 'insensitive' } }[];
  if (groupPhone) or.push({ phone: groupPhone });
  if (groupEmail) or.push({ email: { equals: groupEmail, mode: 'insensitive' } });
  if (or.length === 0) return { customerGroupId: null, isFirstOrder };

  const customer = await prisma.customer.findFirst({
    where: { storeId, OR: or },
    select: { groupId: true },
  });

  return { customerGroupId: customer?.groupId ?? null, isFirstOrder };
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
  const promos = await prisma.promotion.findMany({
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
