/**
 * Payment reminders (Ruling EBDA-FUNNEL-12): 7, 3 and 1 days before a trial or
 * period ends, and on the due day — email + the bell; the in-admin banner is
 * derived from the billing state (`dueSoon`), and WhatsApp is a wa.me link only.
 *
 * Idempotent: a reminder is sent only by WINNING the insert of its
 * `billing_reminders` row (UNIQUE subscription + due date + kind), so a second
 * run the same day sends nothing. Only the most specific due offset is sent: a
 * job that missed days does not replay the older reminders.
 */
import { prisma, withStore, type Prisma } from '@ebda/database';
import { acrossBilling, d1All, d1Run, onD1 } from '../platform/billing-d1';
import { config } from '../../config';
import { getEntityStoreId } from '../../lib/definer';
import logger from '../../lib/logger';
import { isStoreGoneError } from '../../lib/jobs/store-gone';
import { EmailService } from '../email.service';
import { socketService } from '../socket.service';
import {
  FREE_PLAN_CODE,
  GRANTED_PLAN_CODES,
  INSTAPAY_GRACE_DAYS,
  REMINDER_OFFSETS,
  addDays,
  isInterval,
  priceFor,
} from './period';
import { instapayHandle, supportContact } from './manual-config';
import { chargeFor, ledgerVat } from './charge-amount';
import { isBillableStoreId } from './account.service';
import { deliverBillingEffect, type BillingEffect } from './billing-notify';

const DAY = 86_400_000;
export type ReminderKind = 'd7' | 'd3' | 'd1' | 'd0';

/** The due date a reminder counts down to (trial end, period end), or null. */
export function reminderDueAt(sub: {
  status: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}): Date | null {
  if (sub.status === 'trialing') return sub.trialEndsAt ?? sub.currentPeriodEnd;
  if (sub.status === 'active' || sub.status === 'past_due') return sub.currentPeriodEnd;
  return null;
}

/**
 * Which reminder is due at `now` for a due date, or null: the SMALLEST offset N
 * with now >= due - N days, and only until the end of the due day.
 */
export function reminderKindAt(dueAt: Date, now: Date): ReminderKind | null {
  const until = dueAt.getTime() - now.getTime();
  if (until <= -DAY) return null; // past the due day: the overdue path takes over
  for (const n of [...REMINDER_OFFSETS].sort((a, b) => a - b)) {
    if (until <= n * DAY) return `d${n}` as ReminderKind;
  }
  return null;
}

/** Subscription ids matching `where`, per store scope (the ONE prisma site of this file's scans). */
async function scanSubscriptionIds(
  where: Prisma.StoreSubscriptionWhereInput,
  what: string
): Promise<string[]> {
  const parts = await acrossBilling(
    storeId =>
      prisma.storeSubscription.findMany({
        where: { ...(storeId ? { storeId } : {}), ...where },
        select: { id: true },
      }),
    {
      onStoreError: (storeId, err) =>
        logger.error({ err, storeId }, `[billing] ${what} scan failed`),
    }
  );
  return parts.flatMap(p => p.value.map(r => r.id));
}

/** Subscriptions with a reminder window open at `now` (one row per store). */
export async function findReminderCandidates(now: Date): Promise<string[]> {
  const horizon = new Date(now.getTime() + 7 * DAY);
  const floor = new Date(now.getTime() - DAY);
  return scanSubscriptionIds(
    {
      planCode: { notIn: [...GRANTED_PLAN_CODES, FREE_PLAN_CODE] },
      cancelAtPeriodEnd: false,
      OR: [
        { status: 'trialing', trialEndsAt: { gt: floor, lte: horizon } },
        { status: { in: ['active', 'past_due'] }, currentPeriodEnd: { gt: floor, lte: horizon } },
      ],
    },
    'reminder'
  );
}

export type ReminderResult = { sent: false; reason: string } | { sent: true; kind: ReminderKind };

/** One reminder. A closed / removed store is skipped with a log, never thrown (it would fail the whole daily run). */
export async function sendDueReminder(
  subscriptionId: string,
  now: Date = new Date()
): Promise<ReminderResult> {
  try {
    return await sendDueReminderInner(subscriptionId, now);
  } catch (err) {
    if (!isStoreGoneError(err)) throw err;
    logger.warn(
      { subscriptionId, code: (err as { code?: string }).code },
      '[billing] store gone; reminder skipped'
    );
    return { sent: false, reason: 'store_gone' };
  }
}

async function sendDueReminderInner(subscriptionId: string, now: Date): Promise<ReminderResult> {
  const storeId = await getEntityStoreId('store_subscription', subscriptionId);
  if (!storeId) return { sent: false, reason: 'not_found' };
  // A child store is included in its parent's plan: it is never asked to pay (EBDA-FUNNEL-18).
  if (!(await isBillableStoreId(storeId))) return { sent: false, reason: 'child_store' };
  const claimed = await withStore(storeId, async tx => {
    const sub = await tx.storeSubscription.findUnique({
      where: { id: subscriptionId, storeId },
    });
    if (!sub || sub.cancelAtPeriodEnd) return null;
    const dueAt = reminderDueAt(sub);
    const kind = dueAt ? reminderKindAt(dueAt, now) : null;
    if (!dueAt || !kind) return null;
    const { count } = await tx.billingReminder.createMany({
      data: [{ storeId, subscriptionId, dueAt, kind }],
      skipDuplicates: true,
    });
    if (count === 0) return { dup: true as const };
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true, owner: { select: { email: true } } },
    });
    const planCode = sub.pendingPlanCode ?? sub.planCode;
    const plan = await tx.plan.findUnique({ where: { code: planCode } });
    const interval = isInterval(sub.billingInterval) ? sub.billingInterval : 'monthly';
    return { dup: false as const, sub, store, plan, dueAt, kind, interval };
  });
  if (!claimed) return { sent: false, reason: 'no_window' };
  if (claimed.dup) return { sent: false, reason: 'already_sent' };

  const { sub, store, plan, dueAt, kind, interval } = claimed;
  const lang: 'ar' | 'en' =
    (store?.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'en'
      ? 'en'
      : 'ar';
  const daysLeft = Math.max(0, Math.ceil((dueAt.getTime() - now.getTime()) / DAY));
  const dueOn = dueAt.toISOString().slice(0, 10);
  const method: 'card' | 'instapay' = sub.billingMethod === 'instapay' ? 'instapay' : 'card';
  const url = `/stores/${storeId}/billing`;
  socketService.notifyStore(storeId, {
    type: 'billing_payment_due',
    title: lang === 'ar' ? 'تذكير بموعد الدفع' : 'Payment reminder',
    message: lang === 'ar' ? `موعد الدفع ${dueOn}.` : `Your payment is due on ${dueOn}.`,
    data: { storeId, url, dueOn, kind },
    createdAt: new Date(),
  });
  if (store?.owner?.email) {
    const charge = await chargeFor((plan && priceFor(plan, interval)) || 0);
    const support = supportContact(store.name);
    await EmailService.sendSubscriptionBillingNotice(
      storeId,
      {
        kind: 'payment_due',
        to: store.owner.email,
        storeName: store.name,
        planName: plan ? (lang === 'ar' ? plan.nameAr : plan.nameEn) : '',
        amountMinor: charge.totalMinor,
        vat: ledgerVat(charge).vat,
        billingUrl: `${config.adminUrl ?? ''}${url}`,
        dueOn,
        daysLeft,
        method,
        cardLast4: sub.paymentMethodLast4,
        instapayHandle: method === 'instapay' ? instapayHandle() : null,
        paymentReference: sub.paymentReference,
        whatsappUrl: support.whatsappUrl,
        supportEmail: support.email,
      },
      lang
    ).catch(err => logger.warn({ err, storeId }, '[billing] reminder email failed'));
  }
  return { sent: true, kind };
}

/**
 * Grace-period notice stages (Ruling BILL-NOTICE-1). Same `billing_reminders` table and unique key as the
 * payment reminders, with three more kinds: `grace_start` (InstaPay payment went overdue), `grace_d1`
 * (one day or less before the store is paused) and `suspended`. A stage is owned by WHOEVER WINS this insert,
 * and it is won BEFORE anything is sent (inside the transaction that takes the decision where there is one),
 * so a retry, a re-run or a second worker sends nothing twice. `dueAt` is the period end the grace counts from.
 */
export type GraceStage = 'grace_start' | 'grace_d1' | 'suspended';

export async function claimGraceStage(
  tx: Pick<typeof prisma, 'billingReminder'>,
  args: { storeId: string; subscriptionId: string; dueAt: Date; kind: GraceStage }
): Promise<boolean> {
  const { count } = await tx.billingReminder.createMany({
    data: [args],
    skipDuplicates: true,
  });
  return count === 1;
}

type StageKey = { storeId: string; subscriptionId: string; dueAt: Date; kind: GraceStage };
type OutboxRow = StageKey & { id: string; createdAt: Date };

/*
 * `billing_reminders.notice_sent_at` is a D1-only column (platform migration 0011): it is not in the Prisma model, so the outbox
 * state is read and written with raw D1 SQL (billing-d1.ts). Off D1 (no such column) the outbox is a no-op and a stage is
 * as before: claimed, sent once.
 */
const stampSql = `UPDATE billing_reminders SET notice_sent_at = ?1
  WHERE store_id = ?2 AND subscription_id = ?3 AND due_at = ?4 AND kind = ?5 AND notice_sent_at IS NULL`;
const stampSent = async (r: StageKey, at = new Date()) =>
  (await onD1()) &&
  (await d1Run(stampSql, at.getTime(), r.storeId, r.subscriptionId, r.dueAt.getTime(), r.kind)) > 0;

/**
 * Ruling BILL-NOTICE-3 (outbox): the claim row IS the outbox entry (`notice_sent_at` NULL). Send the stage's notice, and only a
 * confirmed delivery stamps `notice_sent_at`; a run killed (or an effect that failed) between the claim and the send leaves it
 * NULL for `resendUnsentGraceNotices` to finish. At-least-once by design, deduplicated by the stamp. (No provider-side
 * idempotency key: `EmailService` and the bell take none.)
 */
export async function deliverGraceStage(stage: StageKey, effect: BillingEffect): Promise<boolean> {
  if (!(await deliverBillingEffect(effect))) return false;
  await stampSent(stage);
  return true;
}

/** A claimed-but-unsent stage is re-sent only after this long (the first run is still in its send), and not forever. */
export const RESEND_AFTER_MS = 5 * 60_000;
export const RESEND_GIVE_UP_MS = 2 * DAY;
const GRACE_STAGES = ['grace_start', 'grace_d1', 'suspended'] as const;

/**
 * Re-send every grace stage claimed but not confirmed sent (see `deliverGraceStage`). A lease (bumping `created_at` from the
 * value read, so one worker wins) keeps two workers from re-sending the same row. A stage whose moment has passed (the store
 * paid, so the subscription is no longer past_due) is stamped without sending. Returns how many notices went out.
 */
export async function resendUnsentGraceNotices(now: Date = new Date()): Promise<number> {
  if (!(await onD1())) return 0;
  const found = await d1All<{
    id: string;
    store_id: string;
    subscription_id: string;
    due_at: number;
    kind: GraceStage;
    created_at: number;
  }>(
    `SELECT id, store_id, subscription_id, due_at, kind, created_at FROM billing_reminders
     WHERE kind IN (${GRACE_STAGES.map(() => '?').join(', ')}) AND notice_sent_at IS NULL AND created_at BETWEEN ? AND ?
     ORDER BY created_at LIMIT 200`,
    ...GRACE_STAGES,
    now.getTime() - RESEND_GIVE_UP_MS,
    now.getTime() - RESEND_AFTER_MS
  );
  let sent = 0;
  for (const f of found) {
    const row: OutboxRow = {
      id: f.id,
      storeId: f.store_id,
      subscriptionId: f.subscription_id,
      dueAt: new Date(f.due_at),
      kind: f.kind,
      createdAt: new Date(f.created_at),
    };
    try {
      const leased = await d1Run(
        `UPDATE billing_reminders SET created_at = ?1 WHERE id = ?2 AND notice_sent_at IS NULL AND created_at = ?3`,
        now.getTime(),
        row.id,
        f.created_at
      );
      if (leased !== 1) continue;
      const sub = await withStore(row.storeId, tx =>
        tx.storeSubscription.findUnique({
          where: { id: row.subscriptionId, storeId: row.storeId },
        })
      );
      if (!sub || sub.status !== 'past_due') {
        await stampSent(row, now);
        continue;
      }
      const suspendAt = sub.nextRetryAt ?? addDays(row.dueAt, INSTAPAY_GRACE_DAYS);
      const effect: BillingEffect =
        row.kind === 'grace_start'
          ? { kind: 'grace_started', storeId: row.storeId, suspendAt }
          : row.kind === 'grace_d1'
            ? { kind: 'grace_ending', storeId: row.storeId, suspendAt }
            : { kind: 'store_suspended', storeId: row.storeId, applied: true };
      if (await deliverGraceStage(row, effect)) sent++;
    } catch (err) {
      if (!isStoreGoneError(err))
        logger.error({ err, reminderId: row.id }, '[billing] grace resend failed');
    }
  }
  return sent;
}

/** InstaPay subscriptions in grace whose suspension is within the next day. */
export async function findGraceEndingCandidates(now: Date): Promise<string[]> {
  return scanSubscriptionIds(
    {
      status: 'past_due',
      billingMethod: 'instapay',
      nextRetryAt: { gt: now, lte: new Date(now.getTime() + DAY) },
    },
    'grace-ending'
  );
}

/** The one-day-left notice for one subscription: claim `grace_d1`, then email + bell. */
export async function sendGraceEndingNotice(
  subscriptionId: string,
  now: Date = new Date()
): Promise<ReminderResult | { sent: false; reason: string }> {
  try {
    const storeId = await getEntityStoreId('store_subscription', subscriptionId);
    if (!storeId) return { sent: false, reason: 'not_found' };
    const claimed = await withStore(storeId, async tx => {
      const sub = await tx.storeSubscription.findUnique({ where: { id: subscriptionId, storeId } });
      if (
        !sub ||
        sub.status !== 'past_due' ||
        sub.billingMethod !== 'instapay' ||
        !sub.nextRetryAt ||
        !sub.currentPeriodEnd ||
        sub.nextRetryAt.getTime() <= now.getTime() ||
        sub.nextRetryAt.getTime() - now.getTime() > DAY
      ) {
        return null;
      }
      const won = await claimGraceStage(tx, {
        storeId,
        subscriptionId,
        dueAt: sub.currentPeriodEnd,
        kind: 'grace_d1',
      });
      return { won, suspendAt: sub.nextRetryAt, dueAt: sub.currentPeriodEnd };
    });
    if (!claimed) return { sent: false, reason: 'no_window' };
    if (!claimed.won) return { sent: false, reason: 'already_sent' };
    await deliverGraceStage(
      { storeId, subscriptionId, dueAt: claimed.dueAt, kind: 'grace_d1' },
      { kind: 'grace_ending', storeId, suspendAt: claimed.suspendAt }
    );
    return { sent: true, kind: 'd1' };
  } catch (err) {
    if (!isStoreGoneError(err)) throw err;
    return { sent: false, reason: 'store_gone' };
  }
}
