/**
 * Account-level billing state (signup funnel + pricing gaps, Rulings
 * EBDA-FUNNEL-8..13):
 *
 *  - Store allowance: the OLDEST live store's plan governs how many stores an
 *    owner may run (it is the billing parent; R-EBDA-PRICING-6). Stores beyond
 *    the allowance are suspended oldest-first-kept (`over_store_limit`) and
 *    restored automatically when the allowance grows again.
 *  - Billing suspension: `stores.status = suspended` + `billing_suspended_reason`.
 *    Only a billing reason is ever lifted automatically; a super-admin
 *    suspension (reason NULL) is never touched here.
 *  - Manual payments (InstaPay / bank / cash): a super-admin records the money
 *    and activates the period in ONE transaction, idempotent on the payer's
 *    reference. A merchant's "I paid" claim never activates anything by itself.
 */
import crypto from 'crypto';
import { prisma, withStore, withUser, acrossStores, type Prisma } from '@force/database';
import { AppError } from '../../middleware/error-handler';
import { auditLog } from '../../middleware/security';
import logger from '../../lib/logger';
import { getEntitlements } from '../plan-entitlements';
import { bustStoreCaches } from '../store.service';
import { featureService } from '../feature.service';
import { isInterval, type BillingInterval } from './period';
import { lookupStore } from '../../lib/definer';
import { loadPayablePlan } from './subscription-billing.service';
import { instapayHandle } from './manual-config';
import { subscriptionChargeAmount } from './charge-amount';

type Tx = Prisma.TransactionClient;
export type BillingSuspendReason = 'unpaid' | 'over_store_limit';
export type ManualMethod = 'instapay' | 'bank' | 'cash';

// ───────────────────────────── suspension ─────────────────────────────────

/**
 * Suspend a LIVE store for a billing reason. Compare-and-set: only an `active`
 * store with no billing reason moves, so a double run (or a store a super-admin
 * already suspended) changes nothing. Returns whether this call suspended it.
 */
export async function suspendForBilling(
  storeId: string,
  reason: BillingSuspendReason,
  now: Date = new Date()
): Promise<boolean> {
  // The billing cycle runs outside any store scope: open this store's own.
  const { count } = await withStore(storeId, tx =>
    tx.store.updateMany({
      where: { id: storeId, status: 'active', billingSuspendedReason: null, deletedAt: null },
      data: { status: 'suspended', billingSuspendedReason: reason, billingSuspendedAt: now },
    })
  );
  if (count === 0) return false;
  await afterStatusChange(storeId);
  await auditLog({
    action: 'billing.store_suspended',
    resourceType: 'store',
    resourceId: storeId,
    storeId,
    details: { reason },
  });
  return true;
}

/**
 * Lift a billing suspension of `reason`. Never lifts a super-admin suspension
 * (reason NULL) or a suspension for a different reason.
 */
export async function restoreFromBilling(
  storeId: string,
  reason: BillingSuspendReason
): Promise<boolean> {
  const { count } = await withStore(storeId, tx =>
    tx.store.updateMany({
      where: { id: storeId, status: 'suspended', billingSuspendedReason: reason },
      data: { status: 'active', billingSuspendedReason: null, billingSuspendedAt: null },
    })
  );
  if (count === 0) return false;
  await afterStatusChange(storeId);
  await auditLog({
    action: 'billing.store_restored',
    resourceType: 'store',
    resourceId: storeId,
    storeId,
    details: { reason },
  });
  return true;
}

async function afterStatusChange(storeId: string): Promise<void> {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { id: true, slug: true, domain: true },
    })
  );
  if (!store) return;
  // Account status is NEVER-stale: every public resolve/slug/id cache goes.
  await bustStoreCaches(store.id, store.slug, store.domain);
  await featureService.invalidateCache(storeId).catch(() => undefined);
}

// ─────────────────────────── store allowance ──────────────────────────────

/** Owner's stores, oldest first (the order that decides who is kept). */
async function ownerStores(ownerId: string) {
  return withUser(ownerId, tx =>
    tx.store.findMany({
      where: { ownerId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, status: true, billingSuspendedReason: true },
    })
  );
}

/**
 * How many stores the owner may run: the oldest live store's plan `maxStores`
 * (null = unlimited). A canceled subscription resolves to the hidden free plan
 * through `getEntitlements`, so a lapsed Business owner drops to 1.
 */
export async function ownerStoreAllowance(ownerId: string): Promise<number> {
  const stores = await ownerStores(ownerId);
  if (stores.length === 0) return 1;
  const e = await getEntitlements(stores[0].id);
  const max = e?.limits.maxStores;
  if (max === null) return Number.POSITIVE_INFINITY;
  return typeof max === 'number' && max >= 1 ? max : 1;
}

/** Index (0 = oldest) of the store among its owner's stores, or -1. */
export async function storeRank(storeId: string): Promise<{ rank: number; allowance: number }> {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select: { ownerId: true } })
  );
  if (!store?.ownerId) return { rank: -1, allowance: 1 };
  const stores = await ownerStores(store.ownerId);
  return {
    rank: stores.findIndex(s => s.id === storeId),
    allowance: await ownerStoreAllowance(store.ownerId),
  };
}

/**
 * Bring the owner's stores in line with the allowance: keep the oldest
 * `allowance` stores, suspend every LIVE store beyond it, restore any store
 * within it that this rule had suspended. Idempotent.
 */
export async function enforceStoreAllowance(
  ownerId: string,
  now: Date = new Date()
): Promise<{ suspended: string[]; restored: string[] }> {
  const stores = await ownerStores(ownerId);
  const allowance = await ownerStoreAllowance(ownerId);
  const suspended: string[] = [];
  const restored: string[] = [];
  for (let i = 0; i < stores.length; i++) {
    const s = stores[i];
    if (i < allowance) {
      if (
        s.billingSuspendedReason === 'over_store_limit' &&
        (await restoreFromBilling(s.id, 'over_store_limit'))
      ) {
        restored.push(s.id);
      }
    } else if (s.status === 'active' && (await suspendForBilling(s.id, 'over_store_limit', now))) {
      suspended.push(s.id);
    }
  }
  if (suspended.length || restored.length) {
    logger.info({ ownerId, allowance, suspended, restored }, '[billing] store allowance enforced');
  }
  return { suspended, restored };
}

/**
 * After any plan/payment change of a store: lift an `unpaid` suspension once the
 * subscription is in good standing, then re-apply the owner's store allowance.
 */
export async function reconcileStoreAccess(storeId: string): Promise<void> {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true, billingSuspendedReason: true },
    })
  );
  if (!store) return;
  if (store.billingSuspendedReason === 'unpaid') {
    const sub = await withStore(storeId, tx =>
      tx.storeSubscription.findUnique({ where: { storeId }, select: { status: true } })
    );
    if (sub && ['active', 'trialing', 'comped'].includes(sub.status)) {
      await restoreFromBilling(storeId, 'unpaid');
    }
  }
  if (store.ownerId) await enforceStoreAllowance(store.ownerId);
}

// ─────────────────────────── payment method ───────────────────────────────

function newPaymentReference(): string {
  // Crockford-ish alphabet (no 0/O/1/I): easy to read out and type on a phone.
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `EBD-${out}`;
}

/** The InstaPay instructions for a subscription (handle, reference, amount). */
export async function instapayDetails(storeId: string) {
  const handle = instapayHandle();
  const sub = await withStore(storeId, tx =>
    tx.storeSubscription.findUnique({ where: { storeId } })
  );
  if (!sub) return null;
  const planCode = sub.pendingPlanCode ?? sub.planCode;
  const interval: BillingInterval = isInterval(sub.billingInterval)
    ? sub.billingInterval
    : 'monthly';
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  const listPrice = plan
    ? interval === 'yearly'
      ? plan.priceYearlyMinor
      : plan.priceMonthlyMinor
    : null;
  // Through the ONE charge-amount seam (platform VAT lands there).
  const amountMinor = listPrice === null ? null : subscriptionChargeAmount(listPrice).totalMinor;
  return {
    handle,
    reference: sub.paymentReference,
    planCode,
    interval,
    amountMinor,
  };
}

/**
 * The merchant picks how the subscription is paid. `instapay` needs the handle
 * configured (fail closed) and gets a unique payment reference once. `card` is
 * recorded by the card-setup webhook, not here.
 */
export async function chooseInstapay(storeId: string) {
  if (!instapayHandle()) {
    throw new AppError(409, 'INSTAPAY_NOT_CONFIGURED', 'InstaPay is not available right now');
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const updated = await withStore(storeId, async tx => {
        const sub = await tx.storeSubscription.findUnique({ where: { storeId } });
        if (!sub || !['trialing', 'active', 'past_due'].includes(sub.status)) {
          throw new AppError(
            409,
            'NO_BILLABLE_SUBSCRIPTION',
            'This store has no subscription to pay'
          );
        }
        return tx.storeSubscription.update({
          where: { storeId },
          data: {
            billingMethod: 'instapay',
            ...(sub.paymentReference ? {} : { paymentReference: newPaymentReference() }),
          },
        });
      });
      return { billingMethod: updated.billingMethod, paymentReference: updated.paymentReference };
    } catch (err) {
      // A reference collision (unique index) is retried with a fresh code.
      if ((err as { code?: string }).code === 'P2002') continue;
      throw err;
    }
  }
  throw new AppError(503, 'REFERENCE_UNAVAILABLE', 'Try again');
}

// ───────────────────────────── claims ─────────────────────────────────────

const PROOF_URL = /^https:\/\/[^\s]{1,480}$/;

/** Merchant: "I paid by InstaPay" with the transfer reference. Never activates anything. */
export async function createPaymentClaim(args: {
  storeId: string;
  payerReference: string;
  proofUrl?: string | null;
}) {
  const payerReference = args.payerReference.trim();
  if (!/^[A-Za-z0-9._\-/ ]{4,64}$/.test(payerReference)) {
    throw new AppError(400, 'INVALID_REFERENCE', 'Enter the InstaPay transaction reference');
  }
  if (args.proofUrl && !PROOF_URL.test(args.proofUrl)) {
    throw new AppError(400, 'INVALID_PROOF_URL', 'The screenshot link is not valid');
  }
  const details = await instapayDetails(args.storeId);
  if (!details?.reference || !details.amountMinor) {
    throw new AppError(409, 'INSTAPAY_NOT_CHOSEN', 'Choose InstaPay first');
  }
  try {
    return await withStore(args.storeId, async tx => {
      const sub = await tx.storeSubscription.findUnique({ where: { storeId: args.storeId } });
      const pending = await tx.manualPaymentClaim.count({
        where: { storeId: args.storeId, status: 'pending' },
      });
      if (pending >= 3) {
        throw new AppError(
          429,
          'TOO_MANY_PENDING_CLAIMS',
          'We are still checking your earlier payments'
        );
      }
      return tx.manualPaymentClaim.create({
        data: {
          storeId: args.storeId,
          subscriptionId: sub?.id ?? null,
          planCode: details.planCode,
          billingInterval: details.interval,
          amountMinor: details.amountMinor!,
          method: 'instapay',
          paymentReference: details.reference!,
          payerReference,
          proofUrl: args.proofUrl ?? null,
        },
      });
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new AppError(
        409,
        'DUPLICATE_REFERENCE',
        'This transaction reference was already submitted'
      );
    }
    throw err;
  }
}

export async function listStoreClaims(storeId: string) {
  return withStore(storeId, tx =>
    tx.manualPaymentClaim.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        planCode: true,
        billingInterval: true,
        amountMinor: true,
        method: true,
        paymentReference: true,
        payerReference: true,
        status: true,
        reviewNote: true,
        createdAt: true,
        reviewedAt: true,
      },
    })
  );
}

/** Super-admin queue: claims across stores (each read in its own store scope). */
export async function listClaimsForAdmin(status: 'pending' | 'confirmed' | 'rejected' = 'pending') {
  const parts = await acrossStores(storeId =>
    prisma.manualPaymentClaim.findMany({
      where: { storeId, status },
      include: { store: { select: { name: true, slug: true, status: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
  );
  return parts
    .flatMap(p => p.value)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(c => ({
      id: c.id,
      storeId: c.storeId,
      storeName: c.store.name,
      storeSlug: c.store.slug,
      storeStatus: c.store.status,
      planCode: c.planCode,
      billingInterval: c.billingInterval,
      amountMinor: c.amountMinor,
      method: c.method,
      paymentReference: c.paymentReference,
      payerReference: c.payerReference,
      proofUrl: c.proofUrl,
      status: c.status,
      createdAt: c.createdAt,
    }));
}

export async function rejectClaim(args: {
  storeId: string;
  claimId: string;
  note: string;
  actorId: string;
}) {
  const { count } = await withStore(args.storeId, tx =>
    tx.manualPaymentClaim.updateMany({
      where: { id: args.claimId, storeId: args.storeId, status: 'pending' },
      data: {
        status: 'rejected',
        reviewNote: args.note.slice(0, 500),
        reviewedBy: args.actorId,
        reviewedAt: new Date(),
      },
    })
  );
  if (count === 0) throw new AppError(409, 'CLAIM_NOT_PENDING', 'This claim is not pending');
}

// ─────────────────────────── manual payment ───────────────────────────────

export interface ManualPaymentInput {
  storeId: string;
  planCode: string;
  interval: BillingInterval;
  amountMinor: number;
  method: ManualMethod;
  /** The payer's transaction reference (InstaPay txn id, bank ref, receipt no.). */
  reference: string;
  paidAt: Date;
  periodStart: Date;
  periodEnd: Date;
  actorId: string;
  claimId?: string;
}

export type ManualPaymentResult = { duplicate: boolean; billingEventId: string };

/** The idempotency key of a manual payment: one per (method, payer reference). */
export const manualPaymentKey = (method: ManualMethod, reference: string) =>
  `manual:${method}:${reference.trim().toLowerCase()}`;

/**
 * Super-admin "Record manual payment & activate". ONE store-scoped transaction:
 * the ledger row (UNIQUE idempotency key = method + payer reference), the
 * subscription period, the store's plan tier and the claim confirmation. A
 * repeat with the same reference changes nothing and returns the first row.
 * Effects (restore an `unpaid` suspension, re-apply the store allowance, caches)
 * run after the commit.
 */
export async function recordManualPayment(input: ManualPaymentInput): Promise<ManualPaymentResult> {
  const reference = input.reference.trim();
  if (reference.length < 3 || reference.length > 100) {
    throw new AppError(400, 'INVALID_REFERENCE', 'Enter the payment reference');
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new AppError(400, 'INVALID_AMOUNT', 'The amount must be a positive number of piastres');
  }
  if (!(input.periodEnd.getTime() > input.periodStart.getTime())) {
    throw new AppError(400, 'INVALID_PERIOD', 'The period must end after it starts');
  }
  const { plan } = await loadPayablePlan(input.planCode, input.interval);
  const key = manualPaymentKey(input.method, reference);
  // Runs from the super-admin route with no store scope: resolve the store through
  // the definer (any status), then do the writes inside withStore below.
  const store = await lookupStore({ id: input.storeId }, ['active', 'inactive', 'suspended']);
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');

  const result = await withStore(input.storeId, async (tx: Tx) => {
    const existing = await tx.billingEvent.findUnique({
      where: { idempotencyKey: key, storeId: input.storeId },
    });
    if (existing) {
      if (existing.storeId !== input.storeId) {
        throw new AppError(
          409,
          'REFERENCE_USED_ELSEWHERE',
          'This reference was recorded for another store'
        );
      }
      return { duplicate: true, billingEventId: existing.id };
    }
    const sub = await tx.storeSubscription.findUnique({ where: { storeId: input.storeId } });
    const eventId = crypto.randomUUID();
    const { count } = await tx.billingEvent.createMany({
      data: [
        {
          id: eventId,
          storeId: input.storeId,
          subscriptionId: sub?.id ?? null,
          type: 'manual_payment',
          planCode: plan.code,
          billingInterval: input.interval,
          forPeriodEnd: input.periodEnd,
          amountMinor: input.amountMinor,
          currency: 'EGP',
          provider: 'manual',
          providerRef: reference,
          idempotencyKey: key,
          status: 'succeeded',
          raw: {
            method: input.method,
            paidAt: input.paidAt.toISOString(),
            periodStart: input.periodStart.toISOString(),
            periodEnd: input.periodEnd.toISOString(),
            recordedBy: input.actorId,
          },
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) {
      // The key exists but is not visible in this store's scope: the same
      // reference was recorded for ANOTHER store (strict RLS hides it). Refuse.
      const winner = await tx.billingEvent.findUnique({
        where: { idempotencyKey: key, storeId: input.storeId },
      });
      if (!winner) {
        throw new AppError(
          409,
          'REFERENCE_USED_ELSEWHERE',
          'This reference was recorded for another store'
        );
      }
      return { duplicate: true, billingEventId: winner.id };
    }
    const hasCard = !!sub?.provider && !!sub?.providerPaymentMethodRef;
    const billingMethod = sub?.billingMethod === 'instapay' || !hasCard ? 'instapay' : 'card';
    const data = {
      planCode: plan.code,
      status: 'active' as const,
      billingInterval: input.interval,
      currentPeriodStart: input.periodStart,
      currentPeriodEnd: input.periodEnd,
      trialEndsAt: null,
      pendingPlanCode: null,
      cancelAtPeriodEnd: false,
      dunningAttempts: 0,
      nextRetryAt: null,
      billingMethod,
    };
    if (sub) {
      await tx.storeSubscription.update({ where: { storeId: input.storeId }, data });
    } else {
      await tx.storeSubscription.create({ data: { storeId: input.storeId, ...data } });
    }
    await tx.store.update({ where: { id: input.storeId }, data: { plan: plan.featureTier } });
    // Confirm the merchant's claim: the named one, or the pending one with this reference.
    await tx.manualPaymentClaim.updateMany({
      where: {
        storeId: input.storeId,
        status: 'pending',
        ...(input.claimId
          ? { id: input.claimId }
          : { method: input.method, payerReference: reference }),
      },
      data: {
        status: 'confirmed',
        reviewedBy: input.actorId,
        reviewedAt: new Date(),
        billingEventId: eventId,
      },
    });
    return { duplicate: false, billingEventId: eventId };
  });

  if (!result.duplicate) {
    await featureService.invalidateCache(input.storeId).catch(() => undefined);
    await reconcileStoreAccess(input.storeId);
  }
  return result;
}
