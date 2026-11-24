import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import { reconcileAddonOverlaps } from '../../../services/billing/addon-overlap';

/**
 * Daily 04:30 UTC (after the 04:00 billing cycle): find overlapping PAID add-on terms for the same store + feature (the
 * rare stalled-settlement case) and raise a P1 so a super admin can refund the overlap. Whole-run idempotent: each
 * overlap is recorded once in the ledger and alerts once, so a retry or a double delivery re-reports nothing.
 */
export const addonOverlapReconcile: JobDef = inngest.createFunction(
  {
    id: 'addon-overlap-reconcile',
    name: 'Daily add-on overlap reconcile',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '30 4 * * *' }],
  },
  async ({ step }) => step.run('reconcile', () => reconcileAddonOverlaps())
);
