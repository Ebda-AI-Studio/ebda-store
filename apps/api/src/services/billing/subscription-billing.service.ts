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
 */
import crypto from 'crypto';
import {
  prisma,
  withStore,
  acrossStores,
  type Prisma,
} from '@force/database';
import { getBillingRefundStoreId, getEntityStoreId } from '../../lib/definer';
import { pageAcrossStores } from '../../lib/cross-store';
import { AppError } from '../../middleware/error-handler';
import { config } from '../../config';
import logger from '../../lib/logger';
import { sendAlert } from '../alerts.service';
import { encryption } from '../encryption.service';
import {
  BillingProviderError,
  type BillingProvider,
  type BillingWebhookEvent,
  type ChargeResult,
} from './types';
import { getBillingProvider, getBillingProviderByName } from './index';
import {
  COMPED_PLAN_CODE,
  DUNNING_RETRY_DAYS,
  FREE_PLAN_CODE,
  MAX_DUNNING_ATTEMPTS,
  addDays,
  addInterval,
  isInterval,
  priceFor,
  renewalKey,
  upgradeKey,
  type BillingInterval,
} from './period';
import { runBillingEffects, type BillingEffect } from './billing-notify';

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
  type: 'checkout' | 'renewal' | 'upgrade' | 'refund';
  planCode?: string | null;
  billingInterval?: BillingInterval | null;
  forPeriodEnd?: Date | null;
  attempt?: number;
  amountMinor: number;
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
  fn: (tx: Tx) => Promise<T>,
  whenMissing: T
): Promise<T> {
  const storeId = await getEntityStoreId('billing_event', eventId);
  return storeId ? withStore(storeId, fn) : whenMissing;
}

/**
 * Claim an idempotency key. Returns the new row's id, or null when the key was
 * already claimed (another run / a retry): the caller must NOT call the provider.
 * `ON CONFLICT DO NOTHING` — a duplicate never aborts the surrounding tx.
 */
async function claimEvent(input: ClaimInput): Promise<string | null> {
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
        },
      ],
      skipDuplicates: true,
    })
  );
  return count === 1 ? id : null;
}

async function markFailedUnlessSettled(id: string, reason: string, raw?: unknown): Promise<void> {
  await inEventStore(
    id,
    tx =>
      tx.billingEvent.updateMany({
        where: { id, status: 'pending' },
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
      provider: null,
      providerCustomerId: null,
      providerSubscriptionId: null,
      providerPaymentMethodRef: null,
    },
  });
  if (free) await tx.store.update({ where: { id: storeId }, data: { plan: free.featureTier } });
  effects.push({ kind: 'downgraded', storeId, reason });
}

async function applyPlan(tx: Tx, storeId: string, planCode: string): Promise<void> {
  const plan = await tx.plan.findUnique({ where: { code: planCode } });
  if (plan) await tx.store.update({ where: { id: storeId }, data: { plan: plan.featureTier } });
}

async function applySuccess(
  tx: Tx,
  row: LedgerRow,
  o: Outcome,
  now: Date,
  effects: BillingEffect[]
): Promise<void> {
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
      currentPeriodEnd: addInterval(now, interval),
      cancelAtPeriodEnd: false,
      pendingPlanCode: null,
      dunningAttempts: 0,
      nextRetryAt: null,
      provider: row.provider,
      ...(token ? { providerPaymentMethodRef: token } : {}),
      ...(o.customerRef ? { providerCustomerId: o.customerRef } : {}),
    };
    if (existing) {
      await tx.storeSubscription.update({ where: { storeId: row.storeId }, data });
    } else {
      await tx.storeSubscription.create({ data: { storeId: row.storeId, ...data } });
    }
    await applyPlan(tx, row.storeId, row.planCode);
    effects.push({ kind: 'plan_changed', storeId: row.storeId });
    return;
  }

  if (row.type === 'renewal') {
    const sub = await tx.storeSubscription.findUnique({ where: { storeId: row.storeId } });
    const renewable =
      sub &&
      row.forPeriodEnd &&
      periodEndOf(sub) &&
      periodEndOf(sub)!.getTime() === row.forPeriodEnd.getTime() &&
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
    let start = row.forPeriodEnd!;
    // A long-lapsed period must not leave the new one already expired
    // (that would charge again on the very next cron run).
    if (addInterval(start, interval).getTime() <= now.getTime()) start = now;
    await tx.storeSubscription.update({
      where: { storeId: row.storeId },
      data: {
        planCode,
        billingInterval: interval,
        status: 'active',
        currentPeriodStart: start,
        currentPeriodEnd: addInterval(start, interval),
        trialEndsAt: null,
        pendingPlanCode: null,
        dunningAttempts: 0,
        nextRetryAt: null,
      },
    });
    if (planCode !== sub.planCode) {
      await applyPlan(tx, row.storeId, planCode);
      effects.push({ kind: 'plan_changed', storeId: row.storeId });
    }
  }
}

async function applyFailure(tx: Tx, row: LedgerRow, effects: BillingEffect[]): Promise<void> {
  if (row.type !== 'renewal') return; // a declined checkout/upgrade changes nothing
  const sub = await tx.storeSubscription.findUnique({ where: { storeId: row.storeId } });
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
  const row = await tx.billingEvent.findUnique({ where: { id: eventId } });
  if (!row) return { transitioned: false };
  const raw = (o.raw ?? undefined) as Prisma.InputJsonValue | undefined;
  if (o.status === 'succeeded') {
    const upd = await tx.billingEvent.updateMany({
      where: { id: eventId, status: { in: ['pending', 'failed'] } },
      data: {
        status: 'succeeded',
        failureReason: null,
        ...(o.providerRef ? { providerRef: o.providerRef } : {}),
        ...(raw !== undefined ? { raw } : {}),
      },
    });
    if (upd.count === 0) return { transitioned: false };
    await applySuccess(tx, row, o, now, effects);
    return { transitioned: true };
  }
  const upd = await tx.billingEvent.updateMany({
    where: { id: eventId, status: 'pending' },
    data: {
      status: 'failed',
      failureReason: o.failureReason ?? 'failed',
      ...(o.providerRef ? { providerRef: o.providerRef } : {}),
      ...(raw !== undefined ? { raw } : {}),
    },
  });
  if (upd.count === 0) return { transitioned: false };
  await applyFailure(tx, row, effects);
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

// ───────────────────────── provider call (outside tx) ─────────────────────

type ChargeAttempt = { settled: 'succeeded' | 'failed' } | { settled: 'pending'; reason?: string };

async function chargeAndSettle(args: {
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
    // Unknown outcome (timeout / 5xx): leave `pending`; never re-send blindly.
    logger.error({ err, eventId: args.eventId }, '[billing] charge outcome unknown — left pending');
    return { settled: 'pending', reason: (err as Error).message };
  }
  if (res.status === 'pending') {
    await inEventStore(
      args.eventId,
      tx =>
        tx.billingEvent.updateMany({
          where: { id: args.eventId, status: 'pending' },
          data: { providerRef: res.chargeId ?? undefined },
        }),
      { count: 0 }
    );
    return { settled: 'pending' };
  }
  await settleCharge(
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

async function loadPayablePlan(planCode: string, interval: BillingInterval) {
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) throw new AppError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  if (plan.code === FREE_PLAN_CODE || plan.code === COMPED_PLAN_CODE) {
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

  const eventId = await claimEvent({
    storeId: args.storeId,
    subscriptionId: sub?.id,
    type: 'checkout',
    planCode: plan.code,
    billingInterval: interval,
    amountMinor: price,
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
      amountMinor: price,
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
        where: { id: eventId, status: 'pending' },
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

// ───────────────────────────── renewal / dunning ──────────────────────────

export type RenewalResult =
  | { action: 'skipped'; reason: string }
  | { action: 'charged'; status: 'succeeded' | 'failed' | 'pending'; eventId: string }
  | { action: 'canceled' | 'no_payment_method_downgrade' };

export async function renewSubscription(
  subscriptionId: string,
  now: Date = new Date(),
  provider: BillingProvider = getBillingProvider()
): Promise<RenewalResult> {
  const subStoreId = await getEntityStoreId('store_subscription', subscriptionId);
  const sub = subStoreId
    ? await withStore(subStoreId, tx =>
        tx.storeSubscription.findUnique({ where: { id: subscriptionId } })
      )
    : null;
  if (!sub) return { action: 'skipped', reason: 'not_found' };
  // Comped is NEVER charged (checked on both the status and the plan).
  if (sub.status === 'comped' || sub.planCode === COMPED_PLAN_CODE) {
    return { action: 'skipped', reason: 'comped' };
  }
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

  // A trial that ended with no saved card moves to free (same shape as dunning).
  if (trialEnd && (!sub.provider || !sub.providerPaymentMethodRef)) {
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

  const key = trialEnd
    ? `sub:${sub.id}:trial-end:${periodEnd.toISOString()}`
    : renewalKey(sub.id, periodEnd, attempt);
  const eventId = await claimEvent({
    storeId: sub.storeId,
    subscriptionId: sub.id,
    type: 'renewal',
    planCode: plan.code,
    billingInterval: interval,
    forPeriodEnd: periodEnd,
    attempt,
    amountMinor: price,
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
    amountMinor: price,
    idempotencyKey: key,
    description: `${plan.nameEn} subscription (${interval})`,
    now,
  });
  return { action: 'charged', status: r.settled, eventId };
}

export interface CycleSummary {
  examined: number;
  charged: number;
  skipped: number;
  canceled: number;
  errors: number;
  expiredCheckouts: number;
}

/** Subscription ids that need attention at `now` (renewal due, dunning retry due, cancellation due). */
export async function findDueSubscriptionIds(
  now: Date,
  only?: { subscriptionIds?: string[] }
): Promise<string[]> {
  // Per store, each in its own scope (store_subscriptions is strict-RLS): no
  // bypass, and a store whose scope fails does not hide the rest.
  const parts = await acrossStores(
    () =>
      prisma.storeSubscription.findMany({
        where: {
          ...(only?.subscriptionIds ? { id: { in: only.subscriptionIds } } : {}),
          planCode: { notIn: [COMPED_PLAN_CODE, FREE_PLAN_CODE] },
          OR: [
            {
              status: { in: ['active', 'trialing'] },
              currentPeriodEnd: { lte: now },
              OR: [{ provider: { not: null } }, { cancelAtPeriodEnd: true }],
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

export async function expireStaleCheckouts(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_CHECKOUT_MS);
  const parts = await acrossStores(
    () =>
      prisma.billingEvent.updateMany({
        where: { type: 'checkout', status: 'pending', createdAt: { lt: cutoff } },
        data: { status: 'failed', failureReason: 'abandoned' },
      }),
    { onStoreError: (storeId, err) => logger.error({ err, storeId }, '[billing] expiry failed') }
  );
  return parts.reduce((n, p) => n + p.value.count, 0);
}

/** One pass of the daily cycle. Idempotent: running it twice charges once. */
export async function runBillingCycle(
  now: Date = new Date(),
  provider: BillingProvider = getBillingProvider(),
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
  };
  const ids = await findDueSubscriptionIds(now, only);
  for (const id of ids) {
    summary.examined++;
    try {
      const r = await renewSubscription(id, now, provider);
      if (r.action === 'charged') summary.charged++;
      else if (r.action === 'skipped') summary.skipped++;
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
  const now = args.now ?? new Date();
  const provider = args.provider ?? getBillingProvider();
  const sub = await loadSub(args.storeId);
  if (!sub) throw new AppError(409, 'NO_SUBSCRIPTION', 'Start a plan first');
  if (sub.status === 'comped' || sub.planCode === COMPED_PLAN_CODE) {
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
    const eventId = await claimEvent({
      storeId: args.storeId,
      subscriptionId: sub.id,
      type: 'upgrade',
      planCode: plan.code,
      billingInterval: interval,
      forPeriodEnd: sub.currentPeriodEnd,
      amountMinor: price,
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
      amountMinor: price,
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
  outcome: 'processed' | 'ignored';
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
  } else if (event.kind !== 'ignored' && event.merchantOrderId && UUID_RE.test(event.merchantOrderId)) {
    webhookStoreId = await getEntityStoreId('billing_event', event.merchantOrderId);
  }
  const apply = async (tx: Tx): Promise<WebhookResult> => {
    const ins = await tx.billingWebhookEvent.createMany({
      data: [
        {
          provider: providerName,
          eventId: event.eventId,
          eventType: event.kind,
          outcome: 'processed',
        },
      ],
      skipDuplicates: true,
    });
    if (ins.count === 0) return { duplicate: true, outcome: 'ignored', detail: 'replay' };

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
      const refundRow = event.providerRef
        ? await tx.billingEvent.findFirst({
            where: {
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
        refundRow.id,
        event.kind === 'refund.succeeded',
        event.failureReason
      );
      return { duplicate: false, outcome: 'processed' };
    }

    const row =
      event.merchantOrderId && UUID_RE.test(event.merchantOrderId)
        ? await tx.billingEvent.findUnique({ where: { id: event.merchantOrderId } })
        : null;
    if (!row || row.provider !== providerName || row.type === 'refund') {
      logger.warn({ providerName, eventId: event.eventId }, '[billing] webhook for unknown order');
      return ignore('unknown_order');
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
        status: event.kind === 'charge.succeeded' ? 'succeeded' : 'failed',
        providerRef: event.providerRef,
        failureReason: event.failureReason,
        raw: event.raw,
        cardToken: event.card?.token,
        customerRef: event.customerRef,
      },
      now,
      effects
    );
    return { duplicate: false, outcome: 'processed' };
  };
  const result = webhookStoreId
    ? await withStore(webhookStoreId, apply)
    : await apply(prisma as unknown as Tx);
  await runBillingEffects(effects);
  return result;
}

/** Route entry: resolve adapter, verify signature, apply. Throws BillingSignatureError / AppError(404). */
export async function handleBillingWebhook(
  providerName: string,
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>
): Promise<WebhookResult> {
  const provider = getBillingProviderByName(providerName);
  if (!provider) throw new AppError(404, 'UNKNOWN_PROVIDER', 'Unknown billing provider');
  const event = provider.verifyWebhook(rawBody, headers);
  return applyWebhookEvent(provider.name, event);
}

// ───────────────────────────── refunds ────────────────────────────────────

async function settleRefundInTx(
  tx: Tx,
  refundId: string,
  succeeded: boolean,
  reason?: string
): Promise<void> {
  const upd = await tx.billingEvent.updateMany({
    where: { id: refundId, status: 'pending' },
    data: succeeded
      ? { status: 'succeeded' }
      : { status: 'failed', failureReason: reason ?? 'refund_failed' },
  });
  if (upd.count === 0 || !succeeded) return;
  const refund = await tx.billingEvent.findUnique({ where: { id: refundId } });
  if (!refund?.relatedEventId) return;
  const charge = await tx.billingEvent.findUnique({ where: { id: refund.relatedEventId } });
  if (!charge) return;
  const agg = await tx.billingEvent.aggregate({
    where: { relatedEventId: charge.id, type: 'refund', status: 'succeeded' },
    _sum: { amountMinor: true },
  });
  if ((agg._sum.amountMinor ?? 0) >= charge.amountMinor) {
    await tx.billingEvent.updateMany({
      where: { id: charge.id, status: 'succeeded' },
      data: { status: 'refunded' },
    });
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
        tx.billingEvent.findUnique({ where: { id: args.eventId } })
      )
    : null;
  if (!charge || charge.type === 'refund')
    throw new AppError(404, 'CHARGE_NOT_FOUND', 'Charge not found');
  if (charge.status !== 'succeeded' || !charge.providerRef) {
    throw new AppError(409, 'NOT_REFUNDABLE', 'Only a succeeded charge can be refunded');
  }
  const prior = await withStore(charge.storeId, tx =>
    tx.billingEvent.findMany({
      where: {
        relatedEventId: charge.id,
        type: 'refund',
        status: { in: ['pending', 'succeeded'] },
      },
      select: { amountMinor: true, status: true },
    })
  );
  if (prior.some(p => p.status === 'pending')) {
    throw new AppError(409, 'REFUND_IN_PROGRESS', 'A refund is already pending for this charge');
  }
  const remaining = charge.amountMinor - prior.reduce((s, p) => s + p.amountMinor, 0);
  const amount = args.amountMinor ?? remaining;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) {
    throw new AppError(
      400,
      'INVALID_REFUND_AMOUNT',
      `Refund must be between 1 and ${remaining} piastres`
    );
  }
  const key = `refund:${charge.id}:${prior.length + 1}`;
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
    await withStore(charge.storeId, async tx => {
      await tx.billingEvent.updateMany({
        where: { id: refundId, status: 'pending' },
        data: { providerRef: res.refundId ?? undefined, raw: res.raw as Prisma.InputJsonValue },
      });
      if (res.status !== 'pending') {
        await settleRefundInTx(tx, refundId, res.status === 'succeeded', res.failureReason);
      }
    });
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
      where: { storeId },
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
  const { rows } = await pageAcrossStores<LedgerRow>({
    storeIds: args.storeId ? [args.storeId] : undefined,
    skip: 0,
    take,
    orderKey: r => r.createdAt,
    fetch: async window => {
      const where = {
        ...(args.storeId ? { storeId: args.storeId } : {}),
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
  return rows.map(r => ({
    id: r.id,
    storeId: r.storeId,
    storeName: r.store.name,
    storeSlug: r.store.slug,
    type: r.type,
    planCode: r.planCode,
    billingInterval: r.billingInterval,
    amountMinor: r.amountMinor,
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
    stuck: r.status === 'pending' && r.type !== 'checkout' && r.createdAt.getTime() < stuckBefore,
  }));
}

/** Billing-cycle facts the merchant Billing page needs beyond the entitlements. */
export async function getSubscriptionBillingState(storeId: string) {
  const sub = await loadSub(storeId);
  return {
    billingInterval: sub?.billingInterval ?? 'monthly',
    pendingPlanCode: sub?.pendingPlanCode ?? null,
    nextRetryAt: sub?.nextRetryAt ?? null,
    dunningAttempts: sub?.dunningAttempts ?? 0,
    hasPaymentMethod: !!sub?.providerPaymentMethodRef,
    billedByPlatform: !!sub?.provider,
  };
}
