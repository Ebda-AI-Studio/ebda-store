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
import { hubOnD1, hubStoresById } from '../../lib/platform-hub';
import crypto from 'crypto';
import {
  prisma,
  acrossStores,
  runInTenantContext,
  storeDirectory,
  withStore,
  type Prisma,
} from '@ebda/database';
import { resolveStoreId } from '../../lib/definer';
import logger from '../../lib/logger';
import { addInterval, priceFor } from './period';
import { sendAlert } from '../alerts.service';
import { assertFamilyWritableOnPostgres } from '../platform/cutover';
import {
  applyGrantsBatchD1,
  claimRestoreD1,
  insertCappedGrant,
  lockSubscription,
  onD1,
  revokeGrantsD1,
} from '../platform/billing-d1';

export const FOUNDING_SLOTS = 20;
export const REFERRER_MAX_GRANTS = 3;
/** The daily sweep re-checks referral links this young; older ones that never paid are dropped from the scan. */
const REFERRAL_SWEEP_DAYS = 120;
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

/**
 * The store's first REAL paid month: a succeeded subscription payment (checkout, renewal, upgrade, manual) that covers
 * at least one month of the plan it was for. FAIL CLOSED: an event with no plan, an unknown plan, or a plan priced
 * 0 / null (free, comped, granted) does not qualify, and neither does a payment smaller than one month (referral
 * farming). A refunded payment is `refunded`, not `succeeded`, so it does not count.
 */
export async function firstQualifyingPayment(
  tx: Tx,
  storeId: string,
  plans?: PlanPrices
): Promise<{ id: string; createdAt: Date } | null> {
  const events = await tx.billingEvent.findMany({
    where: {
      storeId,
      status: 'succeeded',
      amountMinor: { gt: 0 },
      type: { in: ['checkout', 'renewal', 'upgrade', 'manual_payment'] },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: { id: true, amountMinor: true, planCode: true, billingInterval: true, createdAt: true },
  });
  if (events.length === 0) return null;
  const catalog = plans ?? (await loadPlanPrices());
  for (const e of events) {
    const plan = e.planCode ? catalog.get(e.planCode) : undefined;
    // a yearly payment is measured against the yearly price, anything else against the monthly one
    const need = plan
      ? (priceFor(plan, e.billingInterval === 'yearly' ? 'yearly' : 'monthly') ?? 0)
      : 0;
    if (need > 0 && e.amountMinor >= need) return { id: e.id, createdAt: e.createdAt };
  }
  return null;
}
export type PlanPrices = Map<
  string,
  { priceMonthlyMinor: number | null; priceYearlyMinor: number | null }
>;
export async function loadPlanPrices(): Promise<PlanPrices> {
  const plans = await prisma.plan.findMany({
    select: { code: true, priceMonthlyMinor: true, priceYearlyMinor: true },
  });
  return new Map(plans.map(p => [p.code, p]));
}
export async function hasPaid(tx: Tx, storeId: string): Promise<boolean> {
  return (await firstQualifyingPayment(tx, storeId)) !== null;
}

/** The latest end date an APPLIED grant moved this store's period to (null = none). */
export async function grantedPaidThrough(tx: Tx, storeId: string): Promise<Date | null> {
  const grants = await tx.billingGrant.findMany({
    where: { beneficiaryId: storeId, status: 'applied', periodEndAfter: { not: null } },
    orderBy: { periodEndAfter: 'desc' },
    select: { periodEndAfter: true, sourceEventId: true, sourceStoreId: true },
  });
  for (const g of grants) {
    // A grant backed by THIS store's own payment counts only while that payment is still succeeded. A referrer grant
    // is backed by the referred store's payment (another tenant): its `revoked` status carries that fact.
    if (g.sourceEventId && g.sourceStoreId === storeId) {
      const ok = await tx.billingEvent.count({
        where: { id: g.sourceEventId, storeId, status: 'succeeded' },
      });
      if (ok === 0) continue;
    }
    return g.periodEndAfter;
  }
  return null;
}
/**
 * Free time a store still holds from APPLIED grants at `now`, in ms: the unconsumed part of each granted month
 * (`periodEndAfter - max(periodEndBefore, now)`). A checkout/upgrade starts a fresh full period at `now` (no proration),
 * so this is ADDED on top of it; otherwise the new period would swallow the free month (it would be a max, not a sum).
 * A grant backed by the store's own payment counts only while that payment is still `succeeded`.
 */
export async function grantedCarryMs(tx: Tx, storeId: string, now: Date): Promise<number> {
  const grants = await tx.billingGrant.findMany({
    where: { beneficiaryId: storeId, status: 'applied', periodEndAfter: { gt: now } },
    select: {
      periodEndBefore: true,
      periodEndAfter: true,
      sourceEventId: true,
      sourceStoreId: true,
    },
  });
  let carry = 0;
  for (const g of grants) {
    if (!g.periodEndAfter || !g.periodEndBefore) continue;
    if (g.sourceEventId && g.sourceStoreId === storeId) {
      const ok = await tx.billingEvent.count({
        where: { id: g.sourceEventId, storeId, status: 'succeeded' },
      });
      if (ok === 0) continue;
    }
    carry += g.periodEndAfter.getTime() - Math.max(g.periodEndBefore.getTime(), now.getTime());
  }
  return carry;
}
export const laterOf = (a: Date, b: Date | null): Date => (b && b.getTime() > a.getTime() ? b : a);

/**
 * Is `currentEnd` the charge's `forPeriodEnd` moved forward by applied grants only (a chain of
 * periodEndBefore -> periodEndAfter)? A renewal claimed before a grant landed must still settle.
 */
export async function shiftedByGrants(
  tx: Tx,
  storeId: string,
  forPeriodEnd: Date,
  currentEnd: Date
): Promise<boolean> {
  let end = forPeriodEnd;
  for (let i = 0; i < 12; i++) {
    const g = await tx.billingGrant.findFirst({
      where: {
        beneficiaryId: storeId,
        periodEndBefore: end,
        periodEndAfter: { not: null },
        OR: [{ status: 'applied' }, { status: 'revoked', restoredAt: null }],
      },
      select: { periodEndAfter: true },
    });
    if (!g?.periodEndAfter) return false;
    end = g.periodEndAfter;
    if (end.getTime() === currentEnd.getTime()) return true;
  }
  return false;
}

async function insertGrant(
  tx: Tx,
  g: {
    kind: GrantKind;
    beneficiaryId: string;
    counterpartId?: string;
    key: string;
    valueMinor: number;
    /** the qualifying payment this grant is backed by */
    source: { eventId: string; storeId: string };
    /** D1 only: the cap enforced inside the INSERT itself (Postgres serialises with an advisory lock instead). */
    cap?: { kind: string; beneficiaryId?: string; max: number };
  }
): Promise<boolean> {
  if (g.cap && (await onD1()))
    return insertCappedGrant(
      {
        id: crypto.randomUUID(),
        kind: g.kind,
        beneficiaryId: g.beneficiaryId,
        counterpartId: g.counterpartId ?? null,
        valueMinor: g.valueMinor,
        key: g.key,
        sourceEventId: g.source.eventId,
        sourceStoreId: g.source.storeId,
      },
      g.cap
    );
  // Same statement on Postgres and D1: createMany + skipDuplicates is INSERT ... ON CONFLICT DO NOTHING.
  const { count } = await tx.billingGrant.createMany({
    data: [
      {
        id: crypto.randomUUID(),
        kind: g.kind,
        beneficiaryId: g.beneficiaryId,
        counterpartId: g.counterpartId ?? null,
        months: 1,
        valueMinor: g.valueMinor,
        status: 'pending',
        idempotencyKey: g.key,
        sourceEventId: g.source.eventId,
        sourceStoreId: g.source.storeId,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
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
  const paid = await firstQualifyingPayment(tx, paidStoreId);
  if (!paid) return { beneficiaries: [], created };
  const source = { eventId: paid.id, storeId: paidStoreId };

  // Founding-20: one global counter, serialised by an advisory lock.
  const already = await tx.billingGrant.count({
    where: { kind: 'founding', beneficiaryId: paidStoreId },
  });
  if (already === 0) {
    // D1: the cap is inside the INSERT (insertGrant `cap`), so no lock and no separate count.
    const d1 = await onD1();
    if (!d1)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey('billing_grants:founding')}))`;
    // a revoked grant gives its slot back
    const taken = d1
      ? 0
      : await tx.billingGrant.count({
          where: { kind: 'founding', status: { not: 'revoked' } },
        });
    if (taken < FOUNDING_SLOTS) {
      const valueMinor = await monthValueMinor(tx, paidStoreId);
      if (
        await insertGrant(tx, {
          kind: 'founding',
          beneficiaryId: paidStoreId,
          key: `founding:${paidStoreId}`,
          valueMinor,
          source,
          cap: { kind: 'founding', max: FOUNDING_SLOTS },
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
      source,
    });
    if (referred) created.push('referral_referred');
    const rewarded = await tx.billingGrant.count({
      where: { kind: 'referral_referrer', idempotencyKey: `referral:${paidStoreId}:referrer` },
    });
    if (rewarded === 0) {
      const d1 = await onD1();
      if (!d1)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(`billing_grants:referrer:${link.referrerStoreId}`)}))`;
      const used = d1
        ? 0
        : await tx.billingGrant.count({
            where: {
              kind: 'referral_referrer',
              beneficiaryId: link.referrerStoreId,
              status: { not: 'revoked' },
            },
          });
      if (used < REFERRER_MAX_GRANTS) {
        const ok = await insertGrant(tx, {
          kind: 'referral_referrer',
          beneficiaryId: link.referrerStoreId,
          counterpartId: paidStoreId,
          key: `referral:${paidStoreId}:referrer`,
          valueMinor: await monthValueMinor(tx, link.referrerStoreId),
          source,
          cap: {
            kind: 'referral_referrer',
            beneficiaryId: link.referrerStoreId,
            max: REFERRER_MAX_GRANTS,
          },
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
  if (!(await lockSubscription(tx, storeId))) return 0;
  const sub = await tx.storeSubscription.findUnique({ where: { storeId } });
  // the same "paid through" the billing cycle reads: the trial end while trialing, else the period end
  const base =
    sub?.status === 'trialing' ? (sub.trialEndsAt ?? sub.currentPeriodEnd) : sub?.currentPeriodEnd;
  if (!sub || !base || !['active', 'trialing'].includes(sub.status)) return 0;
  const inFlight = await tx.billingEvent.count({
    where: { storeId, status: 'pending', type: { in: ['renewal', 'upgrade', 'checkout'] } },
  });
  if (inFlight > 0) return 0;
  if (await onD1()) {
    // One atomic batch: the subscription move and every grant claim commit together or not at all (Ruling NZ-10-2).
    const chain: Array<{ id: string; before: Date; after: Date }> = [];
    let cursor = base;
    for (const g of pending) {
      const next = addInterval(cursor, 'monthly');
      chain.push({ id: g.id, before: cursor, after: next });
      cursor = next;
    }
    const n = await applyGrantsBatchD1({
      storeId,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      trialEndsAt: sub.trialEndsAt,
      grants: chain,
      trialing: sub.status === 'trialing',
      now,
    });
    if (n !== chain.length) {
      // Nothing was applied: the subscription moved (or another run took the grants). They stay pending and the next
      // sweep retries; the page is for the case where that never resolves.
      logger.warn(
        { storeId, pending: chain.length },
        '[billing] free-month grants not applied: subscription moved'
      );
      void sendAlert({
        level: 'p1',
        title: 'Billing: free-month grants not applied (subscription changed underneath)',
        body: `store ${storeId}: ${chain.length} pending grant(s) left pending; the daily sweep retries. Investigate if it repeats.`,
      }).catch(() => undefined);
    }
    return n;
  }
  let end = base;
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
        ...(sub.status === 'trialing' ? { trialEndsAt: end } : {}),
      },
    });
  }
  return applied;
}

/**
 * The qualifying payment behind some grants was refunded or charged back (FOUNDING-3): revoke every live grant it backs
 * (the founding month, the referred side, and the referrer's month), idempotently. The claim is one conditional UPDATE
 * (`pending|applied -> revoked`) that works in any context; taking the free month back off the beneficiary's period is
 * a second step in the BENEFICIARY's own store scope (`restoreRevokedGrants`), because a referrer is another tenant.
 * Grants of the current store `ownStoreId` are restored inline in the caller's transaction so a refund flow sees the
 * corrected period. Returns the revoked grant ids.
 */
export async function revokeGrantsForEvent(
  tx: Tx,
  eventId: string,
  reason: string,
  now: Date,
  ownStoreId?: string
): Promise<string[]> {
  // Lock order is subscription row THEN grant row everywhere (applyPendingGrants does the same): lock the own-store
  // beneficiary's subscription before the UPDATE claims its grant rows, or a concurrent apply deadlocks with it.
  if (ownStoreId) {
    const own = await tx.billingGrant.count({
      where: {
        sourceEventId: eventId,
        beneficiaryId: ownStoreId,
        status: { in: ['pending', 'applied'] },
      },
    });
    if (own > 0) await lockSubscription(tx, ownStoreId);
  }
  const rows = (await onD1())
    ? await revokeGrantsD1(eventId, reason, now)
    : (await assertFamilyWritableOnPostgres('billing'),
      await tx.$queryRaw<Array<{ id: string; beneficiary_id: string }>>`
    UPDATE billing_grants SET status = 'revoked', revoked_at = ${now}, revoke_reason = ${reason}
    WHERE source_event_id = ${eventId} AND status IN ('pending', 'applied')
    RETURNING id, beneficiary_id`);
  if (ownStoreId)
    for (const r of rows)
      if (r.beneficiary_id === ownStoreId) await restoreOne(tx, r.id, ownStoreId, now);
  return rows.map(r => r.id);
}

/**
 * Take one revoked, applied grant's UNCONSUMED free time back off the beneficiary's period (once, under the
 * subscription lock): `periodEndAfter - max(periodEndBefore, now)`, capped at the granted span. Time already used up,
 * and any later PAID period (an upgrade, a renewal), is not touched.
 */
async function restoreOne(tx: Tx, grantId: string, storeId: string, now: Date): Promise<void> {
  await lockSubscription(tx, storeId);
  let claimed: Array<{ period_end_before: Date; period_end_after: Date }>;
  if (await onD1()) {
    const c = await claimRestoreD1(grantId, now);
    claimed = c ? [{ period_end_before: c.before, period_end_after: c.after }] : [];
  } else {
    await assertFamilyWritableOnPostgres('billing');
    claimed = await tx.$queryRaw<
      Array<{ period_end_before: Date; period_end_after: Date }>
    >`UPDATE billing_grants SET restored_at = ${now}
    WHERE id = ${grantId} AND status = 'revoked' AND restored_at IS NULL AND period_end_after IS NOT NULL
    RETURNING period_end_before, period_end_after`;
  }
  if (claimed.length === 0) return;
  const span = claimed[0].period_end_after.getTime() - claimed[0].period_end_before.getTime();
  const left =
    claimed[0].period_end_after.getTime() -
    Math.max(claimed[0].period_end_before.getTime(), now.getTime());
  const take = Math.max(0, Math.min(span, left));
  if (take === 0) return;
  const sub = await tx.storeSubscription.findUnique({ where: { storeId } });
  if (!sub) return;
  const base =
    sub.status === 'trialing' ? (sub.trialEndsAt ?? sub.currentPeriodEnd) : sub.currentPeriodEnd;
  if (!base) return;
  const end = new Date(base.getTime() - take);
  await tx.storeSubscription.update({
    where: { storeId },
    data: { currentPeriodEnd: end, ...(sub.status === 'trialing' ? { trialEndsAt: end } : {}) },
  });
}

/** Restore every revoked-but-not-yet-restored applied grant (each in its beneficiary's own transaction). */
export async function restoreRevokedGrants(now = new Date()): Promise<number> {
  const todo = await prisma.billingGrant.findMany({
    where: { status: 'revoked', restoredAt: null, periodEndAfter: { not: null } },
    select: { id: true, beneficiaryId: true },
  });
  for (const g of todo)
    await inOwnTx(g.beneficiaryId, tx => restoreOne(tx, g.id, g.beneficiaryId, now)).catch(err =>
      logger.error({ err, grantId: g.id }, '[billing] restoring a revoked grant failed')
    );
  return todo.length;
}

/**
 * Run `fn` in its OWN real transaction scoped to `storeId`. `withStore` reuses the caller's context, and inside
 * `runInStoreScope` (the billing routes) that context has NO transaction: every statement autocommits, so an
 * advisory/row lock taken there is released at once and the caps would not hold. The lock-then-count logic below
 * needs one transaction from the lock to the commit.
 */
const inOwnTx = <T>(storeId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  runInTenantContext(storeId, () => fn(prisma as unknown as Tx));

/** Create the grants a payment earns, then apply every pending grant of each side (separate stores, separate transactions). */
export async function awardGrantsAfterPayment(
  paidStoreId: string,
  now = new Date()
): Promise<void> {
  try {
    const { beneficiaries } = await inOwnTx(paidStoreId, tx =>
      createGrantsForPayment(tx, paidStoreId)
    );
    const all = new Set<string>([paidStoreId, ...beneficiaries]);
    for (const id of all) await inOwnTx(id, tx => applyPendingGrants(tx, id, now));
  } catch (err) {
    // The daily sweep (sweepFreeMonthGrants) re-creates and re-applies anything this missed.
    logger.error({ err, paidStoreId }, '[billing] awarding free-month grants failed');
  }
}

/**
 * Daily catch-up (runs in the billing cycle): (1) apply pending grants (a store that had no period or a charge in
 * flight), (2) re-create referral grants whose creation was lost, (3) while founding slots remain, award them in
 * first-payment order to qualifying stores that never got one (paid before this shipped, or a lost effect).
 */
export async function sweepFreeMonthGrants(
  now = new Date(),
  /** Restrict the founding scan to these stores (operator re-run / tests). */
  only?: { storeIds?: string[] }
): Promise<{ applied: number; created: number }> {
  let applied = 0;
  let created = 0;
  // (0) revoke grants whose backing payment was refunded (a refund path that missed them), then take the months back
  const sources = await prisma.billingGrant.findMany({
    where: { status: { in: ['pending', 'applied'] }, sourceStoreId: { not: null } },
    distinct: ['sourceStoreId'],
    select: { sourceStoreId: true },
  });
  for (const { sourceStoreId } of sources) {
    if (!sourceStoreId) continue;
    await inOwnTx(sourceStoreId, async tx => {
      const live = await tx.billingGrant.findMany({
        where: {
          sourceStoreId,
          status: { in: ['pending', 'applied'] },
          sourceEventId: { not: null },
        },
        select: { sourceEventId: true },
      });
      const ids = [...new Set(live.map(g => g.sourceEventId as string))];
      if (ids.length === 0) return;
      const refunded = await tx.billingEvent.findMany({
        where: { id: { in: ids }, storeId: sourceStoreId, status: 'refunded' },
        select: { id: true },
      });
      for (const e of refunded)
        await revokeGrantsForEvent(tx, e.id, 'payment_refunded', now, sourceStoreId);
    }).catch(err => logger.error({ err, sourceStoreId }, '[billing] grant revocation scan failed'));
  }
  await restoreRevokedGrants(now);
  const pending = await prisma.billingGrant.findMany({
    where: { status: 'pending' },
    distinct: ['beneficiaryId'],
    select: { beneficiaryId: true },
  });
  for (const { beneficiaryId } of pending)
    applied += await inOwnTx(beneficiaryId, tx => applyPendingGrants(tx, beneficiaryId, now)).catch(
      err => (logger.error({ err, beneficiaryId }, '[billing] grant apply failed'), 0)
    );

  // Only recent links: a referred store that never pays must not cost two transactions a day for ever.
  const links = await prisma.billingReferral.findMany({
    where: { createdAt: { gt: new Date(now.getTime() - REFERRAL_SWEEP_DAYS * 86_400_000) } },
    select: { referredStoreId: true },
  });
  for (const { referredStoreId } of links) {
    const have = await prisma.billingGrant.count({
      where: { idempotencyKey: `referral:${referredStoreId}:referred` },
    });
    if (have === 0) {
      await awardGrantsAfterPayment(referredStoreId, now);
      created += await prisma.billingGrant.count({
        where: { idempotencyKey: `referral:${referredStoreId}:referred` },
      });
    }
  }

  if (
    (await prisma.billingGrant.count({ where: { kind: 'founding', status: { not: 'revoked' } } })) <
    FOUNDING_SLOTS
  ) {
    const plans = await loadPlanPrices();
    const parts = await acrossStores(
      async storeId => {
        const has = await prisma.billingGrant.count({
          where: { kind: 'founding', beneficiaryId: storeId },
        });
        if (has > 0) return null;
        const at = await firstQualifyingPayment(prisma as unknown as Tx, storeId, plans);
        return at ? { storeId, at: at.createdAt } : null;
      },
      {
        ...(only?.storeIds ? { storeIds: only.storeIds } : {}),
        onStoreError: (storeId, err) =>
          logger.error({ err, storeId }, '[billing] founding scan failed'),
      }
    );
    const queue = parts
      .map(p => p.value)
      .filter((v): v is { storeId: string; at: Date } => v !== null)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const { storeId } of queue) {
      const live = () =>
        prisma.billingGrant.count({ where: { kind: 'founding', status: { not: 'revoked' } } });
      if ((await live()) >= FOUNDING_SLOTS) break;
      const before = await prisma.billingGrant.count({
        where: { kind: 'founding', beneficiaryId: storeId },
      });
      await awardGrantsAfterPayment(storeId, now);
      created +=
        (await prisma.billingGrant.count({ where: { kind: 'founding', beneficiaryId: storeId } })) -
        before;
    }
  }
  return { applied, created };
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
  const { count } = await prisma.billingReferral.createMany({
    data: [{ referredStoreId, referrerStoreId: referrerId }],
    skipDuplicates: true,
  });
  return count === 1;
}

/** Super-admin view: every grant, newest first, with store names and the founding/referral totals. */
export async function listGrants(limit = 200) {
  const take = Math.min(Math.max(limit, 1), 500);
  const rows = await prisma.billingGrant.findMany({ orderBy: { createdAt: 'desc' }, take });
  const ids = [...new Set(rows.flatMap(r => [r.beneficiaryId, r.counterpartId ?? '']))].filter(
    Boolean
  );
  const idSet = new Set(ids);
  // NEON-ZERO (Ruling NZ-C-4): names from D1 once the platform families moved.
  const stores = (await hubOnD1())
    ? await hubStoresById([...idSet])
    : (await storeDirectory()).filter(x => idSet.has(x.id));
  const name = new Map(stores.map(s => [s.id, s]));
  const [total, founding, referral] = await Promise.all([
    prisma.billingGrant.aggregate({ _sum: { valueMinor: true } }),
    prisma.billingGrant.count({ where: { kind: 'founding' } }),
    prisma.billingGrant.count({ where: { kind: { startsWith: 'referral' } } }),
  ]);
  return {
    foundingUsed: founding,
    foundingSlots: FOUNDING_SLOTS,
    referralGrants: referral,
    referrerMax: REFERRER_MAX_GRANTS,
    totalValueMinor: total._sum.valueMinor ?? 0,
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
