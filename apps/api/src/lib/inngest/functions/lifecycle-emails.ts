import type { JobDef } from '../../jobs/types';
import {
  LIFECYCLE_DELAY_DAYS,
  TRIAL_RECAP_DAYS_BEFORE_END,
  type LifecycleEmailKind,
} from '@ebda/shared';
import logger from '../../logger';
import { storeActiveForJob } from '../../jobs/store-db';
import { inngest } from '../client';
import { getEnrollment, processLifecycleEmail } from '../../../services/lifecycle-emails.service';

/**
 * Self-serve lifecycle emails (growth strategy 3.4). EVENT-DRIVEN, no cron (Ruling INNGEST-BUDGET-1:
 * the cron budget is full): one run per self-serve store, started by `store/self-serve-provisioned`,
 * that SLEEPS (`step.sleepUntil`, durable across deploys) to each due time, then re-reads the real
 * state in `processLifecycleEmail` and sends only if the step is still undone. Cost per store is about
 * 12 executions once, not a tick a day for every store.
 *
 *   day 1  no product yet           -> add_products
 *   day 3  payment or shipping unset -> payment_shipping
 *   day 5  no order yet              -> test_order
 *   day 7                            -> share_link
 *   trial end - 4 days, still trialing -> trial_recap (the daily billing reminders cover days 3, 1, 0)
 *
 * The first-order referral ask is the second function below (`order/created`).
 * Idempotent per (store, kind) through the `store_lifecycle_emails` row; a retry re-runs a step
 * harmlessly. Concurrency is not limited here: a sleeping run holds no worker, and the hobby plan
 * cap (5) is what `inngest-plan-limits.test.ts` guards.
 */
const DAY = 86_400_000;

const TIMED: Array<{ kind: LifecycleEmailKind & keyof typeof LIFECYCLE_DELAY_DAYS }> = [
  { kind: 'add_products' },
  { kind: 'payment_shipping' },
  { kind: 'test_order' },
  { kind: 'share_link' },
];

/** Reasons that mean "stop the whole sequence for this store". */
const STOP = new Set(['opted_out', 'store_not_active', 'store_missing', 'not_self_serve']);

const lifecycleEmailsFn = inngest.createFunction(
  {
    id: 'lifecycle-emails',
    name: 'Lifecycle emails: setup nudges + trial recap (sleeps between steps)',
    retries: 3,
    triggers: [{ event: 'store/self-serve-provisioned' }],
  },
  async ({ event, step }) => {
    const { storeId } = (event.data ?? {}) as { storeId?: string };
    if (!storeId) {
      logger.warn('[lifecycle-emails] fired without storeId - skipping');
      return { skipped: 'missing-id' };
    }
    const enrollment = await step.run('load-enrollment', () => getEnrollment(storeId));
    if (!enrollment) return { skipped: 'not-self-serve' };
    const created = new Date(enrollment.createdAt).getTime();

    for (const { kind } of TIMED) {
      await step.sleepUntil(`wait-${kind}`, new Date(created + LIFECYCLE_DELAY_DAYS[kind] * DAY));
      if (
        !(await step.run(`check-store-${kind}`, () =>
          storeActiveForJob(storeId, 'lifecycle-emails')
        ))
      )
        return { stoppedAt: kind, reason: 'store_not_active' };
      const r = await step.run(`send-${kind}`, () => processLifecycleEmail(storeId, kind));
      if (r.status === 'skipped' && STOP.has(r.reason))
        return { stoppedAt: kind, reason: r.reason };
      if (r.status === 'ignored') return { stoppedAt: kind, reason: r.reason };
    }

    if (enrollment.trialEndsAt) {
      const due = new Date(
        new Date(enrollment.trialEndsAt).getTime() - TRIAL_RECAP_DAYS_BEFORE_END * DAY
      );
      await step.sleepUntil('wait-trial_recap', due);
      if (
        !(await step.run('check-store-trial_recap', () =>
          storeActiveForJob(storeId, 'lifecycle-emails')
        ))
      )
        return { stoppedAt: 'trial_recap', reason: 'store_not_active' };
      await step.run('send-trial_recap', () => processLifecycleEmail(storeId, 'trial_recap'));
    }
    return { done: true };
  }
);

const firstOrderFn = inngest.createFunction(
  {
    id: 'lifecycle-first-order',
    name: 'Lifecycle emails: first order -> referral ask',
    retries: 3,
    concurrency: { limit: 2 },
    triggers: [{ event: 'order/created' }],
  },
  async ({ event, step }) => {
    const { storeId, orderId } = (event.data ?? {}) as { storeId?: string; orderId?: string };
    if (!storeId || !orderId) return { skipped: 'missing-ids' };
    return step.run('first-order', () =>
      processLifecycleEmail(storeId, 'first_order', { orderId })
    );
  }
);

export const lifecycleEmails: JobDef = lifecycleEmailsFn;
export const lifecycleFirstOrder: JobDef = firstOrderFn;
