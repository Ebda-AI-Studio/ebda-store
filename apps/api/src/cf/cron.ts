/**
 * Cron Triggers: what used to be `setInterval` loops in index.ts (Node only).
 *
 * workerd has no background loop between requests, so each loop is a scheduled event; the
 * schedule strings here MUST match `triggers.crons` in wrangler.jsonc (a test pins that).
 * A cron fire is a single invocation, so the Redis leader locks the loops used are not needed.
 *
 * Not here: the 29 Inngest crons (Inngest calls the Worker over HTTPS, no Cron Trigger), the
 * FBT recalculation (`startFBTCron(..., [])` was started with an EMPTY store list, so it did
 * nothing), the CSRF / view-debounce sweeps (the state is shared and TTL'd), and the
 * email/SMS queue loops (Cloudflare Queues consumers, cf/queues.ts).
 */
import { withReachLabel } from '@ebda/database';
import { alertIfStoreCreateMisconfigured } from '../lib/store-create-config';
import { abandonedCartService } from '../services/abandoned-cart.service';
import { shippingCarrierService } from '../services/shipping-carrier.service';
import { loyaltyAutomationService } from '../services/loyalty-automation.service';
import { AuthService } from '../services/auth.service';
import { processDeferredBillingWebhooks } from '../services/billing/subscription-billing.service';
import { reconcilePayments } from '../services/billing/payments-reconcile.service';
import logger from '../lib/logger';
import { sendAlert } from '../services/alerts.service';
import { cfBindings } from './bindings';
import { doStoreIdList } from '../lib/store-backend';
import { runBackupSweep, type SweepEnv } from './ops/backup-sweep';
import { allJobCronStrings, runScheduledJobs } from '../lib/jobs/schedule';
import { syncStoreSchedules } from '../lib/jobs/store-schedule';
import { runRequestBudgetAlert } from '../lib/request-budget-alert';
import { runEntityIndexHealthCron } from '../lib/entity-index-health';
import { reconcileStoreDirectory } from '../lib/store-directory-reconcile';
import { checkSuperAdminInvariant } from '../lib/super-admin-invariant';
import { ensureHelpIndex, helpDeps } from '../smart-layer/help-index';
import { weeklyUnanswered } from '../smart-layer/weekly-report';
import { isSweepCron, writesFrozen } from '../lib/jobs/freeze';
import type { LegacyCronMessage } from '../lib/jobs/start';

const isJobCron = (cron: string): boolean => allJobCronStrings().includes(cron);

export interface CronJob {
  name: string;
  run: () => Promise<unknown>;
}

export const CRON_SCHEDULE: Record<string, CronJob[]> = {
  // Per-store job alarms (cf/store-schedule.ts): arm every live store's schedule, hourly.
  '0 * * * *': [
    { name: 'store-schedule-sync', run: () => syncStoreSchedules() },
    // Hotfix N-22: repair any Postgres -> D1 store-directory drift, fail-closed (lib/store-directory-reconcile.ts).
    { name: 'store-directory-reconcile', run: () => reconcileStoreDirectory() },
    // Issue 458: StoreDO entity-index dead-letter rows -> one P1 per row per day (the DO cannot call sendAlert).
    { name: 'entity-index-health', run: () => runEntityIndexHealthCron() },
    // FOLD-COUNTERS: p95 / 5xx over budget per route from the ebda_request_budget dataset (needs CF_ANALYTICS_* secrets, else skipped).
    { name: 'request-budget-alert', run: () => runRequestBudgetAlert() },
    // The assistant's help index: re-embed the bundled help corpus when its hash changed (a KV read when nothing changed; never throws into the cron).
    {
      name: 'assistant-help-index',
      run: () =>
        ensureHelpIndex(helpDeps()).catch(err =>
          logger.warn({ err }, '[assistant] help index failed')
        ),
    },
  ],
  // Abandoned-cart reminder emails (was every 15 min).
  '*/15 * * * *': [
    { name: 'abandoned-cart', run: () => abandonedCartService.process() },
    // Billing webhooks stored during a cutover freeze (NEON-ZERO N-10): apply them once the freeze is lifted.
    { name: 'billing-deferred-webhooks', run: () => processDeferredBillingWebhooks() },
    // InstaPay receipts / manual-payment claims left half-done by a dead Worker (N-10d): complete or roll back, P1 if undecidable.
    { name: 'payments-reconcile', run: () => reconcilePayments() },
    // NZ-PG-9: all markers set + no Postgres binding + STORE_CREATE_ON_DO unset = every store creation fails: P1.
    {
      name: 'store-create-config',
      run: async () => void (await alertIfStoreCreateMisconfigured()),
    },
  ],
  // Carrier tracking poll (was every 30 min).
  '*/30 * * * *': [
    { name: 'shipping-tracking', run: () => shippingCarrierService.runTrackingCron() },
  ],
  // Refresh-token cleanup: reuse detection keeps revoked rows ~30 days (was every 12 h).
  '0 */12 * * *': [
    { name: 'refresh-token-cleanup', run: () => AuthService.cleanupRefreshTokens() },
  ],
  // Loyalty: birthday bonuses + point expiry (was every 24 h).
  '0 3 * * *': [
    { name: 'loyalty-daily', run: () => loyaltyAutomationService.runDailyAutomation() },
    // The assistant's weekly digest of questions the help guides could not answer (Monday UTC only, once per ISO week, info level).
    {
      name: 'assistant-weekly-unanswered',
      run: () =>
        weeklyUnanswered().catch(err => logger.warn({ err }, '[assistant] weekly report failed')),
    },
    // Ruling ID-20: P1 when the identity service has no active super_admin, or none that can act (second factor).
    { name: 'super-admin-invariant', run: () => checkSuperAdminInvariant() },
    // G8: arm StoreDO alarms, check yesterday's backups landed, export D1 to R2 (cf/ops/backup-sweep.ts).
    {
      name: 'backup-sweep',
      run: async () => {
        const env = (cfBindings() ?? {}) as unknown as SweepEnv;
        const report = await runBackupSweep(env, {
          listStoreIds: () => doStoreIdList(),
          alert: (title, body) => sendAlert({ level: 'p1', source: 'backup-sweep', title, body }),
        });
        if (!report.ok) throw new Error('backup sweep reported failures (alert sent)');
      },
    },
  ],
};

/** Run every job for a cron expression; one failing job never stops the others. */
export async function runScheduled(
  cron: string,
  scheduledTime: number = Date.now()
): Promise<Array<{ name: string; ok: boolean }>> {
  // Background jobs on Cloudflare (G5): Inngest's crons, started per rollout group.
  const started = await runScheduledJobs(cron, scheduledTime).catch(err => {
    logger.error({ err, cron }, '[cron] job scheduling failed');
    return [];
  });
  const startedResults = started.map(s => ({ name: s.job, ok: s.result !== 'failed' }));
  const jobs = CRON_SCHEDULE[cron];
  if (!jobs) {
    if (started.length === 0 && !isJobCron(cron)) {
      logger.warn({ cron }, '[cron] no jobs registered for this schedule');
    }
    return startedResults;
  }
  const frozen = writesFrozen();
  const legacy = await Promise.all(
    jobs.map(async job => {
      if (frozen) return deferLegacyJob(cron, job.name, scheduledTime);
      try {
        await withReachLabel(job.name, () => job.run());
        logger.info({ cron, job: job.name }, '[cron] job done');
        return { name: job.name, ok: true };
      } catch (err) {
        logger.error({ err, cron, job: job.name }, '[cron] job failed');
        return { name: job.name, ok: false };
      }
    })
  );
  return [...legacy, ...startedResults];
}

/**
 * Write freeze (Ruling CF-JOBS-2) for a legacy cron job. A sweep (fires again within 6 h) is skipped: the next tick after the
 * window does the work. A rarer one (loyalty-daily, backup-sweep) is PARKED on the jobs queue as a `legacy-cron` message, which
 * the consumer runs once the freeze is off. Never dropped: a failed park is reported as a failed job.
 */
async function deferLegacyJob(
  cron: string,
  name: string,
  scheduledTime: number
): Promise<{ name: string; ok: boolean }> {
  if (isSweepCron(cron, scheduledTime)) {
    logger.warn({ cron, job: name }, '[cron] write freeze: sweep tick skipped');
    return { name, ok: true };
  }
  try {
    const q = cfBindings()?.JOBS_QUEUE;
    if (!q) throw new Error('JOBS_QUEUE binding missing');
    const msg: LegacyCronMessage = { kind: 'legacy-cron', name, cron };
    await q.send(msg, { contentType: 'json', delaySeconds: 300 });
    logger.warn({ cron, job: name }, '[cron] write freeze: job parked on the jobs queue');
    return { name, ok: true };
  } catch (err) {
    logger.error({ err, cron, job: name }, '[cron] write freeze: could not park job');
    return { name, ok: false };
  }
}
