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
import { abandonedCartService } from '../services/abandoned-cart.service';
import { shippingCarrierService } from '../services/shipping-carrier.service';
import { loyaltyAutomationService } from '../services/loyalty-automation.service';
import { AuthService } from '../services/auth.service';
import logger from '../lib/logger';
import { sendAlert } from '../services/alerts.service';
import { cfBindings } from './bindings';
import { doStoreIdList } from '../lib/store-backend';
import { runBackupSweep, type SweepEnv } from './ops/backup-sweep';
import { allJobCronStrings, runScheduledJobs } from '../lib/jobs/schedule';
import { syncStoreSchedules } from '../lib/jobs/store-schedule';
import { isSweepCron, writesFrozen } from '../lib/jobs/freeze';
import type { LegacyCronMessage } from '../lib/jobs/start';

const isJobCron = (cron: string): boolean => allJobCronStrings().includes(cron);

export interface CronJob {
  name: string;
  run: () => Promise<unknown>;
}

export const CRON_SCHEDULE: Record<string, CronJob[]> = {
  // Per-store job alarms (cf/store-schedule.ts): arm every live store's schedule, hourly.
  '0 * * * *': [{ name: 'store-schedule-sync', run: () => syncStoreSchedules() }],
  // Abandoned-cart reminder emails (was every 15 min).
  '*/15 * * * *': [{ name: 'abandoned-cart', run: () => abandonedCartService.process() }],
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
        await job.run();
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
