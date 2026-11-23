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
import { restoreRevokedGrants, revokeGrantsForEvent } from './grants.service';
import crypto from 'crypto';
import { prisma, withStore, withUser, acrossStores, type Prisma } from '@ebda/database';
import { AppError } from '../../middleware/error-handler';
import { auditLog } from '../../middleware/security';
import logger from '../../lib/logger';
import { getEntitlements } from '../plan-entitlements';
import { bustStoreCaches } from '../store.service';
import { featureService } from '../feature.service';
import {
  INSTAPAY_GRACE_DAYS,
  addDays,
  addInterval,
  isGrantedPlan,
  isInterval,
  type BillingInterval,
  addIntervalAnchored,
} from './period';
import { normalizeInstapayReference, type InstapayReceiptFields } from '@ebda/shared';
import {
  InstapayReceiptService,
  sniffReceiptMime,
  toReceiptView,
} from '../payment-providers/instapay-receipt.service';
import { StorageService } from '../storage.service';
// Cycle-safe: billing-notify imports this module too; both only call each other at run time.
import { runBillingEffects } from './billing-notify';
import { getEntityStoreId, lookupStore } from '../../lib/definer';
import { withSavepoint } from '../../lib/savepoint';
import { loadPayablePlan } from './subscription-billing.service';
import { instapayHandle, instapayQrUrl } from './manual-config';
import { sendAlert } from '../alerts.service';
import {
  commitManualPaymentD1,
  idempotencyKeyStoreD1,
  lockSubscription,
  onD1,
} from '../platform/billing-d1';
import { platformFamilyOnD1 } from '../platform/cutover';
import { billingParentOf, childCoverage, isBillableStore, sortOwnerStores } from './billing-parent';
import { goLiveVerdict } from './go-live-verdict';
import {
  chargeFor,
  ledgerVat,
  resolvePlatformVat,
  vatOfPaidAmount,
  type LedgerVat,
} from './charge-amount';
import { storeUpdate, storeUpdateMany } from '../../lib/repo-factory';
import { releaseInstapayReference, withClaimReleases } from '../../lib/instapay-ref-claim';

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
    storeUpdateMany(tx, {
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
  // The parent stopped paying: the children it covers go down with it (EBDA-FUNNEL-18).
  if (reason === 'unpaid') await suspendCoveredChildren(storeId, now);
  return true;
}

async function suspendCoveredChildren(parentStoreId: string, now: Date): Promise<void> {
  const parent = await withStore(parentStoreId, tx =>
    tx.store.findUnique({ where: { id: parentStoreId }, select: { ownerId: true } })
  );
  if (!parent?.ownerId) return;
  const stores = await ownerStores(parent.ownerId);
  if (billingParentOf(stores) !== parentStoreId) return; // only the parent cascades
  for (const child of stores.slice(1)) {
    if (child.status === 'active') await suspendForBilling(child.id, 'unpaid', now);
  }
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
    storeUpdateMany(tx, {
      where: { id: storeId, status: 'suspended', billingSuspendedReason: reason },
      data: { status: 'active', billingSuspendedReason: null, billingSuspendedAt: null },
    })
  );
  if (count === 0) return false;
  await afterStatusChange(storeId);
  // Tell the merchant the store is back (audit #11).
  await runBillingEffects([{ kind: 'store_restored', storeId, reason }]);
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
export async function ownerStores(ownerId: string) {
  // ONE ordering for "who is the parent": sortOwnerStores (billing-parent.ts), shared with
  // assertOwnerMayCreateStore and the pure coverage predicate, never a second DB orderBy.
  const rows = await withUser(ownerId, tx =>
    tx.store.findMany({
      where: { ownerId, deletedAt: null },
      select: { id: true, createdAt: true, status: true, billingSuspendedReason: true },
    })
  );
  return sortOwnerStores(rows);
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
 * Is this CHILD store paid for by its billing parent right now? The loader around the pure
 * `childCoverage`: reads only the owner's store rows, the parent's subscription and the
 * parent's plan allowance (platform data - portable to the D1 path unchanged).
 * `parentVerdictCode` is why the parent is not in good standing (for the go-live message).
 */
export async function childStoreCoverage(storeId: string, now: Date = new Date()) {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select: { ownerId: true } })
  );
  const none = { covered: false as const, reason: 'no_parent' as const, parentVerdictCode: null };
  if (!store?.ownerId) return none;
  const stores = await ownerStores(store.ownerId);
  const parentId = billingParentOf(stores);
  if (!parentId) return none;
  const parentSub = await withStore(parentId, tx =>
    tx.storeSubscription.findUnique({ where: { storeId: parentId } })
  );
  // `_mode` is ignored by the verdict; the trial card mode does not matter for a parent here.
  const verdict = goLiveVerdict(parentSub, 'pay_at_trial_end', now);
  const cover = childCoverage({
    storeId,
    stores,
    allowance: await ownerStoreAllowance(store.ownerId),
    parentInGoodStanding: verdict.ok,
  });
  return {
    ...cover,
    parentVerdictCode: verdict.ok ? null : verdict.code,
  };
}

/**
 * Keep every COVERED child's own subscription row in step with its parent, so entitlements
 * (read from the child's own row) follow the parent's plan and the row can never come due:
 * same plan code, no period, no provider, no method, no trial. Idempotent; a child that is
 * not covered is left alone (the allowance suspends it instead). Also heals children created
 * before parent/child billing existed (EBDA-FUNNEL-18).
 */
export async function syncChildSubscriptions(ownerId: string, now: Date = new Date()) {
  const stores = await ownerStores(ownerId);
  const parentId = billingParentOf(stores);
  if (!parentId || stores.length < 2) return;
  const parent = await withStore(parentId, tx =>
    tx.storeSubscription.findUnique({ where: { storeId: parentId } })
  );
  if (!parent) return;
  const featureTier = (await prisma.plan.findUnique({ where: { code: parent.planCode } }))
    ?.featureTier;
  for (const child of stores.slice(1)) {
    if (!(await childStoreCoverage(child.id, now)).covered) continue;
    const status = isGrantedPlan(parent.planCode) ? 'comped' : 'active';
    const { count } = await withStore(child.id, async tx => {
      const r = await tx.storeSubscription.updateMany({
        where: {
          storeId: child.id,
          NOT: {
            planCode: parent.planCode,
            status,
            currentPeriodEnd: null,
            provider: null,
            billingMethod: null,
            pendingPlanCode: null,
            trialEndsAt: null,
            cancelAtPeriodEnd: false,
          },
        },
        data: {
          planCode: parent.planCode,
          status,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          trialEndsAt: null,
          provider: null,
          providerCustomerId: null,
          providerSubscriptionId: null,
          providerPaymentMethodRef: null,
          billingMethod: null,
          pendingPlanCode: null,
          nextRetryAt: null,
          dunningAttempts: 0,
          cancelAtPeriodEnd: false,
        },
      });
      if (r.count > 0 && featureTier) {
        await storeUpdate(tx, { where: { id: child.id }, data: { plan: featureTier } });
      }
      return r;
    });
    if (count > 0) {
      await featureService.invalidateCache(child.id).catch(() => undefined);
      logger.info({ childId: child.id, planCode: parent.planCode }, '[billing] child plan synced');
    }
  }
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
  if (!store.ownerId) return;
  await enforceStoreAllowance(store.ownerId);
  // Children follow the parent: copy its plan onto their rows, and lift an `unpaid`
  // suspension the parent's lapse caused once the parent is in good standing again.
  await syncChildSubscriptions(store.ownerId);
  const stores = await ownerStores(store.ownerId);
  for (const child of stores.slice(1)) {
    if (child.billingSuspendedReason === 'unpaid' && (await childStoreCoverage(child.id)).covered) {
      await restoreFromBilling(child.id, 'unpaid');
    }
  }
}

// ─────────────────────────── payment method ───────────────────────────────

export function newPaymentReference(): string {
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
  // BILLING-INTERVAL-PENDING-1: the payment buys the interval the merchant picked at checkout (pending on an active
  // store), which is what the claim records; the stored `billingInterval` stays the current one until it is paid.
  const interval: BillingInterval = isInterval(sub.pendingBillingInterval)
    ? sub.pendingBillingInterval
    : isInterval(sub.billingInterval)
      ? sub.billingInterval
      : 'monthly';
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  const listPrice = plan
    ? interval === 'yearly'
      ? plan.priceYearlyMinor
      : plan.priceMonthlyMinor
    : null;
  // Through the ONE charge-amount seam (Ebda platform VAT applied there).
  const charge = listPrice === null ? null : await chargeFor(listPrice);
  const vat: LedgerVat | null = charge ? ledgerVat(charge).vat : null;
  return {
    handle,
    qrUrl: handle ? instapayQrUrl() : null,
    reference: sub.paymentReference,
    planCode,
    interval,
    amountMinor: charge ? charge.totalMinor : null,
    /** Ebda VAT inside the amount + TRN/legal name; null = no VAT line. */
    vat,
  };
}

/**
 * Fail-closed money predicate for the charge paths (renewal): true only when this store is
 * billed on its own - the owner's oldest store, or a store with no owner family. A store the
 * owner list does not contain answers false, so a charge is never raised on an unknown child.
 */
export async function isBillableStoreId(storeId: string): Promise<boolean> {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select: { ownerId: true } })
  );
  if (!store) return false; // unknown/hidden store: never raise a charge on it
  if (!store.ownerId) return true;
  return isBillableStore(storeId, await ownerStores(store.ownerId));
}

/**
 * Only the billing PARENT (the owner's oldest store) is ever charged or asked to pay; every
 * other store is a CHILD, included in the parent's plan (R-EBDA-PRICING-6, Ruling
 * EBDA-FUNNEL-18). Paying on a child either buys nothing (beyond the allowance: it would be
 * suspended again at once, audit M4) or double-charges (within the allowance: the parent's
 * plan already pays for it). Refuse both with the store to pay on (409 PAY_ON_PARENT_STORE;
 * `details.included` tells the UI which message to show). Every money-IN entry point calls
 * this: checkout, card setup, trial plan, plan change, InstaPay choice/receipt/manual payment.
 */
export async function assertPayableStore(storeId: string): Promise<void> {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true, billingSuspendedReason: true },
    })
  );
  if (!store) {
    throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found'); // fail closed
  }
  if (!store.ownerId) return; // platform-operated store: billed on its own, no owner family
  const stores = await ownerStores(store.ownerId);
  if (isBillableStore(storeId, stores)) return;
  const parentStoreId = billingParentOf(stores);
  const { rank, allowance } = await storeRank(storeId);
  const included =
    rank >= 0 && rank < allowance && store.billingSuspendedReason !== 'over_store_limit';
  throw new AppError(
    409,
    'PAY_ON_PARENT_STORE',
    included
      ? "This store is included in your main store's plan. Manage billing on the main store."
      : 'This store is paused because your plan allows fewer stores. Upgrade your main store to bring it back.',
    { parentStoreId, allowance: Number.isFinite(allowance) ? allowance : null, included }
  );
}

/**
 * The merchant picks how the subscription is paid. `instapay` needs the handle
 * configured (fail closed) and gets a unique payment reference once. `card` is
 * recorded by the card-setup webhook, not here. A CANCELED store may choose it
 * too: paying is how it comes back (audit #2).
 */
export async function chooseInstapay(storeId: string) {
  if (!instapayHandle()) {
    throw new AppError(409, 'INSTAPAY_NOT_CONFIGURED', 'InstaPay is not available right now');
  }
  await assertPayableStore(storeId);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const updated = await withStore(storeId, async tx => {
        const sub = await tx.storeSubscription.findUnique({ where: { storeId } });
        if (!sub || !['trialing', 'active', 'past_due', 'canceled'].includes(sub.status)) {
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

/**
 * InstaPay plan choice (audit M3): the plan + interval the NEXT InstaPay payment
 * buys, for any state — trialing (billed at trial end), active/past_due (upgrade or
 * downgrade: applied when the payment is approved), canceled (paying brings the store
 * back). Nothing is charged and nothing changes tier here; the approved payment does.
 * Card subscriptions keep `changePlan`.
 */
export async function chooseInstapayPlan(args: {
  storeId: string;
  planCode: string;
  interval: BillingInterval;
}) {
  const { plan } = await loadPayablePlan(args.planCode, args.interval);
  if (!plan.isPublic) {
    throw new AppError(400, 'PLAN_NOT_PURCHASABLE', 'This plan cannot be purchased');
  }
  await assertPayableStore(args.storeId);
  await withStore(args.storeId, async tx => {
    const sub = await tx.storeSubscription.findUnique({ where: { storeId: args.storeId } });
    if (!sub) throw new AppError(409, 'NO_SUBSCRIPTION', 'This store has no subscription');
    if (sub.status === 'comped') {
      throw new AppError(409, 'STORE_COMPED', 'Comped stores are not billed');
    }
    if (sub.billingMethod === 'card' && sub.providerPaymentMethodRef && sub.status !== 'canceled') {
      throw new AppError(409, 'USE_CHANGE_PLAN', 'This store pays by card: use change plan');
    }
    const samePlan =
      sub.status !== 'canceled' && sub.status !== 'trialing' && plan.code === sub.planCode;
    // Ruling BILLING-INTERVAL-PENDING-1: on an ACTIVE subscription the interval is a CHOICE until its payment is
    // recorded. Writing it now would pair the old period end (e.g. a yearly grant) with the new interval's price.
    // Everything without a live paid period (trialing, past_due, canceled) keeps writing it directly.
    const deferInterval = sub.status === 'active';
    await tx.storeSubscription.update({
      where: { storeId: args.storeId },
      data: {
        pendingPlanCode: samePlan ? null : plan.code,
        ...(deferInterval
          ? {
              pendingBillingInterval: args.interval === sub.billingInterval ? null : args.interval,
            }
          : { billingInterval: args.interval, pendingBillingInterval: null }),
        cancelAtPeriodEnd: false,
      },
    });
  });
  await chooseInstapay(args.storeId);
  return instapayDetails(args.storeId);
}

// ───────────────────────────── period rule ────────────────────────────────

/**
 * Where a manually paid period starts (audit M2): never before the time the store
 * already has. Paying early (reminders start 7 days ahead) starts at the current period
 * end; paying during the trial starts at the trial end; paying late, or from canceled,
 * starts now. Pure: unit-tested and mutation-checked.
 */
export function manualPeriodFor(
  sub: {
    status: string;
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
    billingAnchorDay?: number | null;
  } | null,
  interval: BillingInterval,
  now: Date
): { periodStart: Date; periodEnd: Date } {
  let start = now;
  if (sub?.status === 'trialing' && sub.trialEndsAt && sub.trialEndsAt > now) {
    start = sub.trialEndsAt;
  } else if (
    (sub?.status === 'active' || sub?.status === 'past_due') &&
    sub.currentPeriodEnd &&
    sub.currentPeriodEnd > now
  ) {
    start = sub.currentPeriodEnd;
  }
  // clamp from the cycle's anchor day (M-125); a store with none yet anchors on this period's start
  // The anchor only continues a LIVE cycle (the period starts where the previous one ended). A period that starts
  // now (lapsed / canceled / first payment) begins a new cycle on its own day, whatever an old anchor says.
  const continuesCycle =
    !!sub?.currentPeriodEnd &&
    start.getTime() === sub.currentPeriodEnd.getTime() &&
    sub.status !== 'trialing';
  return {
    periodStart: start,
    periodEnd: addIntervalAnchored(
      start,
      interval,
      continuesCycle ? (sub?.billingAnchorDay ?? start.getUTCDate()) : start.getUTCDate()
    ),
  };
}

export async function suggestManualPeriod(
  storeId: string,
  interval: BillingInterval,
  now: Date = new Date()
) {
  const sub = await withStore(storeId, tx =>
    tx.storeSubscription.findUnique({ where: { storeId } })
  );
  return manualPeriodFor(sub, interval, now);
}

// ───────────────────────────── claims ─────────────────────────────────────

/**
 * Put a receipt this call just submitted back to draft and free its cross-store transfer reference. The reference is
 * released DIRECTLY, not queued: every caller throws right after, and a queued release is dropped on a throw
 * (`withClaimReleases`), which left the D1 reference bound to a draft receipt (the re-upload then failed with
 * DUPLICATE_REFERENCE). The release is idempotent and only frees a claim bound to THIS receipt.
 */
export async function undoSubmittedReceipt(
  tx: Pick<Tx, 'instapayReceipt'>,
  receipt: { id: string; referenceKey: string | null },
  storeId: string
): Promise<void> {
  await tx.instapayReceipt.updateMany({
    where: { id: receipt.id, storeId },
    data: { status: 'draft', referenceKey: null, submittedAt: null },
  });
  if (receipt.referenceKey) {
    await releaseInstapayReference(receipt.referenceKey, storeId, receipt.id).catch(
      () => undefined
    );
  }
}

/**
 * Merchant: submit the InstaPay receipt for the subscription (the screenshot was
 * uploaded first, the AI pre-filled it, the merchant corrected it). Creates the claim
 * the super-admin reviews. NEVER activates anything (only the super-admin's recorded
 * payment does).
 */
async function submitSubscriptionReceiptInner(args: {
  storeId: string;
  receiptId: string;
  fields: InstapayReceiptFields;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  await assertPayableStore(args.storeId);
  const details = await instapayDetails(args.storeId);
  if (!details?.reference || !details.amountMinor) {
    throw new AppError(409, 'INSTAPAY_NOT_CHOSEN', 'Choose a plan and InstaPay first');
  }
  const reference = normalizeInstapayReference(args.fields.reference)!;
  return withStore(args.storeId, async tx => {
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
    const lastPaid = await tx.billingEvent.findFirst({
      where: { storeId: args.storeId, type: 'manual_payment', status: 'succeeded' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const oldest = new Date(now.getTime() - 30 * 86_400_000);
    const notBefore = lastPaid && lastPaid.createdAt > oldest ? lastPaid.createdAt : oldest;
    const receipt = await InstapayReceiptService.submit({
      storeId: args.storeId,
      receiptId: args.receiptId,
      scope: { kind: 'subscription' },
      fields: args.fields,
      expectedAmountMinor: details.amountMinor,
      expectedReceivers: details.handle ? [details.handle] : [],
      notBefore,
      now,
    });
    // The receipt is a draft again: its D1 reference claim (Ruling INSTAPAY-DO-1) is freed once this transaction commits.
    const undoReceiptSubmit = () => undoSubmittedReceipt(tx, receipt, args.storeId);
    let claim;
    try {
      claim = await withSavepoint(() =>
        tx.manualPaymentClaim.create({
          data: {
            storeId: args.storeId,
            subscriptionId: sub?.id ?? null,
            planCode: details.planCode,
            billingInterval: details.interval,
            amountMinor: details.amountMinor!,
            method: 'instapay',
            paymentReference: details.reference!,
            payerReference: reference,
          },
        })
      );
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') {
        // Postgres rolls the receipt submit back with this transaction; on D1 (Ruling NZ-10D-3) there is no transaction, so the
        // receipt would stay `submitted` without a claim. Undo it by hand, then surface the original error.
        if (await platformFamilyOnD1('payments')) await undoReceiptSubmit().catch(() => undefined);
        throw err;
      }
      // A legacy claim already holds this transfer reference: undo the receipt claim.
      await undoReceiptSubmit();
      throw new AppError(
        409,
        'DUPLICATE_REFERENCE',
        'This transfer reference was already used. Each transfer can pay only once.'
      );
    }
    let linked;
    try {
      linked = await tx.instapayReceipt.update({
        where: { id: receipt.id, storeId: args.storeId },
        data: { claimId: claim.id },
      });
    } catch (err) {
      // D1 has no rollback (see above): remove the claim THIS call made and reopen the receipt.
      if (await platformFamilyOnD1('payments')) {
        await tx.manualPaymentClaim
          .deleteMany({ where: { id: claim.id, storeId: args.storeId, status: 'pending' } })
          .catch(() => undefined);
        await undoReceiptSubmit().catch(() => undefined);
      }
      throw err;
    }
    return { claim, receipt: toReceiptView(linked) };
  });
}

export async function listStoreClaims(storeId: string) {
  return withStore(storeId, async tx => {
    const claims = await tx.manualPaymentClaim.findMany({
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
    });
    const receipts = claims.length
      ? await tx.instapayReceipt.findMany({
          where: { storeId, claimId: { in: claims.map(c => c.id) } },
        })
      : [];
    return claims.map(c => {
      const r = receipts.find(x => x.claimId === c.id);
      return { ...c, receipt: r ? toReceiptView(r) : null };
    });
  });
}

/** Super-admin queue: claims across stores (each read in its own store scope). */
export async function listClaimsForAdmin(status: 'pending' | 'confirmed' | 'rejected' = 'pending') {
  const now = new Date();
  type ClaimRow = Prisma.ManualPaymentClaimGetPayload<{
    include: {
      store: { select: { name: true; slug: true; status: true; billingSuspendedReason: true } };
    };
  }>;
  const shape = async (storeId: string | undefined, claims: ClaimRow[]) => {
    if (claims.length === 0) return [];
    const ids = [...new Set(claims.map(c => c.storeId))];
    const [receipts, subs] = await Promise.all([
      prisma.instapayReceipt.findMany({
        where: { ...(storeId ? { storeId } : {}), claimId: { in: claims.map(c => c.id) } },
      }),
      prisma.storeSubscription.findMany({ where: { storeId: { in: ids } } }),
    ]);
    return claims.map(c => {
      const r = receipts.find(x => x.claimId === c.id);
      const sub = subs.find(x => x.storeId === c.storeId) ?? null;
      const interval: BillingInterval = isInterval(c.billingInterval)
        ? c.billingInterval
        : 'monthly';
      const period = manualPeriodFor(sub, interval, now);
      return {
        claim: c,
        receipt: r ? toReceiptView(r) : null,
        period,
        subStatus: sub?.status ?? null,
      };
    });
  };
  const include = {
    store: { select: { name: true, slug: true, status: true, billingSuspendedReason: true } },
  } as const;
  // D1: ONE query over every store's claims (the oldest 200 of the queue), no Postgres scope per store.
  const parts = (await platformFamilyOnD1('payments'))
    ? [
        {
          value: await shape(
            undefined,
            await prisma.manualPaymentClaim.findMany({
              where: { status },
              include,
              orderBy: { createdAt: 'asc' },
              take: 200,
            })
          ),
        },
      ]
    : await acrossStores(
        async storeId =>
          shape(
            storeId,
            await prisma.manualPaymentClaim.findMany({
              where: { storeId, status },
              include,
              orderBy: { createdAt: 'asc' },
              take: 200,
            })
          ),
        { abortOnError: true }
      );
  return parts
    .flatMap(p => p.value)
    .sort((a, b) => a.claim.createdAt.getTime() - b.claim.createdAt.getTime())
    .map(({ claim: c, receipt, period, subStatus }) => ({
      id: c.id,
      storeId: c.storeId,
      storeName: c.store.name,
      storeSlug: c.store.slug,
      storeStatus: c.store.status,
      storeSuspendedReason: c.store.billingSuspendedReason,
      subscriptionStatus: subStatus,
      planCode: c.planCode,
      billingInterval: c.billingInterval,
      amountMinor: c.amountMinor,
      method: c.method,
      paymentReference: c.paymentReference,
      payerReference: c.payerReference,
      proofUrl: c.proofUrl,
      status: c.status,
      reviewNote: c.reviewNote,
      createdAt: c.createdAt,
      receipt,
      /** The period an approval would record (audit M2: never burns paid days). */
      suggestedPeriodStart: period.periodStart,
      suggestedPeriodEnd: period.periodEnd,
    }));
}

/** A rejected/voided claim frees its transfer reference (the claim's unique index) for re-filing. */
const freedReference = (ref: string, claimId: string, tag: 'rejected' | 'voided') =>
  `${ref}#${tag}-${claimId.slice(0, 8)}`.slice(0, 120);

async function rejectClaimInner(args: {
  storeId: string;
  claimId: string;
  note: string;
  actorId: string;
}) {
  const note = args.note.trim();
  if (note.length < 3)
    throw new AppError(400, 'REASON_REQUIRED', 'Write why the payment is rejected');
  await withStore(args.storeId, async tx => {
    const claim = await tx.manualPaymentClaim.findFirst({
      where: { id: args.claimId, storeId: args.storeId, status: 'pending' },
    });
    if (!claim) throw new AppError(409, 'CLAIM_NOT_PENDING', 'This claim is not pending');
    await tx.manualPaymentClaim.update({
      where: { id: claim.id, storeId: args.storeId },
      data: {
        status: 'rejected',
        payerReference: freedReference(claim.payerReference, claim.id, 'rejected'),
        reviewNote: note.slice(0, 500),
        reviewedBy: args.actorId,
        reviewedAt: new Date(),
      },
    });
    const receipt = await tx.instapayReceipt.findFirst({
      where: { storeId: args.storeId, claimId: claim.id },
      select: { id: true },
    });
    if (receipt) {
      await InstapayReceiptService.markReviewed(
        args.storeId,
        receipt.id,
        { status: 'rejected', note },
        args.actorId
      );
    }
  });
  await runBillingEffects([{ kind: 'payment_rejected', storeId: args.storeId, note }]);
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
  /**
   * Omitted (the default) = the period rule (`manualPeriodFor`): never burns paid
   * days. Given = an explicit operator override (both must be set).
   */
  periodStart?: Date | null;
  periodEnd?: Date | null;
  actorId: string;
  claimId?: string;
  /**
   * Ruling BILLING-AMOUNT-GUARD-1: the amount must equal the charge for plan + interval (list price through the VAT
   * seam). A different amount (partial transfer, discount, typo) is refused unless the operator states why here; the
   * reason lands in the ledger row and the audit trail.
   */
  overrideAmountReason?: string | null;
  /**
   * The ledger is append-only, so a VOIDED payment keeps its key. To record the same
   * transfer reference for the right store, name the voided payment here: it must be a
   * voided manual payment with exactly this reference; it can be replaced once.
   */
  replacesVoidedEventId?: string | null;
  now?: Date;
}

export type ManualPaymentResult = {
  duplicate: boolean;
  billingEventId: string;
  periodStart?: Date;
  periodEnd?: Date;
  /** @internal receipts approved by this payment; consumed (and stripped) by recordManualPayment */
  approvedReceiptIds?: string[];
};

/** The idempotency key of a manual payment: one per (method, payer reference). */
export const manualPaymentKey = (method: ManualMethod, reference: string) =>
  `manual:${method}:${(method === 'instapay' ? (normalizeInstapayReference(reference) ?? reference) : reference).trim().toLowerCase()}`;

/**
 * Super-admin "Record manual payment & activate". ONE store-scoped transaction:
 * the ledger row (UNIQUE idempotency key = method + payer reference), the
 * subscription period, the store's plan tier, the claim confirmation and the
 * receipt approval. A repeat with the same reference changes nothing and returns the
 * first row. Effects (restore an `unpaid` suspension, re-apply the store allowance,
 * caches, the merchant's "payment confirmed" notice) run after the commit.
 */
export async function recordManualPayment(input: ManualPaymentInput): Promise<ManualPaymentResult> {
  const now = input.now ?? new Date();
  const reference = input.reference.trim();
  if (reference.length < 3 || reference.length > 100) {
    throw new AppError(400, 'INVALID_REFERENCE', 'Enter the payment reference');
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new AppError(400, 'INVALID_AMOUNT', 'The amount must be a positive number of piastres');
  }
  const explicit = !!input.periodStart || !!input.periodEnd;
  if (explicit && !(input.periodStart && input.periodEnd)) {
    throw new AppError(400, 'INVALID_PERIOD', 'Give both the period start and end, or neither');
  }
  if (explicit && !(input.periodEnd!.getTime() > input.periodStart!.getTime())) {
    throw new AppError(400, 'INVALID_PERIOD', 'The period must end after it starts');
  }
  const { plan, price } = await loadPayablePlan(input.planCode, input.interval);
  const overrideReason = input.overrideAmountReason?.trim() || null;
  if (overrideReason && (overrideReason.length < 3 || overrideReason.length > 300)) {
    throw new AppError(400, 'INVALID_OVERRIDE_REASON', 'Give a short reason (3-300 characters)');
  }
  let key = manualPaymentKey(input.method, reference);
  if (input.replacesVoidedEventId) {
    const vStore = await getEntityStoreId('billing_event', input.replacesVoidedEventId);
    const voided = vStore
      ? await withStore(vStore, async tx => {
          const ev = await tx.billingEvent.findUnique({
            where: { id: input.replacesVoidedEventId!, storeId: vStore },
          });
          const voidRow = await tx.billingEvent.findUnique({
            where: {
              idempotencyKey: `manual-void:${input.replacesVoidedEventId}`,
              storeId: vStore,
            },
          });
          return ev && voidRow && ev.type === 'manual_payment' && ev.status === 'refunded'
            ? ev
            : null;
        })
      : null;
    if (!voided || voided.idempotencyKey !== key) {
      throw new AppError(
        409,
        'NOT_A_VOIDED_PAYMENT',
        'That payment was not voided, or it has a different reference'
      );
    }
    key = `${key}:after-void:${voided.id}`;
  }
  // The money received is the gross: carve Ebda's VAT (if ON) out of it for the ledger.
  const paidVat = ledgerVat(vatOfPaidAmount(input.amountMinor, await resolvePlatformVat()));
  // Runs from the super-admin route with no store scope: resolve the store through
  // the definer (any status), then do the writes inside withStore below.
  const store = await lookupStore({ id: input.storeId }, ['active', 'inactive', 'suspended']);
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  await assertPayableStore(input.storeId);

  // The Postgres half of a manual payment: the tier on `stores`, the merchant's claim and the receipt behind it. Every
  // statement is idempotent on the event id, so a retry (and the heal below) repeats it safely.
  const pgHalf = async (tx: Tx, eventId: string): Promise<string[]> => {
    await storeUpdate(tx, { where: { id: input.storeId }, data: { plan: plan.featureTier } });
    // Confirm the merchant's claim: the named one, or the pending one with this reference.
    await tx.manualPaymentClaim.updateMany({
      where: {
        storeId: input.storeId,
        status: 'pending',
        ...(input.claimId
          ? { id: input.claimId }
          : {
              method: input.method,
              payerReference: {
                in: [reference, normalizeInstapayReference(reference) ?? reference],
              },
            }),
      },
      data: {
        status: 'confirmed',
        reviewedBy: input.actorId,
        reviewedAt: now,
        billingEventId: eventId,
      },
    });
    // ...and the receipt behind it: approved by the super-admin (the human approval).
    const confirmed = await tx.manualPaymentClaim.findMany({
      where: { storeId: input.storeId, billingEventId: eventId },
      select: { id: true },
    });
    let approvedReceiptIds: string[] = [];
    if (confirmed.length) {
      approvedReceiptIds = await InstapayReceiptService.approveSubmitted(
        tx,
        input.storeId,
        { claimIds: confirmed.map(c => c.id) },
        input.actorId,
        now
      );
    }
    return approvedReceiptIds;
  };

  const result = await withStore(input.storeId, async (tx: Tx) => {
    const existing = await tx.billingEvent.findUnique({
      where: { idempotencyKey: key, storeId: input.storeId },
    });
    if (existing) {
      // D1: the ledger row is committed BEFORE the Postgres half, so a replay may be the retry of a request whose
      // Postgres half failed. Repeat it (idempotent) while the subscription is still on this payment's plan, never
      // after the store moved on (a stale replay must not drag stores.plan back).
      if (await onD1()) {
        const current = await tx.storeSubscription.findUnique({
          where: { storeId: input.storeId },
        });
        if (current?.planCode === plan.code && current.status === 'active')
          await pgHalf(tx, existing.id);
      }
      return { duplicate: true, billingEventId: existing.id } as ManualPaymentResult;
    }
    // Ruling BILLING-AMOUNT-GUARD-1 - AFTER the replay check above, so a retry of an already recorded payment returns
    // `duplicate` even when the price has moved since. The expected amount is what the merchant was told and the receipt
    // was checked against: the stored claim's amount (named, or the pending one with this reference); the current list
    // price only when there is no claim.
    const claim = await tx.manualPaymentClaim.findFirst({
      where: {
        storeId: input.storeId,
        ...(input.claimId
          ? { id: input.claimId }
          : {
              status: 'pending',
              method: input.method,
              payerReference: {
                in: [reference, normalizeInstapayReference(reference) ?? reference],
              },
            }),
      },
      select: { amountMinor: true },
    });
    const expectedAmountMinor = claim?.amountMinor ?? (await chargeFor(price)).totalMinor;
    if (input.amountMinor !== expectedAmountMinor && !overrideReason) {
      throw new AppError(
        409,
        'AMOUNT_MISMATCH',
        'The amount is not what this payment was quoted at. Check it, or give a reason to record it anyway.',
        { expectedAmountMinor, amountMinor: input.amountMinor }
      );
    }
    // Row lock first: a free-month grant (grants.service) moves currentPeriodEnd under the same lock, so the
    // period computed below is never from a read a grant is about to change.
    await lockSubscription(tx, input.storeId);
    const sub = await tx.storeSubscription.findUnique({ where: { storeId: input.storeId } });
    const { periodStart, periodEnd } = explicit
      ? { periodStart: input.periodStart!, periodEnd: input.periodEnd! }
      : manualPeriodFor(sub, input.interval, now);
    // D1: the event id is derived from the idempotency key, so a retry after a partial run reuses it; the D1 write is the
    // FIRST change (fail closed), the idempotent Postgres half follows (Ruling NZ-10-2).
    const d1 = await onD1();
    const eventId = d1
      ? deterministicUuid(`manual-payment:${input.storeId}:${key}`)
      : crypto.randomUUID();
    const ledgerRaw = {
      method: input.method,
      paidAt: input.paidAt.toISOString(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      periodRule: explicit ? 'operator_override' : 'max(now, current_end)',
      previousPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
      previousStatus: sub?.status ?? null,
      recordedBy: input.actorId,
      ...(input.amountMinor !== expectedAmountMinor
        ? { expectedAmountMinor, amountOverrideReason: overrideReason }
        : {}),
    };
    const hasCard = !!sub?.provider && !!sub?.providerPaymentMethodRef;
    const billingMethod = sub?.billingMethod === 'instapay' || !hasCard ? 'instapay' : 'card';
    const data = {
      planCode: plan.code,
      status: 'active' as const,
      billingInterval: input.interval,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      // keep the cycle's anchor day; the first paid period anchors on its own start (M-125)
      billingAnchorDay:
        !explicit &&
        sub?.billingAnchorDay &&
        sub.currentPeriodEnd?.getTime() === periodStart.getTime()
          ? sub.billingAnchorDay
          : periodStart.getUTCDate(),
      trialEndsAt: null,
      pendingPlanCode: null,
      pendingBillingInterval: null, // the paid interval is now the current one (BILLING-INTERVAL-PENDING-1)
      cancelAtPeriodEnd: false,
      dunningAttempts: 0,
      nextRetryAt: null,
      billingMethod,
    };
    if (d1) {
      // FAIL CLOSED: the D1 write comes FIRST, before any Postgres change. A reference another store already holds, a
      // lost compare-and-set or any D1 error is refused here, with stores.plan, the claim and the receipt untouched.
      const holder = await idempotencyKeyStoreD1(key);
      if (holder && holder !== input.storeId)
        throw new AppError(
          409,
          'REFERENCE_USED_ELSEWHERE',
          'This reference was recorded for another store'
        );
      const outcome = await commitManualPaymentD1({
        eventId,
        idempotencyKey: key,
        storeId: input.storeId,
        subscriptionId: sub?.id ?? null,
        planCode: plan.code,
        interval: input.interval,
        periodStart,
        periodEnd,
        amountMinor: input.amountMinor,
        providerRef: reference,
        vatMinor: paidVat.vatMinor,
        vat: paidVat.vat ?? null,
        raw: ledgerRaw,
        anchorDay: data.billingAnchorDay,
        billingMethod,
        expectedSubUpdatedAt: sub?.updatedAt ?? null,
        now,
      });
      if (outcome === 'conflict') {
        const racer = await idempotencyKeyStoreD1(key);
        if (racer && racer !== input.storeId)
          throw new AppError(
            409,
            'REFERENCE_USED_ELSEWHERE',
            'This reference was recorded for another store'
          );
        throw new AppError(
          409,
          'SUBSCRIPTION_CHANGED',
          'The subscription changed while this payment was being recorded; retry',
          { retryable: true }
        );
      }
      if (outcome === 'duplicate') {
        await pgHalf(tx, eventId);
        return { duplicate: true, billingEventId: eventId } as ManualPaymentResult;
      }
    } else {
      const { count } = await tx.billingEvent.createMany({
        data: [
          {
            id: eventId,
            storeId: input.storeId,
            subscriptionId: sub?.id ?? null,
            type: 'manual_payment',
            planCode: plan.code,
            billingInterval: input.interval,
            forPeriodEnd: periodEnd,
            amountMinor: input.amountMinor,
            currency: 'EGP',
            provider: 'manual',
            providerRef: reference,
            idempotencyKey: key,
            status: 'succeeded',
            vatMinor: paidVat.vatMinor,
            vat: paidVat.vat ? (paidVat.vat as unknown as Prisma.InputJsonValue) : undefined,
            raw: ledgerRaw,
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
        return { duplicate: true, billingEventId: winner.id } as ManualPaymentResult;
      }
      if (sub) {
        await tx.storeSubscription.update({ where: { storeId: input.storeId }, data });
      } else {
        await tx.storeSubscription.create({ data: { storeId: input.storeId, ...data } });
      }
    }
    let approvedReceiptIds: string[];
    try {
      approvedReceiptIds = await pgHalf(tx, eventId);
    } catch (err) {
      // D1 already holds the ledger row + subscription: the retry (same key) repeats this half.
      if (d1)
        void sendAlert({
          level: 'p1',
          title: 'Billing: manual payment recorded in D1 but the Postgres half failed',
          body: `store ${input.storeId}, key ${key}, event ${eventId}. Retry the same request (idempotent).`,
        }).catch(() => undefined);
      throw err;
    }
    return {
      duplicate: false,
      billingEventId: eventId,
      periodStart,
      periodEnd,
      approvedReceiptIds,
    };
  });

  if (!result.duplicate) {
    // the approved receipts' screenshots are deleted now that the approval has committed (M-003; a miss is retried weekly)
    await InstapayReceiptService.deleteImages(input.storeId, result.approvedReceiptIds ?? []);
    await featureService.invalidateCache(input.storeId).catch(() => undefined);
    await reconcileStoreAccess(input.storeId);
    await runBillingEffects([
      {
        kind: 'payment_confirmed',
        storeId: input.storeId,
        planCode: plan.code,
        periodEnd: result.periodEnd!,
        billingEventId: result.billingEventId,
      },
      { kind: 'subscription_paid', storeId: input.storeId, billingEventId: result.billingEventId },
    ]);
  }
  const { approvedReceiptIds: _internal, ...publicResult } = result;
  return publicResult;
}

/** A stable UUID (v4 shape) derived from `seed`, so a retried operation reuses the id it chose the first time. */
function deterministicUuid(seed: string): string {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

// ───────────────────────── manual refund / void ───────────────────────────

export interface ManualRefundInput {
  /** The `manual_payment` ledger row. */
  eventId: string;
  /**
   * refund = money went back to the payer outside Ebda (a refund transfer exists);
   * void = the payment was recorded in error (wrong store, never arrived): the
   * whole amount is reversed, the merchant's receipt/claim reference is freed, and the
   * same reference can be recorded for the right store with `replacesVoidedEventId`.
   */
  kind: 'refund' | 'void';
  /** refund: the refund transfer's reference (idempotency key). void: optional. */
  reference?: string | null;
  refundedAt: Date;
  /** Who received the refund, exactly as shown on the refund receipt. */
  recipientName?: string | null;
  /** refund: defaults to the remaining amount. void: always the remaining amount. */
  amountMinor?: number | null;
  note: string;
  /** Override where the paid period now ends; default = full reversal -> the period start it bought. */
  newPeriodEnd?: Date | null;
  screenshot?: Buffer | null;
  actorId: string;
  now?: Date;
}

/**
 * Super-admin "Record manual refund / void" for an InstaPay (manual) subscription
 * payment (audit M1). No money moves here: the refund happened outside Ebda; this
 * RECORDS it, idempotent on the refund reference (void: one per payment), and adjusts
 * the paid period. Audit-logged by the route.
 */
async function recordManualRefundInner(input: ManualRefundInput) {
  const now = input.now ?? new Date();
  const note = input.note.trim();
  if (note.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Write why');
  const storeId = await getEntityStoreId('billing_event', input.eventId);
  if (!storeId) throw new AppError(404, 'CHARGE_NOT_FOUND', 'Payment not found');
  let refundRef: string | null = null;
  if (input.kind === 'refund') {
    refundRef = normalizeInstapayReference(input.reference);
    if (!refundRef) {
      throw new AppError(400, 'INVALID_REFERENCE', 'The refund reference is 8 to 20 digits');
    }
    if (!input.recipientName?.trim()) {
      throw new AppError(400, 'RECIPIENT_REQUIRED', 'Write the name shown on the refund receipt');
    }
  }
  const key =
    input.kind === 'refund' ? `manual-refund:${refundRef}` : `manual-void:${input.eventId}`;

  let screenshotKey: string | null = null;
  if (input.screenshot?.length) {
    const mime = sniffReceiptMime(input.screenshot);
    if (!mime) throw new AppError(400, 'INVALID_FILE_TYPE', 'Upload a JPG, PNG or WebP screenshot');
    screenshotKey = (
      await StorageService.putPrivate(input.screenshot, {
        storeId,
        folder: 'instapay-refunds',
        ext: mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg',
        contentType: mime,
      })
    ).key;
  }

  const out = await withStore(storeId, async tx => {
    const existing = await tx.billingEvent.findUnique({ where: { idempotencyKey: key, storeId } });
    if (existing) {
      if (existing.relatedEventId !== input.eventId) {
        throw new AppError(
          409,
          'REFERENCE_USED_ELSEWHERE',
          'This refund reference was already recorded'
        );
      }
      return {
        duplicate: true,
        refundEventId: existing.id,
        periodEnd: null as Date | null,
        voidedEventId: null as string | null,
      };
    }
    const charge = await tx.billingEvent.findUnique({ where: { id: input.eventId, storeId } });
    if (!charge || charge.type !== 'manual_payment') {
      throw new AppError(404, 'CHARGE_NOT_FOUND', 'Manual payment not found');
    }
    if (!['succeeded', 'refunded'].includes(charge.status)) {
      throw new AppError(409, 'NOT_REFUNDABLE', 'Only a recorded payment can be refunded');
    }
    const prior = await tx.billingEvent.aggregate({
      where: { storeId, relatedEventId: charge.id, type: 'refund', status: 'succeeded' },
      _sum: { amountMinor: true },
    });
    const remaining = charge.amountMinor - (prior._sum.amountMinor ?? 0);
    if (remaining <= 0)
      throw new AppError(409, 'ALREADY_REFUNDED', 'This payment is fully refunded');
    const amount = input.kind === 'void' ? remaining : (input.amountMinor ?? remaining);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) {
      throw new AppError(
        400,
        'INVALID_REFUND_AMOUNT',
        `Refund must be between 1 and ${remaining} piastres`
      );
    }
    const vatMinor = charge.vatMinor
      ? Math.round((charge.vatMinor * amount) / charge.amountMinor)
      : 0;
    const raw = (charge.raw ?? {}) as Record<string, unknown>;
    const fullReversal =
      amount === remaining && (prior._sum.amountMinor ?? 0) + amount >= charge.amountMinor;

    // FOUNDING-3: a full reversal also takes back the free months this payment earned, BEFORE the period is read
    // below, so `ownsCurrentPeriod` sees the end the payment itself set (a granted month would hide it).
    if (fullReversal) await revokeGrantsForEvent(tx, charge.id, 'payment_refunded', now, storeId);
    // Period: a full reversal gives back exactly the time it bought; a partial
    // refund changes the period only when the operator says so.
    const sub = await tx.storeSubscription.findUnique({ where: { storeId } });
    let periodEnd: Date | null = null;
    const boughtStart = typeof raw.periodStart === 'string' ? new Date(raw.periodStart) : null;
    const target = input.newPeriodEnd ?? (fullReversal ? boughtStart : null);
    const ownsCurrentPeriod =
      !!sub?.currentPeriodEnd &&
      !!charge.forPeriodEnd &&
      sub.currentPeriodEnd.getTime() === charge.forPeriodEnd.getTime();
    if (
      sub &&
      target &&
      ['active', 'past_due'].includes(sub.status) &&
      (ownsCurrentPeriod || input.newPeriodEnd)
    ) {
      periodEnd = target;
      const overdue = target.getTime() <= now.getTime();
      await tx.storeSubscription.update({
        where: { storeId },
        data: overdue
          ? {
              currentPeriodEnd: target,
              status: 'past_due',
              nextRetryAt: new Date(
                Math.max(now.getTime(), addDays(target, INSTAPAY_GRACE_DAYS).getTime())
              ),
            }
          : { currentPeriodEnd: target },
      });
    }

    const refundId = crypto.randomUUID();
    await tx.billingEvent.create({
      data: {
        id: refundId,
        storeId,
        subscriptionId: charge.subscriptionId,
        type: 'refund',
        planCode: charge.planCode,
        billingInterval: charge.billingInterval,
        amountMinor: amount,
        currency: charge.currency,
        provider: 'manual',
        providerRef: refundRef,
        idempotencyKey: key,
        status: 'succeeded',
        relatedEventId: charge.id,
        vatMinor,
        raw: {
          kind: input.kind,
          refundReference: input.reference?.trim() || null,
          refundedAt: input.refundedAt.toISOString(),
          recipientName: input.recipientName?.trim() || null,
          note,
          screenshotKey,
          previousPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
          newPeriodEnd: periodEnd?.toISOString() ?? null,
          recordedBy: input.actorId,
        },
      },
    });
    if (fullReversal) {
      await tx.billingEvent.update({
        where: { id: charge.id, storeId },
        data: {
          status: 'refunded',
          // A void frees the transfer reference so it can be recorded for the right store.
        },
      });
    }
    if (input.kind === 'void') {
      const claims = await tx.manualPaymentClaim.findMany({
        where: { storeId, billingEventId: charge.id },
      });
      for (const c of claims) {
        await tx.manualPaymentClaim.update({
          where: { id: c.id, storeId },
          data: {
            payerReference: freedReference(c.payerReference, c.id, 'voided'),
            reviewNote: `voided: ${note}`.slice(0, 500),
          },
        });
        await InstapayReceiptService.voidByClaim(storeId, c.id, note, input.actorId);
      }
    }
    return {
      duplicate: false,
      refundEventId: refundId,
      periodEnd,
      voidedEventId: input.kind === 'void' ? charge.id : null,
    };
  }).catch(async err => {
    if (screenshotKey) {
      await StorageService.deletePrivate(screenshotKey).catch(() => undefined);
    }
    throw err;
  });
  if (!out.duplicate) {
    await featureService.invalidateCache(storeId).catch(() => undefined);
    await restoreRevokedGrants().catch(() => undefined); // a referrer's side lives in another tenant
  }
  return { ...out, storeId };
}

// The D1 reference claims these free (Ruling INSTAPAY-DO-1) are released only after the transaction commits.
export const rejectClaim = (args: Parameters<typeof rejectClaimInner>[0]) =>
  withClaimReleases(() => rejectClaimInner(args));
export const recordManualRefund = (input: Parameters<typeof recordManualRefundInner>[0]) =>
  withClaimReleases(() => recordManualRefundInner(input));
export const submitSubscriptionReceipt = (
  args: Parameters<typeof submitSubscriptionReceiptInner>[0]
) => withClaimReleases(() => submitSubscriptionReceiptInner(args));
