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
import { runBackupSweep, flaggedStoreIds, type SweepEnv } from './ops/backup-sweep';

export interface CronJob {
  name: string;
  run: () => Promise<unknown>;
}

export const CRON_SCHEDULE: Record<string, CronJob[]> = {
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
          listStoreIds: () => flaggedStoreIds(process.env.STORE_DO_ENABLED_IDS),
          alert: (title, body) => sendAlert({ level: 'p1', source: 'backup-sweep', title, body }),
        });
        if (!report.ok) throw new Error('backup sweep reported failures (alert sent)');
      },
    },
  ],
};

/** Run every job for a cron expression; one failing job never stops the others. */
export async function runScheduled(cron: string): Promise<Array<{ name: string; ok: boolean }>> {
  const jobs = CRON_SCHEDULE[cron];
  if (!jobs) {
    logger.warn({ cron }, '[cron] no jobs registered for this schedule');
    return [];
  }
  return Promise.all(
    jobs.map(async job => {
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
}
