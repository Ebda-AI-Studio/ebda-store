import type { InngestFunction } from 'inngest';
import { inngest } from '../client';
import {
  expireStaleCheckouts,
  findDueSubscriptionIds,
  renewSubscription,
} from '../../../services/billing/subscription-billing.service';

/**
 * Daily subscription billing cycle (SP5 task 3) — 04:00 UTC (06:00/07:00 Cairo).
 *
 * Covers renewals, dunning retries (day 3 / day 7) and cancel-at-period-end
 * finalisation: `findDueSubscriptionIds` returns whatever needs attention and
 * `renewSubscription` does one subscription. Each subscription is its own
 * `step.run`, so one merchant's failure never blocks the rest and Inngest
 * retries only that step.
 *
 * Safe to re-run at any time (manual backfill, Inngest retry, double
 * delivery): the charge's idempotency key `sub:<id>:<periodEnd ISO>` (retries
 * `…:retry<n>`) is claimed in `billing_events` BEFORE the gateway is called, so
 * a second run finds the key taken and skips. The provider call happens inside
 * the step but outside any DB transaction.
 */
export const billingRenewalDaily: InngestFunction.Any = inngest.createFunction(
  {
    id: 'billing-renewal-daily',
    name: 'Daily subscription renewals + dunning',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 4 * * *' }],
  },
  async ({ step }) => {
    const nowIso = await step.run('resolve-now', async () => new Date().toISOString());
    const expired = await step.run('expire-stale-checkouts', () =>
      expireStaleCheckouts(new Date(nowIso))
    );
    const ids = await step.run('find-due', () => findDueSubscriptionIds(new Date(nowIso)));
    const results: Array<{ id: string; action: string }> = [];
    for (const id of ids) {
      const r = await step.run(`renew-${id}`, async () => {
        const out = await renewSubscription(id, new Date(nowIso));
        return { id, action: out.action };
      });
      results.push(r);
    }
    return { examined: ids.length, expiredCheckouts: expired, results };
  }
);
