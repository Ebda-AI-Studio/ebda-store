import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import {
  expireStaleCheckouts,
  findDueSubscriptionIds,
  renewSubscription,
} from '../../../services/billing/subscription-billing.service';
import {
  findGraceEndingCandidates,
  findReminderCandidates,
  sendDueReminder,
  sendGraceEndingNotice,
} from '../../../services/billing/reminders.service';

/**
 * Daily subscription billing cycle (SP5 task 3 + signup funnel) — 04:00 UTC
 * (06:00/07:00 Cairo).
 *
 * 1. Reminders (7/3/1 days before and on the due day) — one `billing_reminders`
 *    row per (subscription, due date, kind), so a re-run sends nothing twice.
 * 1b. Grace notices (Ruling BILL-NOTICE-1): grace start, 1 day before suspension and suspension are each
 *    claimed once per stage in `billing_reminders` BEFORE the email/bell goes out.
 * 2. Renewals: card subscriptions are charged on the due day (dunning on
 *    failure); InstaPay subscriptions go past_due on the due day and the store is
 *    suspended after the grace period (INSTAPAY_GRACE_DAYS); cancel-at-period-end
 *    is finalised. `findDueSubscriptionIds` returns whatever needs attention and
 *    `renewSubscription` does one subscription. Each subscription is its own
 *    `step.run`, so one merchant's failure never blocks the rest and Inngest
 *    retries only that step.
 *
 * Safe to re-run at any time (manual backfill, Inngest retry, double
 * delivery): the charge's idempotency key `sub:<id>:<periodEnd ISO>` (retries
 * `…:retry<n>`, trial end `…:trial-end:…`) is claimed in `billing_events` BEFORE
 * the gateway is called, so a second run finds the key taken and skips; the
 * no-money transitions (overdue, suspension) are compare-and-set. The provider
 * call happens inside the step but outside any DB transaction.
 */
export const billingRenewalDaily: JobDef = inngest.createFunction(
  {
    id: 'billing-renewal-daily',
    name: 'Daily subscription reminders, renewals + dunning',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 4 * * *' }],
  },
  async ({ step }) => {
    const nowIso = await step.run('resolve-now', async () => new Date().toISOString());
    const expired = await step.run('expire-stale-checkouts', () =>
      expireStaleCheckouts(new Date(nowIso))
    );
    const reminderIds = await step.run('find-reminders', () =>
      findReminderCandidates(new Date(nowIso))
    );
    let reminders = 0;
    for (const id of reminderIds) {
      const r = await step.run(`remind-${id}`, () => sendDueReminder(id, new Date(nowIso)));
      if (r.sent) reminders++;
    }
    // Ruling BILL-NOTICE-1: one day before an unpaid InstaPay store is paused (grace start + suspension
    // notices are claimed inside the renewal step below).
    const graceIds = await step.run('find-grace-ending', () =>
      findGraceEndingCandidates(new Date(nowIso))
    );
    for (const id of graceIds) {
      const r = await step.run(`grace-ending-${id}`, () =>
        sendGraceEndingNotice(id, new Date(nowIso))
      );
      if (r.sent) reminders++;
    }
    const ids = await step.run('find-due', () => findDueSubscriptionIds(new Date(nowIso)));
    const results: Array<{ id: string; action: string }> = [];
    for (const id of ids) {
      const r = await step.run(`renew-${id}`, async () => {
        const out = await renewSubscription(id, new Date(nowIso));
        return { id, action: out.action };
      });
      results.push(r);
    }
    return { examined: ids.length, expiredCheckouts: expired, reminders, results };
  }
);
