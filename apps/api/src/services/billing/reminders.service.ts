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
import { prisma, withStore } from '@ebda/database';
import { acrossBilling } from '../platform/billing-d1';
import { config } from '../../config';
import { getEntityStoreId } from '../../lib/definer';
import logger from '../../lib/logger';
import { isStoreGoneError } from '../../lib/jobs/store-gone';
import { EmailService } from '../email.service';
import { socketService } from '../socket.service';
import {
  FREE_PLAN_CODE,
  GRANTED_PLAN_CODES,
  REMINDER_OFFSETS,
  isInterval,
  priceFor,
} from './period';
import { instapayHandle, supportContact } from './manual-config';
import { chargeFor, ledgerVat } from './charge-amount';
import { isBillableStoreId } from './account.service';

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

/** Subscriptions with a reminder window open at `now` (one row per store). */
export async function findReminderCandidates(now: Date): Promise<string[]> {
  const horizon = new Date(now.getTime() + 7 * DAY);
  const floor = new Date(now.getTime() - DAY);
  const parts = await acrossBilling(
    storeId =>
      prisma.storeSubscription.findMany({
        where: {
          ...(storeId ? { storeId } : {}),
          planCode: { notIn: [...GRANTED_PLAN_CODES, FREE_PLAN_CODE] },
          cancelAtPeriodEnd: false,
          OR: [
            { status: 'trialing', trialEndsAt: { gt: floor, lte: horizon } },
            {
              status: { in: ['active', 'past_due'] },
              currentPeriodEnd: { gt: floor, lte: horizon },
            },
          ],
        },
        select: { id: true },
      }),
    {
      onStoreError: (storeId, err) =>
        logger.error({ err, storeId }, '[billing] reminder scan failed'),
    }
  );
  return parts.flatMap(p => p.value.map(r => r.id));
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
