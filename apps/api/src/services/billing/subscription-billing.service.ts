/**
 * Subscription lifecycle (SP5 task 3) — Ebda's own EGP billing engine.
 *
 * RULES (this header is the lifecycle spec; env in docs/ENVIRONMENT.md):
 *  - Every provider call happens OUTSIDE any DB transaction. The pattern is
 *    always: (1) short tx claims a `billing_events` row (UNIQUE idempotency key)
 *    -> (2) provider call -> (3) fresh short tx settles the row + subscription.
 *    Step 1 is what makes a retry or a second cron run unable to double-charge:
 *    a key that is already claimed is never sent again. A claimed row whose
 *    provider call timed out stays `pending` (outcome unknown) and is NEVER
 *    re-sent automatically — the webhook settles it, or an operator reconciles
 *    it from /billing-events.
 *  - Money is integer piastres; plan prices come from `plans` (null = refuse).
 *  - Proration: NONE in v1. Upgrade = takes effect immediately for a FULL
 *    charge of the new plan and a fresh period starting now (unused time on the
 *    old plan is not credited). Downgrade / cancel = at the period end, no
 *    refund. `comped` is never charged.
 *  - Dunning: renewal fails on day 0 -> `past_due`; retries at +3 days and +7
 *    days after the missed period end; the third failure downgrades the store
 *    to `free` + status `canceled` (data is kept, free limits apply) and
 *    notifies the merchant. Retry keys append `:retry<n>`.
 *  - Out-of-order safe: `failed` only applies to a `pending` charge, so a late
 *    "failed" delivery after `succeeded` changes nothing. A late `succeeded`
 *    after `failed` DOES settle (the money was taken).
 *  - Signup funnel (Ruling EBDA-FUNNEL-1..9): a `card_setup` row (amount 0)
 *    saves a card with NOTHING charged; only a `card.saved`/`card.failed`
 *    delivery may settle it, and a card event can never settle a money row.
 *    The trial runs on Growth; `pendingPlanCode` + `billingInterval` hold the
 *    plan chosen at signup, which the trial-end charge bills. In
 *    `pay_at_trial_end` mode (no card during the trial) the trial end moves
 *    the store into the dunning window with a pay-now notice instead.
 */
import crypto from 'crypto';
import { prisma, withStore, currentStoreId, type Prisma } from '@ebda/database';
import { getBillingRefundStoreId, getEntityStoreId } from '../../lib/definer';
import { pageAcrossStores } from '../../lib/cross-store';
import { AppError } from '../../middleware/error-handler';
import { config } from '../../config';
import logger from '../../lib/logger';
import { isStoreGoneError } from '../../lib/jobs/store-gone';
import { sendAlert } from '../alerts.service';
import {
  acrossBilling,
  deferBillingWebhookD1,
  listDeferredBillingWebhooksD1,
  onD1,
  planTierDriftD1,
  staleDeferredBillingWebhooksD1,
  ledgerTaxFieldsD1,
} from '../platform/billing-d1';
import { isFamilyFrozen } from '../platform/cutover';
import { cfBindings } from '../../cf/bindings';
import { encryption } from '../encryption.service';
import {
  BillingProviderError,
  type BillingProvider,
  type BillingWebhookEvent,
  type ChargeResult,
} from './types';
import {
  getBillingProvider,
  getBillingProviderByName,
  resolveBillingProviderName,
  resolveTrialCardMode,
} from './index';
import {
  DUNNING_RETRY_DAYS,
  FREE_PLAN_CODE,
  GRANTED_PLAN_CODES,
  MAX_DUNNING_ATTEMPTS,
  INSTAPAY_GRACE_DAYS,
  TRIAL_DAYS,
  isGrantedPlan,
  addDays,
  addInterval,
  isInterval,
  priceFor,
  renewalKey,
  upgradeKey,
  type BillingInterval,
  addIntervalAnchored,
} from './period';
import { runBillingEffects, type BillingEffect } from './billing-notify';
import {
  grantedCarryMs,
  restoreRevokedGrants,
  revokeGrantsForEvent,
  shiftedByGrants,
  sweepFreeMonthGrants,
} from './grants.service';
import { assertPayableStore, isBillableStoreId, suspendForBilling } from './account.service';
import { applyAddonGrant } from './addon-grant';
import { ADDON_MARKER_PREFIX, ADDON_PLAN_PREFIX } from './addon-catalog';
import { renewDueAddons } from './addon-renewal';
import { auditLog } from '../../middleware/security';
import { instapayHandle, instapayQrUrl, supportContact } from './manual-config';
import { findReminderCandidates, sendDueReminder } from './reminders.service';
import {
  chargeFor,
  ledgerVat,
  resolvePlatformVat,
  subscriptionChargeAmount,
  type ChargeAmount,
  type LedgerVat,
  type PlatformVat,
} from './charge-amount';
import { storeUpdate } from '../../lib/repo-factory';

type Tx = Prisma.TransactionClient;

/** The date a subscription is next due: the trial end while trialing, else the period end. */
function periodEndOf(sub: {
  status: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}): Date | null {
  return sub.status === 'trialing'
    ? (sub.trialEndsAt ?? sub.currentPeriodEnd)
    : sub.currentPeriodEnd;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_CHECKOUT_MS = 24 * 3_600_000;

export interface Outcome {
  status: 'succeeded' | 'failed';
  providerRef?: string | null;
  failureReason?: string;
  raw?: unknown;
  cardToken?: string;
  cardLast4?: string;
  cardBrand?: string;
  customerRef?: string;
}

interface LedgerRow {
  id: string;
  storeId: string;
  subscriptionId: string | null;
  type: string;
  planCode: string | null;
  billingInterval: string | null;
  forPeriodEnd: Date | null;
  attempt: number;
  amountMinor: number;
  provider: string;
  status: string;
}

// ───────────────────────────── ledger helpers ─────────────────────────────

interface ClaimInput {
  storeId: string;
  subscriptionId?: string | null;
  type: 'checkout' | 'renewal' | 'upgrade' | 'refund' | 'card_setup';
  planCode?: string | null;
  billingInterval?: BillingInterval | null;
  forPeriodEnd?: Date | null;
  attempt?: number;
  amountMinor: number;
  /** The charge this row records (platform VAT split); absent = no VAT (refunds, card setup). */
  charge?: ChargeAmount;
  provider: string;
  idempotencyKey: string;
  relatedEventId?: string | null;
}

/**
 * `billing_events` and `store_subscriptions` are under strict RLS: every access
 * runs in the owning store's scope. A ledger row / subscription named only by its
 * id (a cron step, a webhook) is resolved to its store through the
 * `ebda_entity_store_id` definer first.
 */
async function inEventStore<T>(
  eventId: string,
  fn: (tx: Tx, storeId: string) => Promise<T>,
  whenMissing: T
): Promise<T> {
  const storeId = await getEntityStoreId('billing_event', eventId);
  return storeId ? withStore(storeId, tx => fn(tx, storeId)) : whenMissing;
}

/** `billing_events.vat_minor` + `vat` for a charge (no VAT -> 0 / DB NULL). */
function vatColumns(charge: ChargeAmount | undefined) {
  const { vatMinor, vat } = charge ? ledgerVat(charge) : { vatMinor: 0, vat: null };
  return { vatMinor, vat: vat ? (vat as unknown as Prisma.InputJsonValue) : undefined };
}

/**
 * Claim an idempotency key. Returns the new row's id, or null when the key was
 * already claimed (another run / a retry): the caller must NOT call the provider.
 * `ON CONFLICT DO NOTHING` — a duplicate never aborts the surrounding tx.
 */
export async function claimEvent(input: ClaimInput): Promise<string | null> {
  const id = crypto.randomUUID();
  const { count } = await withStore(input.storeId, tx =>
    tx.billingEvent.createMany({
      data: [
        {
          id,
          storeId: input.storeId,
          subscriptionId: input.subscriptionId ?? null,
          type: input.type,
          planCode: input.planCode ?? null,
          billingInterval: input.billingInterval ?? null,
          forPeriodEnd: input.forPeriodEnd ?? null,
          attempt: input.attempt ?? 0,
          amountMinor: input.amountMinor,
          currency: 'EGP',
          provider: input.provider,
          idempotencyKey: input.idempotencyKey,
          status: 'pending',
          relatedEventId: input.relatedEventId ?? null,
          ...vatColumns(input.charge),
        },
      ],
      skipDuplicates: true,
    })
  );
  return count === 1 ? id : null;
}

export async function markFailedUnlessSettled(
  id: string,
  reason: string,
  raw?: unknown
): Promise<void> {
  await inEventStore(
    id,
    (tx, storeId) =>
      tx.billingEvent.updateMany({
        where: { id, storeId, status: 'pending' },
        data: {
          status: 'failed',
          failureReason: reason,
          raw: (raw ?? undefined) as Prisma.InputJsonValue,
        },
      }),
    { count: 0 }
  );
}

// ───────────────────────────── settlement ─────────────────────────────────

async function downgradeToFree(
  tx: Tx,
  storeId: string,
  reason: 'dunning' | 'canceled' | 'no_payment_method' | 'trial_ended',
  effects: BillingEffect[]
): Promise<void> {
  const free = await tx.plan.findUnique({ where: { code: FREE_PLAN_CODE } });
  // The Postgres half (stores.plan) goes FIRST: the subscription update is the D1 commit point, so a failure before it
  // leaves a state a retry repeats idempotently (Ruling NZ-10-2).
  if (free) await storeUpdate(tx, { where: { id: storeId }, data: { plan: free.featureTier } });
  await tx.storeSubscription.update({
    where: { storeId },
    data: {
      planCode: FREE_PLAN_CODE,
      status: 'canceled',
      cancelAtPeriodEnd: false,
      trialEndsAt: null,
      pendingPlanCode: null,
      dunningAttempts: 0,
      nextRetryAt: null,
      billingAnchorDay: null,
      provider: null,
      providerCustomerId: null,
      providerSubscriptionId: null,
      providerPaymentMethodRef: null,
    },
  });
  effects.push({ kind: 'downgraded', storeId, reason });
}

async function applyPlan(tx: Tx, storeId: string, planCode: string): Promise<void> {
  const plan = await tx.plan.findUnique({ where: { code: planCode } });
  if (plan) await storeUpdate(tx, { where: { id: storeId }, data: { plan: plan.featureTier } });
}

/** A ledger row that bought an add-on or an AI pack (`upgrade` + `addon:<sku>`), not a plan. */
function isAddonRow(row: { type: string; planCode: string | null }): boolean {
  return row.type === 'upgrade' && !!row.planCode?.startsWith(ADDON_PLAN_PREFIX);
}

async function applySuccess(
  tx: Tx,
  row: LedgerRow,
  o: Outcome,
  now: Date,
  effects: BillingEffect[]
): Promise<void> {
  if (row.type === 'card_setup') {
    await applyCardSaved(tx, row, o, now);
    return;
  }
  if (isAddonRow(row)) {
    // An add-on payment never touches the subscription (SELF-SERVICE A8/A9): it grants its own term.
    await applyAddonGrant(tx, row, now, effects);
    return;
  }
  if (row.type === 'checkout' || row.type === 'upgrade') {
    if (!row.planCode) return;
    const interval = isInterval(row.billingInterval) ? row.billingInterval : 'monthly';
    const existing = await tx.storeSubscription.findUnique({ where: { storeId: row.storeId } });
    const token = o.cardToken ? encryption.encrypt(o.cardToken) : undefined;
    if (row.type === 'checkout' && !token) {
      logger.warn(
        { storeId: row.storeId, eventId: row.id },
        '[billing] checkout succeeded without a card token — the plan cannot auto-renew'
      );
    }
    const data = {
      planCode: row.planCode,
      status: 'active' as const,
      billingInterval: interval,
      currentPeriodStart: now,
      // a fresh paid period PLUS the free months still unconsumed (additive: a max() would swallow the free month)
      currentPeriodEnd: new Date(
        addInterval(now, interval).getTime() + (await grantedCarryMs(tx, row.storeId, now))
      ),
      billingAnchorDay: now.getUTCDate(), // the cycle restarts today (M-125)
      cancelAtPeriodEnd: false,
      pendingPlanCode: null,
      dunningAttempts: 0,
      nextRetryAt: null,
      provider: row.provider,
      ...(token ? { providerPaymentMethodRef: token, billingMethod: 'card' } : {}),
      ...(o.customerRef ? { providerCustomerId: o.customerRef } : {}),
    };
    await applyPlan(tx, row.storeId, row.planCode); // Postgres half first; the subscription write is the commit point
    if (existing) {
      await tx.storeSubscription.update({ where: { storeId: row.storeId }, data });
    } else {
      await tx.storeSubscription.create({ data: { storeId: row.storeId, ...data } });
    }
    effects.push({ kind: 'plan_changed', storeId: row.storeId });
    effects.push({ kind: 'payment_recorded', storeId: row.storeId });
    effects.push({ kind: 'subscription_paid', storeId: row.storeId, billingEventId: row.id });
    return;
  }

  if (row.type === 'renewal') {
    const sub = await tx.storeSubscription.findUnique({ where: { storeId: row.storeId } });
    const renewable =
      sub &&
      row.forPeriodEnd &&
      periodEndOf(sub) &&
      (periodEndOf(sub)!.getTime() === row.forPeriodEnd.getTime() ||
        // a free-month grant moved the end after this charge was claimed: same period, shifted (FOUNDING-1)
        (await shiftedByGrants(tx, row.storeId, row.forPeriodEnd, periodEndOf(sub)!))) &&
      ['active', 'trialing', 'past_due'].includes(sub.status);
    if (!sub || !renewable) {
      // Money was taken but the subscription is not in a renewable state for
      // this period (already renewed by another attempt, or already downgraded).
      logger.error(
        { storeId: row.storeId, eventId: row.id, status: sub?.status },
        '[billing] renewal charge succeeded but could not be applied — reconcile/refund manually'
      );
      void sendAlert({
        level: 'p1',
        title: 'Billing: charge succeeded but not applied',
        body: `billing_events ${row.id} (store ${row.storeId}) succeeded but the subscription was not renewable.`,
      }).catch(() => undefined);
      return;
    }
    const interval = isInterval(row.billingInterval) ? row.billingInterval : 'monthly';
    const planCode = row.planCode ?? sub.planCode;
    let start = periodEndOf(sub)!; // = forPeriodEnd, or that end shifted by free-month grants
    // The day the cycle started on (M-125): clamped from the ANCHOR each cycle, so a short month never moves it.
    // (a trialing subscription's first paid period anchors on its own start: an old anchor from an earlier life of
    // this row must not be inherited)
    let anchor =
      sub.status === 'trialing' ? start.getUTCDate() : (sub.billingAnchorDay ?? start.getUTCDate());
    // A long-lapsed period must not leave the new one already expired
    // (that would charge again on the very next cron run).
    if (addIntervalAnchored(start, interval, anchor).getTime() <= now.getTime()) {
      start = now;
      anchor = now.getUTCDate();
    }
    if (planCode !== sub.planCode) await applyPlan(tx, row.storeId, planCode);
    await tx.storeSubscription.update({
      where: { storeId: row.storeId },
      data: {
        planCode,
        billingInterval: interval,
        status: 'active',
        currentPeriodStart: start,
        currentPeriodEnd: addIntervalAnchored(start, interval, anchor),
        billingAnchorDay: anchor,
        trialEndsAt: null,
        pendingPlanCode: null,
        dunningAttempts: 0,
        nextRetryAt: null,
      },
    });
    if (planCode !== sub.planCode) effects.push({ kind: 'plan_changed', storeId: row.storeId });
    effects.push({ kind: 'payment_recorded', storeId: row.storeId });
    // Only a charge that ENDS a trial can be the first paid payment (the trial-end charge is a
    // `renewal`); later renewals are not conversions, so they are not queued.
    if (sub.status === 'trialing') {
      effects.push({ kind: 'subscription_paid', storeId: row.storeId, billingEventId: row.id });
    }
  }
}

/**
 * A card saved with nothing charged (card_setup). The FIRST card saved while
 * trialing starts the 14-day trial clock from now (Ruling EBDA-FUNNEL-4): the
 * store could not go live before it, so the merchant never loses trial days to
 * setup. A replacement card changes only the payment method.
 */
async function applyCardSaved(tx: Tx, row: LedgerRow, o: Outcome, now: Date): Promise<void> {
  if (!o.cardToken) return; // settleInTx refuses a token-less card_setup success
  const sub = await tx.storeSubscription.findUnique({ where: { storeId: row.storeId } });
  if (!sub) {
    logger.error(
      { storeId: row.storeId, eventId: row.id },
      '[billing] card saved for no subscription'
    );
    return;
  }
  const restartTrial = sub.status === 'trialing' && !sub.providerPaymentMethodRef;
  const trialEndsAt = addDays(now, TRIAL_DAYS);
  const last4 = o.cardLast4 && /^[0-9]{4}$/.test(o.cardLast4) ? o.cardLast4 : null;
  await tx.storeSubscription.update({
    where: { storeId: row.storeId },
    data: {
      provider: row.provider,
      billingMethod: 'card',
      providerPaymentMethodRef: encryption.encrypt(o.cardToken),
      paymentMethodLast4: last4,
      paymentMethodBrand: o.cardBrand ? o.cardBrand.slice(0, 32) : null,
      paymentMethodSavedAt: now,
      ...(o.customerRef ? { providerCustomerId: o.customerRef } : {}),
      ...(restartTrial
        ? { trialEndsAt, currentPeriodStart: now, currentPeriodEnd: trialEndsAt }
        : {}),
    },
  });
}

async function applyFailure(tx: Tx, row: LedgerRow, effects: BillingEffect[]): Promise<void> {
  if (row.type !== 'renewal') return; // a declined checkout/upgrade changes nothing
  const sub = await tx.storeSubscription.findUnique({ where: { storeId: row.storeId } });
  // A previous attempt downgraded the subscription in D1 and its Postgres tier write (or the status flip) did not
  // survive: the retry finds the subscription already `canceled` on the free plan and would stop here, leaving paid
  // features on `stores`. Repeat the (idempotent) tier write.
  if (sub?.status === 'canceled' && sub.planCode === FREE_PLAN_CODE && (await onD1())) {
    await applyPlan(tx, row.storeId, FREE_PLAN_CODE);
    return;
  }
  if (
    !sub ||
    !row.forPeriodEnd ||
    !periodEndOf(sub) ||
    periodEndOf(sub)!.getTime() !== row.forPeriodEnd.getTime() ||
    !['active', 'trialing', 'past_due'].includes(sub.status)
  ) {
    return;
  }
  const failedCount = row.attempt + 1;
  if (failedCount >= MAX_DUNNING_ATTEMPTS) {
    await downgradeToFree(tx, row.storeId, 'dunning', effects);
    return;
  }
  const nextRetryAt = addDays(row.forPeriodEnd, DUNNING_RETRY_DAYS[row.attempt]);
  await tx.storeSubscription.update({
    where: { storeId: row.storeId },
    data: {
      status: 'past_due',
      dunningAttempts: failedCount,
      nextRetryAt,
      // A failed trial-end charge moves the due date into the period fields
      // so the day-3 / day-7 retries run on the normal dunning path.
      currentPeriodEnd: row.forPeriodEnd,
    },
  });
  effects.push({
    kind: 'payment_failed',
    storeId: row.storeId,
    amountMinor: row.amountMinor,
    attempt: failedCount,
    nextRetryAt,
    planCode: row.planCode ?? sub.planCode,
  });
}

/** Webhook dedupe claim (see applyWebhookEvent): `outcome` while in flight, and how old it must be to be taken over. */
const WEBHOOK_PROCESSING = 'processing';
const WEBHOOK_DEFERRED = 'deferred';
const WEBHOOK_CLAIM_STALE_MS = 120_000;

/** D1 settle lease marker (stored in `failure_reason` while a success is being applied) and how long it holds. */
const SETTLE_LEASE = 'settling';
const SETTLE_LEASE_MS = 120_000;

/**
 * Repeat the idempotent parts of a success whose subscription write already committed: the tier on `stores` and the
 * notifications the interrupted attempt never sent.
 */
async function healAppliedSuccess(tx: Tx, row: LedgerRow, effects: BillingEffect[]): Promise<void> {
  if (isAddonRow(row)) {
    effects.push({ kind: 'addon_granted', storeId: row.storeId });
    return;
  }
  const sub = await tx.storeSubscription.findUnique({ where: { storeId: row.storeId } });
  const planCode = row.type === 'card_setup' ? null : (row.planCode ?? sub?.planCode ?? null);
  if (planCode) await applyPlan(tx, row.storeId, planCode);
  if (row.type === 'checkout' || row.type === 'upgrade') {
    effects.push({ kind: 'plan_changed', storeId: row.storeId });
    effects.push({ kind: 'payment_recorded', storeId: row.storeId });
    effects.push({ kind: 'subscription_paid', storeId: row.storeId, billingEventId: row.id });
  } else if (row.type === 'renewal') {
    effects.push({ kind: 'payment_recorded', storeId: row.storeId });
  }
}

/** Did an earlier, interrupted settlement of this success already move the subscription? (D1 lease path only.) */
async function alreadyApplied(tx: Tx, row: LedgerRow & { createdAt: Date }): Promise<boolean> {
  if (isAddonRow(row)) return row.forPeriodEnd !== null; // the grant writes the term end; unset until granted
  const sub = await tx.storeSubscription.findUnique({ where: { storeId: row.storeId } });
  if (!sub) return false;
  const started = sub.currentPeriodStart?.getTime();
  if (row.type === 'card_setup')
    return (
      !!sub.providerPaymentMethodRef &&
      !!sub.paymentMethodSavedAt &&
      sub.paymentMethodSavedAt >= row.createdAt
    );
  if (row.type === 'renewal')
    return (
      sub.status === 'active' &&
      started !== undefined &&
      !!row.forPeriodEnd &&
      started >= row.forPeriodEnd.getTime()
    );
  if (row.type === 'checkout' || row.type === 'upgrade')
    return (
      sub.status === 'active' &&
      sub.planCode === row.planCode &&
      started !== undefined &&
      started >= row.createdAt.getTime()
    );
  return false;
}

/**
 * Settle one charge row inside the caller's transaction. Guarded transitions:
 *  - succeeded: only from pending|failed (a late success after a failure still
 *    settles — the money moved);
 *  - failed: ONLY from pending — a late "failed" after "succeeded" is a no-op.
 * Returns whether this call performed the transition (replays return false).
 */
export async function settleInTx(
  tx: Tx,
  eventId: string,
  o: Outcome,
  now: Date,
  effects: BillingEffect[]
): Promise<{ transitioned: boolean }> {
  // Runs inside the event's store scope (inEventStore / the webhook's withStore).
  const row = await tx.billingEvent.findUnique({
    where: { id: eventId, storeId: currentStoreId() },
  });
  if (!row) return { transitioned: false };
  const raw = (o.raw ?? undefined) as Prisma.InputJsonValue | undefined;
  if (o.status === 'succeeded' && row.type === 'card_setup' && !o.cardToken) {
    // "Saved" with no token saves nothing: the store must not pass the go-live gate.
    o = { ...o, status: 'failed', failureReason: 'card_setup_without_token' };
  }
  if (o.status === 'succeeded') {
    const settled = {
      status: 'succeeded' as const,
      failureReason: null,
      ...(o.providerRef ? { providerRef: o.providerRef } : {}),
      ...(raw !== undefined ? { raw } : {}),
    };
    if (await onD1()) {
      // D1 has no transaction and `succeeded` is final (billing_events_succeeded_final), so the order is: take a lease
      // on the row, apply the subscription, THEN flip the status. A failure releases the lease and nothing is settled;
      // a crash leaves the lease, which expires after SETTLE_LEASE_MS. (Ruling NZ-10-2.)
      const leased = await tx.billingEvent.updateMany({
        where: {
          id: eventId,
          storeId: row.storeId,
          status: { in: ['pending', 'failed'] },
          OR: [
            { failureReason: null },
            { failureReason: { not: SETTLE_LEASE } },
            { updatedAt: { lt: new Date(now.getTime() - SETTLE_LEASE_MS) } },
          ],
        },
        data: { failureReason: SETTLE_LEASE },
      });
      if (leased.count === 0) return { transitioned: false };
      let flippedOk = false;
      try {
        if (await alreadyApplied(tx, row)) {
          // A previous attempt moved the subscription (D1 committed) but its Postgres half or its status flip did not
          // survive. The Postgres half (stores.plan) and the effects are idempotent: repeat them, apply nothing twice.
          await healAppliedSuccess(tx, row, effects);
        } else {
          await applySuccess(tx, row, o, now, effects);
        }
        const flipped = await tx.billingEvent.updateMany({
          where: {
            id: eventId,
            storeId: row.storeId,
            status: { in: ['pending', 'failed'] },
            failureReason: SETTLE_LEASE,
          },
          data: settled,
        });
        flippedOk = flipped.count === 1;
        return { transitioned: flippedOk };
      } finally {
        // Whatever went wrong (the apply, the flip, a rolled-back transaction), the lease is released so the next try
        // is not held up for SETTLE_LEASE_MS.
        if (!flippedOk)
          await tx.billingEvent
            .updateMany({
              where: { id: eventId, storeId: row.storeId, failureReason: SETTLE_LEASE },
              data: { failureReason: row.failureReason },
            })
            .catch(undo =>
              logger.error({ err: undo, eventId }, '[billing] could not release a settle lease')
            );
      }
    }
    const upd = await tx.billingEvent.updateMany({
      where: { id: eventId, storeId: row.storeId, status: { in: ['pending', 'failed'] } },
      data: settled,
    });
    if (upd.count === 0) return { transitioned: false };
    await applySuccess(tx, row, o, now, effects);
    return { transitioned: true };
  }
  const upd = await tx.billingEvent.updateMany({
    where: { id: eventId, storeId: row.storeId, status: 'pending' },
    data: {
      status: 'failed',
      failureReason: o.failureReason ?? 'failed',
      ...(o.providerRef ? { providerRef: o.providerRef } : {}),
      ...(raw !== undefined ? { raw } : {}),
    },
  });
  if (upd.count === 0) return { transitioned: false };
  try {
    await applyFailure(tx, row, effects);
  } catch (err) {
    if (await onD1()) {
      await tx.billingEvent
        .updateMany({
          where: { id: eventId, storeId: row.storeId, status: 'failed' },
          data: { status: 'pending' },
        })
        .catch(undo =>
          logger.error({ err: undo, eventId }, '[billing] could not reopen a half-settled failure')
        );
    }
    throw err;
  }
  return { transitioned: true };
}

async function settleCharge(eventId: string, o: Outcome, now: Date) {
  const effects: BillingEffect[] = [];
  const res = await inEventStore(eventId, tx => settleInTx(tx, eventId, o, now, effects), {
    transitioned: false,
  });
  await runBillingEffects(effects);
  return res;
}

/** Test seam: the pause between settle retries (ms per attempt). */
export const settleRetry = { delayMs: 250, attempts: 3 };

/**
 * Settle a DEFINITIVE provider answer, retrying the DB write (Ruling EBDA-FUNNEL-6).
 * The money already moved (or was declined), so the outcome must not be lost to
 * one dropped connection. Settlement is idempotent (guarded transitions), so a
 * retry after a commit whose ack was lost is a no-op. If every attempt fails the
 * claimed row stays `pending` — still OWNED: no later run can re-send its key —
 * and a P1 alert carries the provider reference for the operator / webhook.
 */
async function settleDefinitive(eventId: string, o: Outcome, now: Date) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await settleCharge(eventId, o, now);
    } catch (err) {
      if (attempt >= settleRetry.attempts) {
        logger.error(
          { err, eventId, outcome: o.status },
          '[billing] settle failed after a provider answer'
        );
        void sendAlert({
          level: 'p1',
          title: 'Billing: provider answered but the ledger could not be settled',
          body: `billing_events ${eventId}: provider said ${o.status} (ref ${o.providerRef ?? 'n/a'}). Row left pending; reconcile from /billing-events.`,
        }).catch(() => undefined);
        throw err;
      }
      await new Promise(r => setTimeout(r, settleRetry.delayMs * attempt));
    }
  }
}

// ───────────────────────── provider call (outside tx) ─────────────────────

type ChargeAttempt = { settled: 'succeeded' | 'failed' } | { settled: 'pending'; reason?: string };

export async function chargeAndSettle(args: {
  provider: BillingProvider;
  eventId: string;
  token: string;
  amountMinor: number;
  idempotencyKey: string;
  description: string;
  now: Date;
}): Promise<ChargeAttempt> {
  let res: ChargeResult;
  try {
    res = await args.provider.chargeSavedCard({
      token: args.token,
      amountMinor: args.amountMinor,
      currency: 'EGP',
      idempotencyKey: args.idempotencyKey,
      description: args.description,
      merchantOrderId: args.eventId,
    });
  } catch (err) {
    if (err instanceof BillingProviderError && err.notCharged) {
      logger.error({ err, eventId: args.eventId }, '[billing] provider refused the charge');
      void sendAlert({
        level: 'p1',
        title: 'Billing provider refused a charge',
        body: `billing_events ${args.eventId}: ${err.message}`,
      }).catch(() => undefined);
      await settleCharge(
        args.eventId,
        { status: 'failed', failureReason: `provider_error: ${err.message}` },
        args.now
      );
      return { settled: 'failed' };
    }
    // Unknown outcome (timeout / 5xx): leave `pending`; never re-send blindly. Loud (M-023): nothing else is
    // going to look at it - the daily sweep asks the gateway, then hands it to dunning after the give-up window.
    logger.error({ err, eventId: args.eventId }, '[billing] charge outcome unknown — left pending');
    void sendAlert({
      level: 'p1',
      title: 'Billing: charge outcome unknown',
      body: `billing_events ${args.eventId}: the gateway call did not answer (${(err as Error).message}). Left pending and NOT retried; the daily sweep asks the gateway where it can and names what it cannot resolve.`,
    }).catch(() => undefined);
    return { settled: 'pending', reason: (err as Error).message };
  }
  if (res.status === 'pending') {
    await inEventStore(
      args.eventId,
      (tx, storeId) =>
        tx.billingEvent.updateMany({
          where: { id: args.eventId, storeId, status: 'pending' },
          data: { providerRef: res.chargeId ?? undefined },
        }),
      { count: 0 }
    );
    return { settled: 'pending' };
  }
  await settleDefinitive(
    args.eventId,
    {
      status: res.status,
      providerRef: res.chargeId,
      failureReason: res.failureReason,
      raw: res.raw,
    },
    args.now
  );
  return { settled: res.status };
}

// ───────────────────────────── checkout ───────────────────────────────────

async function loadSub(storeId: string) {
  return withStore(storeId, tx => tx.storeSubscription.findUnique({ where: { storeId } }));
}

/** A public-or-hidden plan that can be paid for at `interval` (price set, not free/granted). */
export async function loadPayablePlan(planCode: string, interval: BillingInterval) {
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) throw new AppError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  if (plan.code === FREE_PLAN_CODE || isGrantedPlan(plan.code)) {
    throw new AppError(400, 'PLAN_NOT_PURCHASABLE', 'This plan cannot be purchased');
  }
  const price = priceFor(plan, interval);
  if (price === null || price === undefined) {
    throw new AppError(
      400,
      'PLAN_PRICE_NOT_SET',
      `The ${interval} price for this plan has not been set yet`
    );
  }
  if (!Number.isSafeInteger(price) || price <= 0) {
    throw new AppError(400, 'PLAN_PRICE_INVALID', 'The plan price is invalid');
  }
  return { plan, price };
}

export async function startCheckout(args: {
  storeId: string;
  planCode: string;
  interval?: BillingInterval;
  provider?: BillingProvider;
  returnUrl?: string;
}): Promise<{ redirectUrl: string; billingEventId: string }> {
  const interval = args.interval ?? 'monthly';
  await assertPayableStore(args.storeId);
  // Hosted card checkout exists only in card mode (Ruling EBDA-FUNNEL-17).
  if (resolveTrialCardMode(args.provider) !== 'card_on_file') {
    throw new AppError(
      409,
      'CARD_PAYMENTS_DISABLED',
      'Card payments are not available; pay by InstaPay from this page'
    );
  }
  const provider = args.provider ?? getBillingProvider();
  const { plan, price } = await loadPayablePlan(args.planCode, interval);

  const [sub, store] = await Promise.all([
    loadSub(args.storeId),
    withStore(args.storeId, tx =>
      tx.store.findUnique({
        where: { id: args.storeId },
        select: {
          id: true,
          name: true,
          settings: true,
          owner: { select: { email: true, firstName: true } },
        },
      })
    ),
  ]);
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  if (sub?.status === 'comped') {
    throw new AppError(409, 'STORE_COMPED', 'Comped stores are not billed');
  }
  if (sub?.providerPaymentMethodRef && ['active', 'trialing', 'past_due'].includes(sub.status)) {
    throw new AppError(409, 'ALREADY_SUBSCRIBED', 'Use change-plan to move between paid plans');
  }
  if (!store.owner?.email) {
    throw new AppError(409, 'NO_BILLING_EMAIL', 'The store owner has no email address');
  }

  // ONE VAT read per charge: the ledger row and the provider see the same amount.
  const amount = await chargeFor(price);
  const eventId = await claimEvent({
    storeId: args.storeId,
    subscriptionId: sub?.id,
    type: 'checkout',
    planCode: plan.code,
    billingInterval: interval,
    amountMinor: amount.totalMinor,
    charge: amount,
    provider: provider.name,
    // Unique per attempt: each "Upgrade" click is its own checkout session.
    idempotencyKey: `checkout:${args.storeId}:${crypto.randomUUID()}`,
  });
  if (!eventId) throw new AppError(409, 'CHECKOUT_IN_PROGRESS', 'Checkout already in progress');

  const lang: 'ar' | 'en' =
    (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'en' ? 'en' : 'ar';
  try {
    const out = await provider.createCheckoutForSubscription({
      merchantOrderId: eventId,
      amountMinor: amount.totalMinor,
      currency: 'EGP',
      description: `${plan.nameEn} (${interval})`,
      customer: { reference: args.storeId, email: store.owner.email, name: store.owner.firstName },
      returnUrl:
        args.returnUrl ?? `${config.adminUrl}/stores/${args.storeId}/billing?checkout=return`,
      webhookUrl: `${config.apiUrl}/api/v1/webhooks/billing/${provider.name}`,
      locale: lang,
    });
    await withStore(args.storeId, tx =>
      tx.billingEvent.updateMany({
        where: { id: eventId, storeId: args.storeId, status: 'pending' },
        data: { raw: { providerSessionId: out.providerSessionId } },
      })
    );
    return { redirectUrl: out.redirectUrl, billingEventId: eventId };
  } catch (err) {
    await markFailedUnlessSettled(eventId, `checkout_error: ${(err as Error).message}`);
    logger.error({ err, storeId: args.storeId }, '[billing] createCheckout failed');
    throw new AppError(502, 'BILLING_PROVIDER_ERROR', 'Could not start the checkout, try again');
  }
}

// ─────────────────────── signup funnel: plan + card ───────────────────────

/**
 * Record the plan chosen at signup while the store is on its Growth trial. The
 * trial-end charge bills `pendingPlanCode` at `billingInterval` (Ruling EBDA-FUNNEL-3).
 * Only a public, priced plan is accepted (same check as checkout).
 */
export async function selectTrialPlan(args: {
  storeId: string;
  planCode: string;
  interval: BillingInterval;
}): Promise<{ planCode: string; interval: BillingInterval; amountMinor: number }> {
  await assertPayableStore(args.storeId);
  const { plan, price } = await loadPayablePlan(args.planCode, args.interval);
  if (!plan.isPublic)
    throw new AppError(400, 'PLAN_NOT_PURCHASABLE', 'This plan cannot be purchased');
  const { count } = await withStore(args.storeId, tx =>
    tx.storeSubscription.updateMany({
      where: { storeId: args.storeId, status: 'trialing' },
      data: { pendingPlanCode: plan.code, billingInterval: args.interval },
    })
  );
  if (count === 0) {
    throw new AppError(409, 'NOT_TRIALING', 'The plan can only be chosen here during the trial');
  }
  return {
    planCode: plan.code,
    interval: args.interval,
    amountMinor: (await chargeFor(price)).totalMinor,
  };
}

/**
 * Start a hosted "save your card" page. NOTHING is charged: the ledger row is a
 * `card_setup` of amount 0, settled only by a signed `card.saved`/`card.failed`
 * delivery. Refused (409 CARD_SETUP_UNAVAILABLE) when the trial runs in
 * `pay_at_trial_end` mode — the provider cannot save a card without a charge.
 */
export async function startCardSetup(args: {
  storeId: string;
  provider?: BillingProvider;
  returnUrl?: string;
}): Promise<{ redirectUrl: string; billingEventId: string }> {
  await assertPayableStore(args.storeId);
  const provider = args.provider ?? getBillingProvider();
  if (resolveTrialCardMode(provider) !== 'card_on_file') {
    throw new AppError(
      409,
      'CARD_SETUP_UNAVAILABLE',
      'Saving a card without a charge is not available; you will pay at the end of the trial'
    );
  }
  const [sub, store] = await Promise.all([
    loadSub(args.storeId),
    withStore(args.storeId, tx =>
      tx.store.findUnique({
        where: { id: args.storeId },
        select: { id: true, settings: true, owner: { select: { email: true, firstName: true } } },
      })
    ),
  ]);
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  if (
    !sub ||
    !['trialing', 'active', 'past_due'].includes(sub.status) ||
    isGrantedPlan(sub.planCode)
  ) {
    throw new AppError(
      409,
      'NO_BILLABLE_SUBSCRIPTION',
      'This store has no subscription to save a card for'
    );
  }
  if (!store.owner?.email) {
    throw new AppError(409, 'NO_BILLING_EMAIL', 'The store owner has no email address');
  }
  const eventId = await claimEvent({
    storeId: args.storeId,
    subscriptionId: sub.id,
    type: 'card_setup',
    planCode: sub.pendingPlanCode ?? sub.planCode,
    billingInterval: isInterval(sub.billingInterval) ? sub.billingInterval : 'monthly',
    amountMinor: 0,
    provider: provider.name,
    idempotencyKey: `card_setup:${args.storeId}:${crypto.randomUUID()}`,
  });
  if (!eventId) throw new AppError(409, 'CARD_SETUP_IN_PROGRESS', 'Card setup already in progress');
  const lang: 'ar' | 'en' =
    (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'en' ? 'en' : 'ar';
  try {
    const out = await provider.createCardSetupSession({
      merchantOrderId: eventId,
      customer: { reference: args.storeId, email: store.owner.email, name: store.owner.firstName },
      returnUrl: args.returnUrl ?? `${config.adminUrl}/onboarding?card=return`,
      webhookUrl: `${config.apiUrl}/api/v1/webhooks/billing/${provider.name}`,
      locale: lang,
    });
    await withStore(args.storeId, tx =>
      tx.billingEvent.updateMany({
        where: { id: eventId, storeId: args.storeId, status: 'pending' },
        data: { raw: { providerSessionId: out.providerSessionId } },
      })
    );
    return { redirectUrl: out.redirectUrl, billingEventId: eventId };
  } catch (err) {
    await markFailedUnlessSettled(eventId, `checkout_error: ${(err as Error).message}`);
    logger.error({ err, storeId: args.storeId }, '[billing] createCardSetupSession failed');
    throw new AppError(502, 'BILLING_PROVIDER_ERROR', 'Could not open the card page, try again');
  }
}

// ───────────────────────────── renewal / dunning ──────────────────────────

export type RenewalResult =
  | { action: 'skipped'; reason: string }
  | { action: 'charged'; status: 'succeeded' | 'failed' | 'pending'; eventId: string }
  | { action: 'canceled' | 'no_payment_method_downgrade' | 'suspended' };

/** One subscription. A closed / removed store is skipped with a log, never thrown (it would fail the whole daily run). */
export async function renewSubscription(
  subscriptionId: string,
  now: Date = new Date(),
  providerArg?: BillingProvider
): Promise<RenewalResult> {
  try {
    return await renewSubscriptionInner(subscriptionId, now, providerArg);
  } catch (err) {
    if (!isStoreGoneError(err)) throw err;
    logger.warn(
      { subscriptionId, code: (err as { code?: string }).code },
      '[billing] store gone; renewal skipped'
    );
    return { action: 'skipped', reason: 'store_gone' };
  }
}

async function renewSubscriptionInner(
  subscriptionId: string,
  now: Date,
  providerArg?: BillingProvider
): Promise<RenewalResult> {
  const subStoreId = await getEntityStoreId('store_subscription', subscriptionId);
  const sub = subStoreId
    ? await withStore(subStoreId, tx =>
        tx.storeSubscription.findUnique({ where: { id: subscriptionId, storeId: subStoreId } })
      )
    : null;
  if (!sub) return { action: 'skipped', reason: 'not_found' };
  // Comped is NEVER charged (checked on both the status and the plan).
  if (sub.status === 'comped' || isGrantedPlan(sub.planCode)) {
    return { action: 'skipped', reason: 'comped' };
  }
  // A child store is included in its parent's plan and is NEVER charged on its own
  // (Ruling EBDA-FUNNEL-18). Fail closed: a store the owner list cannot place is skipped too.
  if (!(await isBillableStoreId(sub.storeId))) return { action: 'skipped', reason: 'child_store' };
  const billable = ['active', 'trialing', 'past_due'].includes(sub.status);
  const periodEnd = periodEndOf(sub);
  if (!billable || !periodEnd) return { action: 'skipped', reason: 'not_billable' };
  const trialEnd = sub.status === 'trialing';

  // Cancel-at-period-end (or a downgrade to free): finalize once the period is over.
  if (sub.cancelAtPeriodEnd && periodEnd.getTime() <= now.getTime()) {
    const effects: BillingEffect[] = [];
    await withStore(sub.storeId, tx => downgradeToFree(tx, sub.storeId, 'canceled', effects));
    await runBillingEffects(effects);
    return { action: 'canceled' };
  }

  const attempt = sub.status === 'past_due' ? sub.dunningAttempts : 0;
  const due =
    sub.status === 'past_due'
      ? !!sub.nextRetryAt && sub.nextRetryAt.getTime() <= now.getTime()
      : periodEnd.getTime() <= now.getTime();
  if (!due) return { action: 'skipped', reason: 'not_due' };

  // InstaPay (manual) subscriptions are never charged by the provider: on the due
  // day they go past_due, and after the grace period the store is suspended until
  // a super-admin records the payment (Ruling EBDA-FUNNEL-11).
  if (sub.billingMethod === 'instapay') return manualPayDue(sub, periodEnd, now);
  const noCard = !sub.provider || !sub.providerPaymentMethodRef;
  // A trial that ended with no saved card (and no payment method chosen) moves to free.
  if (trialEnd && noCard) {
    const effects: BillingEffect[] = [];
    await withStore(sub.storeId, tx => downgradeToFree(tx, sub.storeId, 'trial_ended', effects));
    await runBillingEffects(effects);
    return { action: 'no_payment_method_downgrade' };
  }
  if (!sub.provider) return { action: 'skipped', reason: 'not_billed_by_platform' };

  if (!sub.providerPaymentMethodRef) {
    const effects: BillingEffect[] = [];
    await withStore(sub.storeId, tx =>
      downgradeToFree(tx, sub.storeId, 'no_payment_method', effects)
    );
    await runBillingEffects(effects);
    return { action: 'no_payment_method_downgrade' };
  }

  const interval = isInterval(sub.billingInterval) ? sub.billingInterval : 'monthly';
  const targetCode = sub.pendingPlanCode ?? sub.planCode;
  const plan = await prisma.plan.findUnique({ where: { code: targetCode } });
  const price = plan ? priceFor(plan, interval) : null;
  if (!plan || price === null || price <= 0) {
    logger.error({ subscriptionId, targetCode }, '[billing] renewal skipped: plan price not set');
    return { action: 'skipped', reason: 'price_not_set' };
  }

  // Resolved only when a card is actually charged: an InstaPay-only deployment
  // (no BILLING_PROVIDER) never needs a gateway for reminders/overdue/suspension.
  const provider = providerArg ?? getBillingProvider();
  const key = trialEnd
    ? `sub:${sub.id}:trial-end:${periodEnd.toISOString()}`
    : renewalKey(sub.id, periodEnd, attempt);
  const amount = await chargeFor(price);
  const eventId = await claimEvent({
    storeId: sub.storeId,
    subscriptionId: sub.id,
    type: 'renewal',
    planCode: plan.code,
    billingInterval: interval,
    forPeriodEnd: periodEnd,
    attempt,
    amountMinor: amount.totalMinor,
    charge: amount,
    provider: provider.name,
    idempotencyKey: key,
  });
  if (!eventId) return { action: 'skipped', reason: 'already_claimed' };

  let token: string;
  try {
    token = encryption.decrypt(sub.providerPaymentMethodRef);
  } catch {
    await settleCharge(
      eventId,
      { status: 'failed', failureReason: 'payment_method_unreadable' },
      now
    );
    return { action: 'charged', status: 'failed', eventId };
  }
  const r = await chargeAndSettle({
    provider,
    eventId,
    token,
    amountMinor: amount.totalMinor,
    idempotencyKey: key,
    description: `${plan.nameEn} subscription (${interval})`,
    now,
  });
  return { action: 'charged', status: r.settled, eventId };
}

type SubRow = NonNullable<Awaited<ReturnType<typeof loadSub>>>;

/**
 * One step of the manual-payment policy (no money moves, so no ledger row):
 *  - due day, not yet past_due  -> past_due, retry (= suspension) at due + grace;
 *  - grace over, still unpaid   -> store suspended (`unpaid`), retry cleared.
 * Both are compare-and-set on the row's state, so a second run the same day is
 * a no-op. A recorded payment (manual or card) makes the row active again and
 * lifts the suspension (reconcileStoreAccess).
 */
async function manualPayDue(sub: SubRow, periodEnd: Date, now: Date): Promise<RenewalResult> {
  if (sub.status !== 'past_due') {
    const { count } = await withStore(sub.storeId, tx =>
      tx.storeSubscription.updateMany({
        where: { id: sub.id, storeId: sub.storeId, status: sub.status, billingMethod: 'instapay' },
        data: {
          status: 'past_due',
          currentPeriodEnd: periodEnd,
          nextRetryAt: addDays(periodEnd, INSTAPAY_GRACE_DAYS),
        },
      })
    );
    if (count === 1) {
      await auditLog({
        action: 'billing.manual_payment_overdue',
        resourceType: 'store_subscription',
        resourceId: sub.id,
        storeId: sub.storeId,
        details: { dueAt: periodEnd.toISOString(), graceDays: INSTAPAY_GRACE_DAYS },
      });
    }
    return {
      action: 'skipped',
      reason: count === 1 ? 'awaiting_manual_payment' : 'already_advanced',
    };
  }
  if (!sub.nextRetryAt || sub.nextRetryAt.getTime() > now.getTime()) {
    return { action: 'skipped', reason: 'not_due' };
  }
  const { count } = await withStore(sub.storeId, tx =>
    tx.storeSubscription.updateMany({
      where: { id: sub.id, storeId: sub.storeId, status: 'past_due', nextRetryAt: sub.nextRetryAt },
      data: { nextRetryAt: null },
    })
  );
  if (count === 0) return { action: 'skipped', reason: 'already_advanced' };
  const suspended = await suspendForBilling(sub.storeId, 'unpaid', now);
  await runBillingEffects([{ kind: 'store_suspended', storeId: sub.storeId, applied: suspended }]);
  return { action: 'suspended' };
}

export interface CycleSummary {
  examined: number;
  charged: number;
  skipped: number;
  canceled: number;
  errors: number;
  expiredCheckouts: number;
  reminders: number;
  suspended: number;
}

/** Subscription ids that need attention at `now` (renewal due, dunning retry due, cancellation due). */
export async function findDueSubscriptionIds(
  now: Date,
  only?: { subscriptionIds?: string[] }
): Promise<string[]> {
  // Per store, each in its own scope (store_subscriptions is strict-RLS): no
  // bypass, and a store whose scope fails does not hide the rest.
  const parts = await acrossBilling(
    storeId =>
      prisma.storeSubscription.findMany({
        where: {
          ...(storeId ? { storeId } : {}),
          ...(only?.subscriptionIds ? { id: { in: only.subscriptionIds } } : {}),
          planCode: { notIn: [...GRANTED_PLAN_CODES, FREE_PLAN_CODE] },
          OR: [
            {
              status: { in: ['active', 'trialing'] },
              currentPeriodEnd: { lte: now },
              OR: [
                { provider: { not: null } },
                { cancelAtPeriodEnd: true },
                { billingMethod: 'instapay' },
              ],
            },
            { status: 'trialing', trialEndsAt: { lte: now } },
            { status: 'past_due', nextRetryAt: { lte: now } },
          ],
        },
        select: { id: true, currentPeriodEnd: true },
      }),
    { onStoreError: (storeId, err) => logger.error({ err, storeId }, '[billing] due scan failed') }
  );
  const seen = new Set<string>();
  const rows = parts
    .flatMap(p => p.value)
    .filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((x, y) => (x.currentPeriodEnd?.getTime() ?? 0) - (y.currentPeriodEnd?.getTime() ?? 0));
  return rows.map(r => r.id);
}

/** A renewal / upgrade charge is "stuck" when its outcome has not arrived this long after it was claimed. */
export const STUCK_CHARGE_AFTER_MS = 3_600_000;

/**
 * Charges whose gateway answer was lost (M-023). For each renewal/upgrade row pending > 1 h the gateway is ASKED
 * (`getChargeStatus`):
 *  - a definitive answer is settled through the guarded pending -> succeeded|failed transition;
 *  - `null` (the provider says it has no record of that charge: it was never taken) is settled `failed`, which
 *    sends the renewal into dunning;
 *  - anything else - no lookup on this provider, no transaction id to look up, the gateway unreachable, a settle
 *    error - leaves the row PENDING and is named in one P1. It is NEVER given up on blindly: a claim that was
 *    never sent and an answer that was lost look the same from here, and failing the second kind would send a
 *    dunning retry (a new key) that charges the customer twice.
 * Idempotent; one bad row never stops the rest.
 */
export async function sweepStuckCharges(
  now: Date,
  provider?: BillingProvider
): Promise<{ polled: number; settled: number; notFound: number; stillStuck: number }> {
  const cutoff = new Date(now.getTime() - STUCK_CHARGE_AFTER_MS);
  const parts = await acrossBilling(
    storeId =>
      prisma.billingEvent.findMany({
        where: {
          ...(storeId ? { storeId } : {}),
          type: { in: ['renewal', 'upgrade'] },
          status: 'pending',
          createdAt: { lt: cutoff },
        },
        select: {
          id: true,
          storeId: true,
          idempotencyKey: true,
          providerRef: true,
          createdAt: true,
        },
      }),
    {
      onStoreError: (storeId, err) => logger.error({ err, storeId }, '[billing] stuck scan failed'),
    }
  );
  const rows = parts.flatMap(p => p.value);
  let active: BillingProvider | null = provider ?? null;
  if (!active && rows.length > 0) {
    try {
      active = getBillingProvider();
    } catch {
      active = null; // card billing is off (InstaPay only): nothing to ask
    }
  }
  const out = { polled: 0, settled: 0, notFound: 0, stillStuck: 0 };
  const stuck: string[] = [];
  for (const r of rows) {
    try {
      if (!active?.getChargeStatus) {
        stuck.push(r.id);
        continue;
      }
      out.polled++;
      const res = await active.getChargeStatus({
        idempotencyKey: r.idempotencyKey,
        merchantOrderId: r.id,
        chargeId: r.providerRef,
      });
      if (res === null) {
        const t = await settleCharge(
          r.id,
          { status: 'failed', failureReason: 'not_found_at_gateway' },
          now
        );
        if (t.transitioned) out.notFound++;
        continue;
      }
      if (res.status === 'pending') {
        stuck.push(r.id);
        continue;
      }
      const t = await settleCharge(
        r.id,
        {
          status: res.status,
          providerRef: res.chargeId,
          failureReason: res.failureReason,
          raw: res.raw,
        },
        now
      );
      if (t.transitioned) out.settled++;
    } catch (err) {
      logger.warn(
        { err, eventId: r.id },
        '[billing] stuck charge lookup / settle failed; left pending'
      );
      stuck.push(r.id);
    }
  }
  out.stillStuck = stuck.length;
  if (stuck.length > 0) {
    void sendAlert({
      level: 'p1',
      title: 'Billing: charges with an unknown outcome',
      body: `${stuck.length} renewal/upgrade charge(s) pending for over an hour with no gateway answer: ${stuck.slice(0, 10).join(', ')}. Not retried (a retry could charge the customer twice). Check the gateway dashboard and /billing-events.`,
    }).catch(() => undefined);
  }
  return out;
}

export async function expireStaleCheckouts(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_CHECKOUT_MS);
  const parts = await acrossBilling(
    storeId =>
      prisma.billingEvent.updateMany({
        where: {
          ...(storeId ? { storeId } : {}),
          type: { in: ['checkout', 'card_setup'] },
          status: 'pending',
          createdAt: { lt: cutoff },
          // a row holding a LIVE D1 settle lease is being paid, not abandoned; a stale lease (its settler died) expires
          OR: [
            { failureReason: null },
            { failureReason: { not: SETTLE_LEASE } },
            { updatedAt: { lt: new Date(now.getTime() - SETTLE_LEASE_MS) } },
          ],
        },
        data: { status: 'failed', failureReason: 'abandoned' },
      }),
    { onStoreError: (storeId, err) => logger.error({ err, storeId }, '[billing] expiry failed') }
  );
  return parts.reduce((n, p) => n + p.value.count, 0);
}

/** One pass of the daily cycle. Idempotent: running it twice charges once. */
export async function runBillingCycle(
  now: Date = new Date(),
  provider?: BillingProvider,
  /** Restrict the pass to specific subscriptions (operator re-run for one store). */
  only?: { subscriptionIds?: string[] }
): Promise<CycleSummary> {
  const summary: CycleSummary = {
    examined: 0,
    charged: 0,
    skipped: 0,
    canceled: 0,
    errors: 0,
    expiredCheckouts: await expireStaleCheckouts(now),
    reminders: 0,
    suspended: 0,
  };
  if (!only) {
    for (const id of await findReminderCandidates(now)) {
      try {
        if ((await sendDueReminder(id, now)).sent) summary.reminders++;
      } catch (err) {
        summary.errors++;
        logger.error({ err, subscriptionId: id }, '[billing] reminder threw');
      }
    }
  }
  if (!only) {
    // FOUNDING-1: apply pending free months / re-create lost ones before the due list is read (a granted month
    // moves a store's due date). Never blocks the renewals below.
    await sweepFreeMonthGrants(now).catch(err =>
      logger.error({ err }, '[billing] free-month grant sweep failed')
    );
    // M-023: settle / hand on charges whose outcome never arrived, BEFORE the due list is read (a given-up
    // renewal enters dunning and may be due again today).
    await processDeferredBillingWebhooks().catch(err =>
      logger.error({ err }, '[billing] deferred webhook processing failed')
    );
    await reconcilePlanTiers().catch(err =>
      logger.error({ err }, '[billing] plan tier reconciliation failed')
    );
    await sweepStuckCharges(now, provider).catch(err =>
      logger.error({ err }, '[billing] stuck-charge sweep failed')
    );
  }
  if (!only) {
    await renewDueAddons(now, provider).catch(err =>
      logger.error({ err }, '[billing] add-on renewal pass failed')
    );
  }
  const ids = await findDueSubscriptionIds(now, only);
  for (const id of ids) {
    summary.examined++;
    try {
      const r = await renewSubscription(id, now, provider);
      if (r.action === 'charged') summary.charged++;
      else if (r.action === 'skipped') summary.skipped++;
      else if (r.action === 'suspended') summary.suspended++;
      else summary.canceled++;
    } catch (err) {
      summary.errors++;
      logger.error({ err, subscriptionId: id }, '[billing] renewal threw');
    }
  }
  return summary;
}

// ───────────────────────── merchant plan operations ───────────────────────

export type ChangePlanResult =
  | { mode: 'upgraded'; status: 'succeeded' | 'failed' | 'pending'; eventId: string }
  | { mode: 'scheduled'; effectiveAt: Date; planCode: string };

export async function changePlan(args: {
  storeId: string;
  planCode: string;
  now?: Date;
  provider?: BillingProvider;
}): Promise<ChangePlanResult> {
  await assertPayableStore(args.storeId);
  const now = args.now ?? new Date();
  const provider = args.provider ?? getBillingProvider();
  const sub = await loadSub(args.storeId);
  if (!sub) throw new AppError(409, 'NO_SUBSCRIPTION', 'Start a plan first');
  if (sub.status === 'comped' || isGrantedPlan(sub.planCode)) {
    throw new AppError(409, 'STORE_COMPED', 'Comped stores are not billed');
  }
  if (args.planCode === FREE_PLAN_CODE) {
    await cancelSubscription({ storeId: args.storeId });
    return {
      mode: 'scheduled',
      effectiveAt: sub.currentPeriodEnd ?? now,
      planCode: FREE_PLAN_CODE,
    };
  }
  const interval = isInterval(sub.billingInterval) ? sub.billingInterval : 'monthly';
  const { plan, price } = await loadPayablePlan(args.planCode, interval);
  if (plan.code === sub.planCode && !sub.pendingPlanCode) {
    throw new AppError(400, 'SAME_PLAN', 'Already on this plan');
  }
  if (!sub.providerPaymentMethodRef || !sub.provider || sub.status !== 'active') {
    throw new AppError(409, 'NO_PAYMENT_METHOD', 'Start a checkout to add a payment method first');
  }
  const current = await prisma.plan.findUnique({ where: { code: sub.planCode } });
  const currentPrice = (current && priceFor(current, interval)) || 0;

  if (price > currentPrice) {
    // UPGRADE — immediate, full charge, fresh period from now (no proration).
    const prior = await withStore(args.storeId, tx =>
      tx.billingEvent.findMany({
        where: {
          storeId: args.storeId,
          subscriptionId: sub.id,
          type: 'upgrade',
          planCode: plan.code,
          forPeriodEnd: sub.currentPeriodEnd,
        },
        select: { status: true },
      })
    );
    if (prior.some(p => p.status === 'pending')) {
      throw new AppError(409, 'UPGRADE_IN_PROGRESS', 'An upgrade charge is already in progress');
    }
    const amount = await chargeFor(price);
    const eventId = await claimEvent({
      storeId: args.storeId,
      subscriptionId: sub.id,
      type: 'upgrade',
      planCode: plan.code,
      billingInterval: interval,
      forPeriodEnd: sub.currentPeriodEnd,
      amountMinor: amount.totalMinor,
      charge: amount,
      provider: provider.name,
      idempotencyKey: upgradeKey(sub.id, plan.code, sub.currentPeriodEnd, prior.length + 1),
    });
    if (!eventId)
      throw new AppError(409, 'UPGRADE_IN_PROGRESS', 'An upgrade charge is already in progress');
    let token: string;
    try {
      token = encryption.decrypt(sub.providerPaymentMethodRef);
    } catch {
      await settleCharge(
        eventId,
        { status: 'failed', failureReason: 'payment_method_unreadable' },
        now
      );
      return { mode: 'upgraded', status: 'failed', eventId };
    }
    const r = await chargeAndSettle({
      provider,
      eventId,
      token,
      amountMinor: amount.totalMinor,
      idempotencyKey: upgradeKey(sub.id, plan.code, sub.currentPeriodEnd, prior.length + 1),
      description: `${plan.nameEn} upgrade (${interval})`,
      now,
    });
    return { mode: 'upgraded', status: r.settled, eventId };
  }

  // DOWNGRADE — at the period end; renewal then charges the cheaper plan.
  await withStore(args.storeId, tx =>
    tx.storeSubscription.update({
      where: { storeId: args.storeId },
      data: { pendingPlanCode: plan.code, cancelAtPeriodEnd: false },
    })
  );
  return { mode: 'scheduled', effectiveAt: sub.currentPeriodEnd ?? now, planCode: plan.code };
}

export async function cancelSubscription(args: {
  storeId: string;
}): Promise<{ mode: 'at_period_end' | 'immediate'; effectiveAt: Date | null }> {
  const sub = await loadSub(args.storeId);
  if (!sub || sub.status === 'canceled' || sub.planCode === FREE_PLAN_CODE) {
    throw new AppError(409, 'NOTHING_TO_CANCEL', 'There is no paid plan to cancel');
  }
  if (sub.status === 'comped')
    throw new AppError(409, 'STORE_COMPED', 'Comped stores are not billed');
  if (sub.status === 'past_due' || !sub.currentPeriodEnd) {
    const effects: BillingEffect[] = [];
    await withStore(args.storeId, tx => downgradeToFree(tx, args.storeId, 'canceled', effects));
    await runBillingEffects(effects);
    return { mode: 'immediate', effectiveAt: null };
  }
  await withStore(args.storeId, tx =>
    tx.storeSubscription.update({
      where: { storeId: args.storeId },
      data: { cancelAtPeriodEnd: true, pendingPlanCode: null },
    })
  );
  return { mode: 'at_period_end', effectiveAt: sub.currentPeriodEnd };
}

export async function resumeSubscription(args: { storeId: string }): Promise<void> {
  const sub = await loadSub(args.storeId);
  if (!sub || !['active', 'trialing'].includes(sub.status)) {
    throw new AppError(409, 'NOTHING_TO_RESUME', 'Nothing to resume');
  }
  await withStore(args.storeId, tx =>
    tx.storeSubscription.update({
      where: { storeId: args.storeId },
      data: { cancelAtPeriodEnd: false, pendingPlanCode: null },
    })
  );
}

// ───────────────────────────── webhooks ───────────────────────────────────

export interface WebhookResult {
  duplicate: boolean;
  outcome: 'processed' | 'ignored' | 'deferred';
  detail?: string;
}

/**
 * Apply a VERIFIED provider event. Dedupe (UNIQUE provider+eventId), the
 * settlement and its subscription effects share ONE transaction, so a crash
 * never leaves an event "seen" but unapplied (the provider's retry re-runs it).
 */
export async function applyWebhookEvent(
  providerName: string,
  event: BillingWebhookEvent,
  now: Date = new Date()
): Promise<WebhookResult> {
  const effects: BillingEffect[] = [];
  // A signed provider callback names a ledger row or a provider reference, not a
  // store: the store comes from a definer, and the dedupe + settlement then run
  // in ONE transaction scoped to it. With no resolvable store only the (store-less)
  // dedupe ledger is touched and the event is ignored.
  let webhookStoreId: string | null = null;
  if (event.kind === 'refund.succeeded' || event.kind === 'refund.failed') {
    webhookStoreId = event.providerRef
      ? await getBillingRefundStoreId(providerName, event.providerRef)
      : null;
  } else if (
    event.kind !== 'ignored' &&
    event.merchantOrderId &&
    UUID_RE.test(event.merchantOrderId)
  ) {
    webhookStoreId = await getEntityStoreId('billing_event', event.merchantOrderId);
  }
  const scopedStoreId = webhookStoreId;
  const applyInner = async (tx: Tx): Promise<WebhookResult> => {
    const ignore = async (detail: string): Promise<WebhookResult> => {
      await tx.billingWebhookEvent.updateMany({
        where: { provider: providerName, eventId: event.eventId },
        data: { outcome: 'ignored', detail },
      });
      return { duplicate: false, outcome: 'ignored', detail };
    };

    if (event.kind === 'ignored') return ignore('unhandled_event');

    // Refund confirmations (async refunds only; sync ones are settled by refundCharge).
    if (event.kind === 'refund.succeeded' || event.kind === 'refund.failed') {
      const refundRow =
        event.providerRef && scopedStoreId
          ? await tx.billingEvent.findFirst({
              where: {
                storeId: scopedStoreId,
                type: 'refund',
                provider: providerName,
                providerRef: event.providerRef,
                status: 'pending',
              },
            })
          : null;
      if (!refundRow) return ignore('unknown_refund');
      await settleRefundInTx(
        tx,
        refundRow.storeId,
        refundRow.id,
        event.kind === 'refund.succeeded',
        event.failureReason,
        effects
      );
      return { duplicate: false, outcome: 'processed' };
    }

    const row =
      event.merchantOrderId && UUID_RE.test(event.merchantOrderId) && scopedStoreId
        ? await tx.billingEvent.findUnique({
            where: { id: event.merchantOrderId, storeId: scopedStoreId },
          })
        : null;
    if (!row || row.provider !== providerName || row.type === 'refund') {
      logger.warn({ providerName, eventId: event.eventId }, '[billing] webhook for unknown order');
      return ignore('unknown_order');
    }
    // A card event settles ONLY a card_setup row, and a charge event never does:
    // otherwise a "card saved" delivery could activate a paid plan with no money,
    // or a charge could be booked against a no-charge setup.
    const isCardEvent = event.kind === 'card.saved' || event.kind === 'card.failed';
    if (isCardEvent !== (row.type === 'card_setup')) {
      logger.error(
        { eventId: event.eventId, kind: event.kind, rowType: row.type },
        '[billing] webhook kind does not match the ledger row'
      );
      return ignore('kind_mismatch');
    }
    if (event.amountMinor !== null && event.amountMinor !== row.amountMinor) {
      logger.error(
        { eventId: event.eventId, expected: row.amountMinor, got: event.amountMinor },
        '[billing] webhook amount mismatch — ignored'
      );
      return ignore('amount_mismatch');
    }
    await settleInTx(
      tx,
      row.id,
      {
        status:
          event.kind === 'charge.succeeded' || event.kind === 'card.saved' ? 'succeeded' : 'failed',
        providerRef: event.providerRef,
        failureReason: event.failureReason,
        raw: event.raw,
        cardToken: event.card?.token,
        cardLast4: event.card?.last4,
        cardBrand: event.card?.brand,
        customerRef: event.customerRef,
      },
      now,
      effects
    );
    return { duplicate: false, outcome: 'processed' };
  };
  // The dedupe row is a CLAIM, not a receipt: it is inserted as `processing` and finalised after the settlement. On
  // Postgres a failure rolls the claim back with everything else; D1 commits the claim at once, so a failure deletes it
  // and a crash leaves a `processing` row that the provider's retry may take over once it is stale. Without this a
  // throw after the claim turned the provider's retry into a "replay" and the paid checkout never got its plan.
  let tookDeferred = false;
  const apply = async (tx: Tx): Promise<WebhookResult> => {
    const ins = await tx.billingWebhookEvent.createMany({
      data: [
        {
          provider: providerName,
          eventId: event.eventId,
          eventType: event.kind,
          outcome: WEBHOOK_PROCESSING,
        },
      ],
      skipDuplicates: true,
    });
    if (ins.count === 0) {
      // A delivery that arrived during the cutover freeze was stored `deferred` (handleBillingWebhook); whoever flips it
      // to `processing` first (this delivery or the deferred-queue processor) applies it, exactly once.
      const fromDeferred = await tx.billingWebhookEvent.updateMany({
        where: { provider: providerName, eventId: event.eventId, outcome: WEBHOOK_DEFERRED },
        data: { outcome: WEBHOOK_PROCESSING, receivedAt: now },
      });
      tookDeferred = fromDeferred.count === 1;
      const takeover = tookDeferred
        ? { count: 1 }
        : await tx.billingWebhookEvent.updateMany({
            where: {
              provider: providerName,
              eventId: event.eventId,
              outcome: WEBHOOK_PROCESSING,
              receivedAt: { lt: new Date(now.getTime() - WEBHOOK_CLAIM_STALE_MS) },
            },
            data: { receivedAt: now },
          });
      if (takeover.count === 0) {
        const held = await tx.billingWebhookEvent.findFirst({
          where: { provider: providerName, eventId: event.eventId, outcome: WEBHOOK_PROCESSING },
          select: { id: true },
        });
        if (held)
          throw new AppError(
            503,
            'WEBHOOK_IN_FLIGHT',
            'This webhook is being processed; retry shortly',
            { retryable: true }
          );
        return { duplicate: true, outcome: 'ignored', detail: 'replay' };
      }
    }
    try {
      const out = await applyInner(tx);
      await tx.billingWebhookEvent.updateMany({
        where: { provider: providerName, eventId: event.eventId, outcome: WEBHOOK_PROCESSING },
        // `detail` held the encrypted deferred event (card token included): gone once applied
        data: { outcome: 'processed', detail: null },
      });
      return out;
    } catch (err) {
      if (await onD1()) {
        // a claim taken over from the deferred queue goes BACK to the queue (the payment must not be forgotten)
        const release = tookDeferred
          ? tx.billingWebhookEvent.updateMany({
              where: {
                provider: providerName,
                eventId: event.eventId,
                outcome: WEBHOOK_PROCESSING,
              },
              data: { outcome: WEBHOOK_DEFERRED },
            })
          : tx.billingWebhookEvent.deleteMany({
              where: {
                provider: providerName,
                eventId: event.eventId,
                outcome: WEBHOOK_PROCESSING,
              },
            });
        await release.catch(undo =>
          logger.error(
            { err: undo, eventId: event.eventId },
            '[billing] could not release a webhook claim'
          )
        );
      }
      throw err;
    }
  };
  const result = webhookStoreId
    ? await withStore(webhookStoreId, apply)
    : await apply(prisma as unknown as Tx);
  await runBillingEffects(effects);
  return result;
}

/**
 * The adapter a billing webhook URL names. 404 for a provider this deployment does not serve;
 * 503 `BILLING_NOT_CONFIGURED` when subscription billing is not set up (production with no
 * `BILLING_PROVIDER`, or Kashier without its keys): a configuration gap is the server's state,
 * not the caller's fault and not a crash, so it is never a 500 (Ruling PROVIDERS-20).
 */
function billingWebhookProvider(providerName: string) {
  let provider: ReturnType<typeof getBillingProviderByName>;
  try {
    provider = getBillingProviderByName(providerName);
  } catch (err) {
    logger.warn(
      { providerName, reason: (err as Error).message },
      '[billing-webhook] subscription billing is not configured'
    );
    throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Subscription billing is not configured');
  }
  if (!provider) throw new AppError(404, 'UNKNOWN_PROVIDER', 'Unknown billing provider');
  if (provider.isConfigured && !provider.isConfigured()) {
    logger.warn({ providerName }, '[billing-webhook] provider credentials are missing');
    throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Subscription billing is not configured');
  }
  return provider;
}

/**
 * Route entry: resolve adapter, verify signature, confirm, apply. Throws AppError 404 / 503 and
 * BillingSignatureError (401 at the route).
 */
export async function handleBillingWebhook(
  providerName: string,
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>
): Promise<WebhookResult> {
  const provider = billingWebhookProvider(providerName);
  const event = provider.verifyWebhook(rawBody, headers); // signature / HMAC FIRST: nothing unauthenticated is stored
  // Cutover freeze: the family's writes are refused, but a payment notification must not be lost (Paymob documents no
  // retry for failed deliveries; Kashier's is unverified). Store the authenticated event durably, answer 200, and let the
  // deferred queue apply it once the freeze is lifted (confirm-before-apply runs THEN).
  if (await isFamilyFrozen('billing')) {
    await deferBillingWebhookD1({
      provider: provider.name,
      eventId: event.eventId,
      eventType: event.kind,
      // The raw body is NEVER stored (the signature is verified, it is not needed again). The parsed event may carry a card
      // token, so the whole blob is encrypted at rest; it is decrypted by processDeferredBillingWebhooks and erased
      // (detail = NULL) the moment the event is applied.
      payload: encryption.encrypt(JSON.stringify({ event })),
    });
    return { duplicate: false, outcome: 'deferred', detail: 'family_frozen' };
  }
  void drainDeferredSoon();
  return confirmAndApplyWebhook(provider, event);
}

/** A deferred webhook older than this with no marker is an aborted cutover, not a freeze in progress (the freeze TTL is 15 min). */
export const ORPHANED_DEFERRED_AFTER_MS = 30 * 60_000;
const ORPHAN_ALERT_EVERY_MS = 6 * 60 * 60_000;
let lastOrphanAlert = 0;
/** Test seam. */
export const resetOrphanedDeferredAlert = (): void => {
  lastOrphanAlert = 0;
};

/**
 * P1 when deferred billing webhooks older than 30 minutes exist and the `billing` marker does not (called only without the
 * marker). At most once per 6 hours per isolate; a D1 outage is logged, never thrown (the cron must not die on its monitor).
 */
export async function alertOrphanedDeferredWebhooks(now = Date.now()): Promise<boolean> {
  if (!cfBindings()?.PLATFORM_DB) return false;
  try {
    const { count, oldestMs } = await staleDeferredBillingWebhooksD1(
      now - ORPHANED_DEFERRED_AFTER_MS
    );
    if (count === 0 || now - lastOrphanAlert < ORPHAN_ALERT_EVERY_MS) return false;
    lastOrphanAlert = now;
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'billing.deferred_webhooks_orphaned',
      title: 'Deferred billing webhooks are waiting for a marker that does not exist',
      body:
        `${count} authenticated billing webhook(s) stored during a cutover freeze are older than 30 minutes (oldest ` +
        `${oldestMs ? new Date(oldestMs).toISOString() : 'unknown'}) and platform_cutover.billing is not set, so nothing applies them. ` +
        'Re-run `node scripts/cf/cutover-platform-family.mjs --family billing ... --commit` (runbook: docs/runbooks/platform-family-cutover.md, "Deferred webhooks with no marker").',
    });
    return true;
  } catch (err) {
    logger.error({ err }, '[billing] orphaned deferred webhook check failed');
    return false;
  }
}

let lastDeferredDrain = 0;
/** Opportunistic: the first webhook after the freeze drains the queue (at most every 30 s per isolate). */
function drainDeferredSoon(): Promise<void> {
  if (Date.now() - lastDeferredDrain < 30_000) return Promise.resolve();
  lastDeferredDrain = Date.now();
  return processDeferredBillingWebhooks()
    .then(() => undefined)
    .catch(err => logger.error({ err }, '[billing] deferred webhook drain failed'));
}

/**
 * Apply the webhooks stored during a cutover freeze (cron every 15 min, the daily cycle, and the first webhook after the
 * freeze). Each is confirmed at the gateway like a live delivery, then applied through the same claim, so a delivery
 * that also arrives live is applied once. A row that cannot be applied stays deferred.
 */
export async function processDeferredBillingWebhooks(limit = 50): Promise<number> {
  if (!(await onD1())) {
    // Ruling NZ-PG-6: no marker = nothing is applied. After a `--commit` that aborted and was not re-run, the events stored
    // during its freeze would wait for a marker that never comes: the gateway got its 200, the payment is not booked.
    await alertOrphanedDeferredWebhooks();
    return 0;
  }
  if (await isFamilyFrozen('billing')) return 0;
  let applied = 0;
  for (const row of await listDeferredBillingWebhooksD1(limit)) {
    try {
      const { event } = JSON.parse(encryption.decrypt(row.detail)) as {
        event: BillingWebhookEvent;
      };
      event.occurredAt = new Date(event.occurredAt);
      const provider = billingWebhookProvider(row.provider);
      await confirmAndApplyWebhook(provider, event);
      applied++;
    } catch (err) {
      logger.error(
        { err, provider: row.provider, eventId: row.eventId },
        '[billing] deferred webhook not applied yet'
      );
    }
  }
  return applied;
}

async function confirmAndApplyWebhook(
  provider: ReturnType<typeof billingWebhookProvider>,
  verified: BillingWebhookEvent
): Promise<WebhookResult> {
  let event = verified;
  // PROVIDERS-17 confirm-before-apply: only the gateway's own record of the transaction is
  // applied. Failure throws (500, the gateway redelivers, the dedupe row is never written).
  if (provider.confirmWebhookEvent && event.kind !== 'ignored') {
    let confirmation;
    try {
      confirmation = await provider.confirmWebhookEvent(event);
    } catch (err) {
      await auditLog({
        action: 'BILLING_WEBHOOK_UNCONFIRMED',
        resourceType: 'billing',
        resourceId: event.merchantOrderId ?? undefined,
        details: {
          provider: provider.name,
          eventId: event.eventId,
          claimed: event.kind,
          reason: (err as Error).message.slice(0, 300),
        },
      });
      throw new AppError(
        503,
        'WEBHOOK_UNCONFIRMED',
        'The gateway could not confirm this webhook; it was not applied and will be retried'
      );
    }
    await auditLog({
      action: confirmation.mismatch ? 'BILLING_WEBHOOK_CORRECTED' : 'BILLING_WEBHOOK_CONFIRMED',
      resourceType: 'billing',
      resourceId: event.merchantOrderId ?? undefined,
      details: {
        provider: provider.name,
        eventId: event.eventId,
        claimed: confirmation.claimed,
        confirmed: confirmation.confirmed,
        source: confirmation.source,
      },
    });
    if (confirmation.mismatch) {
      logger.error(
        {
          provider: provider.name,
          claimed: confirmation.claimed,
          confirmed: confirmation.confirmed,
        },
        '[billing-webhook] delivery label disagreed with the gateway record — applying the record'
      );
    }
    event = confirmation.event;
  }
  return applyWebhookEvent(provider.name, event);
}

// ───────────────────────────── refunds ────────────────────────────────────

async function settleRefundInTx(
  tx: Tx,
  storeId: string,
  refundId: string,
  succeeded: boolean,
  reason?: string,
  effects?: BillingEffect[]
): Promise<void> {
  const upd = await tx.billingEvent.updateMany({
    where: { id: refundId, storeId, status: 'pending' },
    data: succeeded
      ? { status: 'succeeded' }
      : { status: 'failed', failureReason: reason ?? 'refund_failed' },
  });
  if (upd.count === 0 || !succeeded) return;
  const refund = await tx.billingEvent.findUnique({ where: { id: refundId, storeId } });
  if (!refund?.relatedEventId) return;
  const charge = await tx.billingEvent.findUnique({
    where: { id: refund.relatedEventId, storeId },
  });
  if (!charge) return;
  const agg = await tx.billingEvent.aggregate({
    where: { storeId, relatedEventId: charge.id, type: 'refund', status: 'succeeded' },
    _sum: { amountMinor: true },
  });
  if ((agg._sum.amountMinor ?? 0) >= charge.amountMinor) {
    const flipped = await tx.billingEvent.updateMany({
      where: { id: charge.id, storeId, status: 'succeeded' },
      data: { status: 'refunded' },
    });
    // FOUNDING-3: the payment behind any free month is gone, so the free months go too (own store inline; a
    // referrer in another tenant is restored by restoreRevokedGrants / the daily sweep).
    if (flipped.count === 1) {
      await revokeGrantsForEvent(tx, charge.id, 'payment_refunded', new Date(), storeId);
      // A refunded add-on stops being an entitlement AT ONCE: drop the cached feature map (NEVER-stale class).
      if (isAddonRow(charge)) effects?.push({ kind: 'addon_granted', storeId });
    }
  }
}

/**
 * Refund (part of) a succeeded charge. Super-admin only (route). Does NOT
 * change the subscription — plan changes are separate decisions.
 */
export async function refundCharge(args: {
  eventId: string;
  amountMinor?: number;
  provider?: BillingProvider;
}): Promise<{ refundEventId: string; status: 'succeeded' | 'failed' | 'pending' }> {
  const provider = args.provider ?? getBillingProvider();
  const chargeStoreId = await getEntityStoreId('billing_event', args.eventId);
  const charge = chargeStoreId
    ? await withStore(chargeStoreId, tx =>
        tx.billingEvent.findUnique({ where: { id: args.eventId, storeId: chargeStoreId } })
      )
    : null;
  if (!charge || charge.type === 'refund')
    throw new AppError(404, 'CHARGE_NOT_FOUND', 'Charge not found');
  if (charge.type === 'manual_payment' || charge.type === 'card_setup') {
    // A manual payment was never taken by the gateway; a card setup took nothing.
    throw new AppError(409, 'NOT_REFUNDABLE', 'Refund manual payments outside the gateway');
  }
  if (charge.status !== 'succeeded' || !charge.providerRef) {
    throw new AppError(409, 'NOT_REFUNDABLE', 'Only a succeeded charge can be refunded');
  }
  // EVERY attempt, whatever its outcome: the key below is numbered by attempts, so a failed / rejected refund
  // must still count or its retry regenerates the same key and is blocked for good (M-062). Only pending
  // and succeeded rows hold money, so only they count toward `remaining`.
  const attempts = await withStore(charge.storeId, tx =>
    tx.billingEvent.findMany({
      where: { storeId: charge.storeId, relatedEventId: charge.id, type: 'refund' },
      select: { amountMinor: true, status: true },
    })
  );
  if (attempts.some(p => p.status === 'pending')) {
    throw new AppError(409, 'REFUND_IN_PROGRESS', 'A refund is already pending for this charge');
  }
  const remaining =
    charge.amountMinor -
    attempts.filter(p => p.status === 'succeeded').reduce((s, p) => s + p.amountMinor, 0);
  const amount = args.amountMinor ?? remaining;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) {
    throw new AppError(
      400,
      'INVALID_REFUND_AMOUNT',
      `Refund must be between 1 and ${remaining} piastres`
    );
  }
  const key = `refund:${charge.id}:${attempts.length + 1}`;
  const refundId = await claimEvent({
    storeId: charge.storeId,
    subscriptionId: charge.subscriptionId,
    type: 'refund',
    planCode: charge.planCode,
    amountMinor: amount,
    provider: charge.provider,
    idempotencyKey: key,
    relatedEventId: charge.id,
  });
  if (!refundId) throw new AppError(409, 'REFUND_IN_PROGRESS', 'A refund is already in progress');
  try {
    const res = await provider.refund({
      chargeId: charge.providerRef,
      amountMinor: amount,
      idempotencyKey: key,
    });
    const refundEffects: BillingEffect[] = [];
    await withStore(charge.storeId, async tx => {
      await tx.billingEvent.updateMany({
        where: { id: refundId, storeId: charge.storeId, status: 'pending' },
        data: { providerRef: res.refundId ?? undefined, raw: res.raw as Prisma.InputJsonValue },
      });
      if (res.status !== 'pending') {
        await settleRefundInTx(
          tx,
          charge.storeId,
          refundId,
          res.status === 'succeeded',
          res.failureReason,
          refundEffects
        );
      }
    });
    await runBillingEffects(refundEffects);
    // the referrer's side of a revoked grant lives in another tenant: take it back now, the sweep retries a miss
    await restoreRevokedGrants().catch(() => undefined);
    return { refundEventId: refundId, status: res.status };
  } catch (err) {
    if (err instanceof BillingProviderError && err.notCharged) {
      await markFailedUnlessSettled(refundId, `provider_error: ${err.message}`);
      throw new AppError(502, 'BILLING_PROVIDER_ERROR', 'The provider rejected the refund');
    }
    logger.error({ err, refundId }, '[billing] refund outcome unknown — left pending');
    throw new AppError(502, 'BILLING_PROVIDER_ERROR', 'Refund outcome unknown; check the ledger');
  }
}

// ───────────────────────────── read models (UI) ───────────────────────────

const PUBLIC_FIELDS = {
  id: true,
  type: true,
  planCode: true,
  billingInterval: true,
  amountMinor: true,
  /** Ebda VAT inside amountMinor + the snapshot (rate, mode, Ebda TRN/legal name) for the invoice. */
  vatMinor: true,
  vat: true,
  currency: true,
  status: true,
  failureReason: true,
  attempt: true,
  createdAt: true,
} as const;

/** Merchant view: their own charges/invoices, newest first (no provider payloads). */
export async function listStoreCharges(storeId: string, limit = 50) {
  const rows = await withStore(storeId, tx =>
    tx.billingEvent.findMany({
      // the append-only cancel / resume rows are bookkeeping, not charges
      where: {
        storeId,
        OR: [{ planCode: null }, { NOT: { planCode: { startsWith: ADDON_MARKER_PREFIX } } }],
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: PUBLIC_FIELDS,
    })
  );
  // Internal failure codes (provider/config errors) are for operators only.
  return rows.map(r => ({
    ...r,
    failureReason: /^(provider_error|checkout_error|payment_method_unreadable)/.test(
      r.failureReason ?? ''
    )
      ? 'payment_not_completed'
      : r.failureReason,
  }));
}

/** Super-admin ledger, filterable, with store names and provider references. */
export async function listLedger(args: {
  storeId?: string;
  status?: string;
  type?: string;
  limit?: number;
  before?: Date;
}) {
  const take = Math.min(Math.max(args.limit ?? 50, 1), 200);
  // Cross-store, super_admin only (route): one window per store, merged by time.
  type LedgerRow = Prisma.BillingEventGetPayload<{
    include: { store: { select: { name: true; slug: true } } };
  }>;
  // D1: ONE indexed query over the whole ledger (no per-store fan-out, no Postgres scope per store).
  const d1Rows = (await onD1())
    ? await prisma.billingEvent.findMany({
        where: {
          ...(args.storeId ? { storeId: args.storeId } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(args.type ? { type: args.type } : {}),
          ...(args.before ? { createdAt: { lt: args.before } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take,
        include: { store: { select: { name: true, slug: true } } },
      })
    : null;
  const { rows } = d1Rows
    ? { rows: d1Rows as LedgerRow[] }
    : await pageAcrossStores<LedgerRow>({
        storeIds: args.storeId ? [args.storeId] : undefined,
        skip: 0,
        take,
        orderKey: r => r.createdAt,
        fetch: async window => {
          // Each fetch runs inside one store's scope (pageAcrossStores): that store.
          const where = {
            storeId: currentStoreId(),
            ...(args.status ? { status: args.status } : {}),
            ...(args.type ? { type: args.type } : {}),
            ...(args.before ? { createdAt: { lt: args.before } } : {}),
          };
          const [found, total] = await Promise.all([
            prisma.billingEvent.findMany({
              where,
              orderBy: { createdAt: 'desc' },
              take: window,
              include: { store: { select: { name: true, slug: true } } },
            }),
            prisma.billingEvent.count({ where }),
          ]);
          return { rows: found, total };
        },
      });
  const stuckBefore = Date.now() - 3_600_000;
  // FOLD-VAT: net / gross / rate, seller + buyer tax ids and the ETA document state (all empty while VAT is off).
  const tax = d1Rows ? await ledgerTaxFieldsD1(rows.map(r => r.id)) : new Map();
  return rows.map(r => ({
    tax: tax.get(r.id) ?? null,
    id: r.id,
    storeId: r.storeId,
    storeName: r.store.name,
    storeSlug: r.store.slug,
    type: r.type,
    planCode: r.planCode,
    billingInterval: r.billingInterval,
    amountMinor: r.amountMinor,
    vatMinor: r.vatMinor,
    vat: r.vat,
    currency: r.currency,
    provider: r.provider,
    providerRef: r.providerRef,
    idempotencyKey: r.idempotencyKey,
    status: r.status,
    failureReason: r.failureReason,
    attempt: r.attempt,
    relatedEventId: r.relatedEventId,
    raw: r.raw,
    createdAt: r.createdAt,
    /** A pending charge older than an hour: outcome unknown, reconcile manually. */
    stuck:
      r.status === 'pending' &&
      r.type !== 'checkout' &&
      r.type !== 'card_setup' &&
      r.createdAt.getTime() < stuckBefore,
  }));
}

type BillingStateSub = {
  status: string;
  planCode: string;
  pendingPlanCode: string | null;
  billingInterval: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  nextRetryAt: Date | null;
  cancelAtPeriodEnd: boolean;
  providerPaymentMethodRef: string | null;
};

/**
 * When and what the store is charged next (null = nothing scheduled): the trial
 * end bills the chosen plan, an active plan its renewal, past_due its retry.
 * Pure, so the merchant page, onboarding and the super-admin table agree.
 */
export function nextChargeOf(
  sub: BillingStateSub | null,
  plans: Array<{ code: string; priceMonthlyMinor: number | null; priceYearlyMinor: number | null }>,
  vat: PlatformVat
): {
  at: Date;
  planCode: string;
  amountMinor: number | null;
  /** Ebda VAT inside `amountMinor` (null = no VAT line). */
  vat: LedgerVat | null;
} | null {
  if (
    !sub ||
    sub.cancelAtPeriodEnd ||
    isGrantedPlan(sub.planCode) ||
    sub.planCode === FREE_PLAN_CODE
  ) {
    return null;
  }
  const at =
    sub.status === 'trialing'
      ? (sub.trialEndsAt ?? sub.currentPeriodEnd)
      : sub.status === 'active'
        ? sub.currentPeriodEnd
        : sub.status === 'past_due'
          ? sub.nextRetryAt
          : null;
  if (!at) return null;
  const planCode = sub.pendingPlanCode ?? sub.planCode;
  const plan = plans.find(p => p.code === planCode);
  const interval: BillingInterval = isInterval(sub.billingInterval)
    ? sub.billingInterval
    : 'monthly';
  const price = plan ? priceFor(plan, interval) : null;
  if (price === null) return { at, planCode, amountMinor: null, vat: null };
  const charge = subscriptionChargeAmount(price, vat);
  return { at, planCode, amountMinor: charge.totalMinor, vat: ledgerVat(charge).vat };
}

/** Billing-cycle facts the merchant Billing page needs beyond the entitlements. */
export async function getSubscriptionBillingState(storeId: string) {
  const sub = await loadSub(storeId);
  const plans = await prisma.plan.findMany({
    select: { code: true, priceMonthlyMinor: true, priceYearlyMinor: true },
  });
  let trialCardMode: 'card_on_file' | 'pay_at_trial_end' | null = null;
  try {
    trialCardMode = resolveTrialCardMode();
  } catch {
    trialCardMode = null;
  }
  // Ruling BILLING-NONE-COPY-1: with BILLING_PROVIDER=none (InstaPay only) no card is ever charged, so the merchant
  // screens must say "payment due", not "next charge". Resolving the provider throws exactly then (and when unset in prod).
  let cardBilling = true;
  try {
    resolveBillingProviderName();
  } catch {
    cardBilling = false;
  }
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { status: true, billingSuspendedReason: true, billingSuspendedAt: true },
    })
  );
  const pendingClaims = await withStore(storeId, tx =>
    tx.manualPaymentClaim.count({ where: { storeId, status: 'pending' } })
  );
  const vat = await resolvePlatformVat();
  const next = nextChargeOf(sub, plans, vat);
  const now = Date.now();
  const daysLeft = next ? Math.ceil((next.at.getTime() - now) / 86_400_000) : null;
  const handle = instapayHandle();
  const support = supportContact();
  return {
    billingInterval: sub?.billingInterval ?? 'monthly',
    pendingPlanCode: sub?.pendingPlanCode ?? null,
    nextRetryAt: sub?.nextRetryAt ?? null,
    dunningAttempts: sub?.dunningAttempts ?? 0,
    hasPaymentMethod: !!sub?.providerPaymentMethodRef,
    billedByPlatform: !!sub?.provider,
    /** card | instapay | null (not chosen). */
    billingMethod: (sub?.billingMethod ?? null) as 'card' | 'instapay' | null,
    /** InstaPay instructions; `handle` null = InstaPay not offered (not configured). */
    instapay: {
      available: !!handle,
      handle,
      reference: sub?.paymentReference ?? null,
      amountMinor: next?.amountMinor ?? null,
      /** Ebda VAT inside the amount + Ebda's TRN/legal name; null = no VAT line. */
      vat: next?.vat ?? null,
      /** Ebda's InstaPay QR image (EBDA_INSTAPAY_QR_URL); null = no QR shown. */
      qrUrl: handle ? instapayQrUrl() : null,
      pendingClaims,
    },
    /** Banner input: the next due date when it is within 7 days (or already past). */
    dueSoon:
      next && daysLeft !== null && daysLeft <= 7
        ? { dueAt: next.at, daysLeft: Math.max(daysLeft, 0) }
        : null,
    overdue: sub?.status === 'past_due',
    /** InstaPay: the store is suspended at this time if still unpaid. */
    suspendAt:
      sub?.billingMethod === 'instapay' && sub.status === 'past_due' ? sub.nextRetryAt : null,
    /** wa.me link to Ebda support (no WhatsApp API); null when not configured. */
    supportWhatsappUrl: support.whatsappUrl,
    /** Always set (EBDA_SUPPORT_EMAIL, default BRAND.supportEmail): the fallback contact. */
    supportEmail: support.email,
    suspension: store?.billingSuspendedReason
      ? { reason: store.billingSuspendedReason, at: store.billingSuspendedAt }
      : null,
    card: sub?.providerPaymentMethodRef
      ? {
          last4: sub.paymentMethodLast4,
          brand: sub.paymentMethodBrand,
          savedAt: sub.paymentMethodSavedAt,
        }
      : null,
    trialEndsAt: sub?.status === 'trialing' ? sub.trialEndsAt : null,
    nextCharge: next,
    trialCardMode,
    cardBilling,
  };
}

/**
 * Super-admin: every store's subscription with card + next charge (one row per
 * store, newest store first). Cross-store, so it reads each store in its own
 * scope (store_subscriptions is strict RLS).
 */
export async function listSubscriptionsForAdmin(
  args: { status?: string; view?: 'due' | 'overdue' | 'suspended'; limit?: number } = {}
) {
  const take = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const plans = await prisma.plan.findMany({
    select: { code: true, priceMonthlyMinor: true, priceYearlyMinor: true },
  });
  const vat = await resolvePlatformVat();
  const parts = await acrossBilling(
    storeId =>
      prisma.storeSubscription.findMany({
        where: {
          ...(storeId ? { storeId } : {}),
          ...(args.status ? { status: args.status as never } : {}),
        },
        include: {
          store: {
            select: {
              name: true,
              slug: true,
              status: true,
              createdAt: true,
              billingSuspendedReason: true,
            },
          },
        },
      }),
    { onStoreError: (storeId, err) => logger.error({ err, storeId }, '[billing] sub list failed') }
  );
  const soon = Date.now() + 7 * 86_400_000;
  return parts
    .flatMap(p => p.value)
    .filter(sub => {
      if (args.view === 'suspended') return !!sub.store.billingSuspendedReason;
      if (args.view === 'overdue') return sub.status === 'past_due';
      if (args.view === 'due') {
        const n = nextChargeOf(sub, plans, vat);
        return !!n && n.at.getTime() <= soon;
      }
      return true;
    })
    .sort((a, b) => b.store.createdAt.getTime() - a.store.createdAt.getTime())
    .slice(0, take)
    .map(sub => ({
      storeId: sub.storeId,
      storeName: sub.store.name,
      storeSlug: sub.store.slug,
      storeStatus: sub.store.status,
      planCode: sub.planCode,
      chosenPlanCode: sub.pendingPlanCode,
      billingInterval: sub.billingInterval,
      status: sub.status,
      trialEndsAt: sub.status === 'trialing' ? sub.trialEndsAt : null,
      card: sub.providerPaymentMethodRef
        ? {
            last4: sub.paymentMethodLast4,
            brand: sub.paymentMethodBrand,
            savedAt: sub.paymentMethodSavedAt,
          }
        : null,
      provider: sub.provider,
      billingMethod: sub.billingMethod,
      paymentReference: sub.paymentReference,
      suspendedReason: sub.store.billingSuspendedReason,
      dunningAttempts: sub.dunningAttempts,
      nextRetryAt: sub.nextRetryAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      nextCharge: nextChargeOf(sub, plans, vat),
    }));
}

// ───────────────────── plan tier reconciliation (D1 subscription vs `stores.plan`) ─────────────────────

/**
 * On D1 the subscription and the tier on `stores` are written by two systems with no shared transaction. This compares
 * them (one D1 query: the directory mirror vs the tier of the plan the subscription names) and repairs `stores.plan` to the
 * SUBSCRIPTION's tier, which is the money truth. Raises one P1 naming the stores. Capped per run; D1 only.
 */
export async function reconcilePlanTiers(
  limit = 200
): Promise<{ checked: number; repaired: number }> {
  if (!(await onD1())) return { checked: 0, repaired: 0 };
  const drift = await planTierDriftD1(limit);
  let repaired = 0;
  for (const d of drift) {
    try {
      await withStore(d.storeId, tx =>
        storeUpdate(tx, { where: { id: d.storeId }, data: { plan: d.tier as never } })
      );
      repaired++;
    } catch (err) {
      logger.error({ err, storeId: d.storeId }, '[billing] plan tier repair failed');
    }
  }
  if (drift.length)
    void sendAlert({
      level: 'p1',
      title:
        'Billing: stores.plan disagreed with the subscription (repaired to the subscription tier)',
      body: `${drift.length} store(s), ${repaired} repaired: ${drift
        .slice(0, 10)
        .map(d => `${d.storeId} ${d.current}->${d.tier}`)
        .join(', ')}`,
    }).catch(() => undefined);
  return { checked: drift.length, repaired };
}
