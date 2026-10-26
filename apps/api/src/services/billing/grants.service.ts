/**
 * FOUNDING-1 (M-082): free months for the first 20 merchants and for referrals.
 *
 *  - Founding-20: the first 20 stores to make a PAID payment get 1 free month.
 *  - Referral: when a referred store makes its first PAID payment, BOTH sides get 1 free month; a
 *    referrer is rewarded for at most 3 referrals. The referred store's month does not count against
 *    the referrer's cap.
 *
 * Integer accounting: a grant is a whole month (CHECK months = 1) with the plan price it was worth in
 * piastres. Each grant is one `billing_grants` row (append-only, UNIQUE idempotency key), so a replayed
 * payment event grants nothing twice. The caps are counted under a transaction-scoped advisory lock
 * (one lock for the founding counter, one per referrer), so two concurrent first payments cannot both
 * take the 20th slot or the referrer's 4th reward.
 *
 * A grant is applied by moving the store's `currentPeriodEnd` one month out. If the store has no
 * period to extend (free or comped plan) or a charge for its current period is in flight, the grant
 * stays `pending` and is applied by the next call, which runs on every subscription payment.
 */
import crypto from 'crypto';
import { prisma, withStore, storeDirectory, type Prisma } from '@ebda/database';
import { resolveStoreId } from '../../lib/definer';
import logger from '../../lib/logger';
import { addInterval } from './period';

export const FOUNDING_SLOTS = 20;
export const REFERRER_MAX_GRANTS = 3;
export type GrantKind = 'founding' | 'referral_referrer' | 'referral_referred';

type Tx = Prisma.TransactionClient;

/** Whole-instance locks: hashtext keeps the key inside the advisory-lock bigint range. */
const lockKey = (name: string) => name;

/** Piastres of one month of the store's current plan (0 when it has no price, e.g. free). */
async function monthValueMinor(tx: Tx, storeId: string): Promise<number> {
  const sub = await tx.storeSubscription.findUnique({
    where: { storeId },
    select: { planCode: true },
  });
  if (!sub) return 0;
  const plan = await prisma.plan.findUnique({
    where: { code: sub.planCode },
    select: { priceMonthlyMinor: true },
  });
  return plan?.priceMonthlyMinor && plan.priceMonthlyMinor > 0 ? plan.priceMonthlyMinor : 0;
}

/** Has this store made at least one real (non-zero) subscription payment? */
export async function hasPaid(tx: Tx, storeId: string): Promise<boolean> {
  const n = await tx.billingEvent.count({
    where: {
      storeId,
      status: 'succeeded',
      amountMinor: { gt: 0 },
      type: { in: ['checkout', 'renewal', 'upgrade', 'manual_payment'] },
    },
  });
  return n > 0;
}

async function insertGrant(
  tx: Tx,
  g: {
    kind: GrantKind;
    beneficiaryId: string;
    counterpartId?: string;
    key: string;
    valueMinor: number;
  }
): Promise<boolean> {
  const rows = await tx.$executeRaw`
    INSERT INTO billing_grants (id, kind, beneficiary_id, counterpart_id, months, value_minor, status, idempotency_key)
    VALUES (${crypto.randomUUID()}, ${g.kind}, ${g.beneficiaryId}, ${g.counterpartId ?? null}, 1, ${g.valueMinor}, 'pending', ${g.key})
    ON CONFLICT (idempotency_key) DO NOTHING`;
  return rows === 1;
}

/**
 * Create the grants a payment by `paidStoreId` earns (idempotent, caps under lock). Returns the
 * stores whose pending grants should now be applied.
 */
export async function createGrantsForPayment(
  tx: Tx,
  paidStoreId: string
): Promise<{ beneficiaries: string[]; created: GrantKind[] }> {
  const beneficiaries = new Set<string>([paidStoreId]);
  const created: GrantKind[] = [];
  if (!(await hasPaid(tx, paidStoreId))) return { beneficiaries: [], created };

  // Founding-20: one global counter, serialised by an advisory lock.
  const already = await tx.billingGrant.count({
    where: { kind: 'founding', beneficiaryId: paidStoreId },
  });
  if (already === 0) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey('billing_grants:founding')}))`;
    const taken = await tx.billingGrant.count({ where: { kind: 'founding' } });
    if (taken < FOUNDING_SLOTS) {
      const valueMinor = await monthValueMinor(tx, paidStoreId);
      if (
        await insertGrant(tx, {
          kind: 'founding',
          beneficiaryId: paidStoreId,
          key: `founding:${paidStoreId}`,
          valueMinor,
        })
      )
        created.push('founding');
    }
  }

  // Referral: the referred store's first PAID payment rewards both sides.
  const link = await tx.billingReferral.findUnique({ where: { referredStoreId: paidStoreId } });
  if (link) {
    const referred = await insertGrant(tx, {
      kind: 'referral_referred',
      beneficiaryId: paidStoreId,
      counterpartId: link.referrerStoreId,
      key: `referral:${paidStoreId}:referred`,
      valueMinor: await monthValueMinor(tx, paidStoreId),
    });
    if (referred) created.push('referral_referred');
    const rewarded = await tx.billingGrant.count({
      where: { kind: 'referral_referrer', idempotencyKey: `referral:${paidStoreId}:referrer` },
    });
    if (rewarded === 0) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(`billing_grants:referrer:${link.referrerStoreId}`)}))`;
      const used = await tx.billingGrant.count({
        where: { kind: 'referral_referrer', beneficiaryId: link.referrerStoreId },
      });
      if (used < REFERRER_MAX_GRANTS) {
        const ok = await insertGrant(tx, {
          kind: 'referral_referrer',
          beneficiaryId: link.referrerStoreId,
          counterpartId: paidStoreId,
          key: `referral:${paidStoreId}:referrer`,
          valueMinor: await monthValueMinor(tx, link.referrerStoreId),
        });
        if (ok) {
          created.push('referral_referrer');
          beneficiaries.add(link.referrerStoreId);
        }
      }
    }
  }
  return { beneficiaries: [...beneficiaries], created };
}

/**
 * Apply the store's pending grants: one month each onto `currentPeriodEnd`, under the subscription row
 * lock. Skipped (stay pending) when there is no period to extend or a charge for the period is in flight.
 */
export async function applyPendingGrants(tx: Tx, storeId: string, now: Date): Promise<number> {
  const pending = await tx.billingGrant.findMany({
    where: { beneficiaryId: storeId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (pending.length === 0) return 0;
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM store_subscriptions WHERE store_id = ${storeId} FOR UPDATE`;
  if (locked.length === 0) return 0;
  const sub = await tx.storeSubscription.findUnique({ where: { storeId } });
  if (!sub?.currentPeriodEnd || !['active', 'trialing'].includes(sub.status)) return 0;
  const inFlight = await tx.billingEvent.count({
    where: { storeId, status: 'pending', type: { in: ['renewal', 'upgrade', 'checkout'] } },
  });
  if (inFlight > 0) return 0;
  let end = sub.currentPeriodEnd;
  let applied = 0;
  for (const g of pending) {
    const next = addInterval(end, 'monthly');
    // Claim the grant first: the guard trigger makes pending -> applied a one-way, one-time move.
    const claimed = await tx.billingGrant.updateMany({
      where: { id: g.id, status: 'pending' },
      data: { status: 'applied', appliedAt: now, periodEndBefore: end, periodEndAfter: next },
    });
    if (claimed.count !== 1) continue;
    end = next;
    applied += 1;
  }
  if (applied > 0) {
    await tx.storeSubscription.update({
      where: { storeId },
      data: {
        currentPeriodEnd: end,
        ...(sub.status === 'trialing' && sub.trialEndsAt ? { trialEndsAt: end } : {}),
      },
    });
  }
  return applied;
}

/** Entry point after a subscription payment settles (post-commit effect). Never throws. */
export async function awardGrantsAfterPayment(
  paidStoreId: string,
  now = new Date()
): Promise<void> {
  try {
    const { beneficiaries } = await withStore(paidStoreId, tx =>
      createGrantsForPayment(tx, paidStoreId)
    );
    // Each beneficiary is its own store scope (the referrer is a different tenant).
    const all = new Set<string>([paidStoreId, ...beneficiaries]);
    for (const id of all) await withStore(id, tx => applyPendingGrants(tx, id, now));
  } catch (err) {
    logger.error({ err, paidStoreId }, '[billing] awarding free-month grants failed');
  }
}

/**
 * Record who referred a new store. `refSlug` is the referrer's public store slug. Quietly ignores
 * an unknown slug, a self-referral and a repeat (first link wins).
 */
export async function recordReferral(referredStoreId: string, refSlug: string): Promise<boolean> {
  const referrerId = await resolveStoreId({ slug: refSlug });
  if (!referrerId || referrerId === referredStoreId) return false;
  const ownerOf = (id: string) =>
    withStore(id, tx => tx.store.findUnique({ where: { id }, select: { ownerId: true } }));
  const [referrer, referred] = await Promise.all([ownerOf(referrerId), ownerOf(referredStoreId)]);
  if (!referrer || !referred || referred.ownerId === referrer.ownerId) return false; // same owner = self-referral
  const rows = await prisma.$executeRaw`
    INSERT INTO billing_referrals (referred_store_id, referrer_store_id)
    VALUES (${referredStoreId}, ${referrerId}) ON CONFLICT (referred_store_id) DO NOTHING`;
  return rows === 1;
}

/** Super-admin view: every grant, newest first, with store names and the founding/referral totals. */
export async function listGrants(limit = 200) {
  const take = Math.min(Math.max(limit, 1), 500);
  const rows = await prisma.billingGrant.findMany({ orderBy: { createdAt: 'desc' }, take });
  const ids = [...new Set(rows.flatMap(r => [r.beneficiaryId, r.counterpartId ?? '']))].filter(
    Boolean
  );
  const idSet = new Set(ids);
  const stores = (await storeDirectory()).filter(x => idSet.has(x.id));
  const name = new Map(stores.map(s => [s.id, s]));
  const [founding, referral] = await Promise.all([
    prisma.billingGrant.count({ where: { kind: 'founding' } }),
    prisma.billingGrant.count({ where: { kind: { startsWith: 'referral' } } }),
  ]);
  return {
    foundingUsed: founding,
    foundingSlots: FOUNDING_SLOTS,
    referralGrants: referral,
    referrerMax: REFERRER_MAX_GRANTS,
    totalValueMinor: rows.reduce((a, r) => a + r.valueMinor, 0),
    grants: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      months: r.months,
      valueMinor: r.valueMinor,
      beneficiaryId: r.beneficiaryId,
      beneficiaryName: name.get(r.beneficiaryId)?.name ?? null,
      beneficiarySlug: name.get(r.beneficiaryId)?.slug ?? null,
      counterpartId: r.counterpartId,
      counterpartName: r.counterpartId ? (name.get(r.counterpartId)?.name ?? null) : null,
      periodEndBefore: r.periodEndBefore,
      periodEndAfter: r.periodEndAfter,
      appliedAt: r.appliedAt,
      createdAt: r.createdAt,
    })),
  };
}
