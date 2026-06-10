import type { InngestFunction } from 'inngest';
import { withRlsBypass } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';

/**
 * Every-15-min watcher that surfaces stuck background jobs as P1
 * Telegram alerts. The Inngest dashboard already shows function-level
 * status; this catches the failure modes that Inngest itself can't:
 *
 *   1. A BulkAiJob row stuck in `queued` for >30 min — typical cause:
 *      Inngest function wasn't registered after a deploy (the
 *      INNGEST_DEPLOY_ID trap documented in
 *      `feedback-inngest-deploy-sync-trap.md`).
 *
 *   2. A BulkAiJob row stuck in `running` for >60 min — typical cause:
 *      the worker crashed mid-run without writing status=failed.
 *
 * Adjacent alerts to keep in mind (already covered, NOT duplicated here):
 *   - `alerts-failure-watch` listens on `inngest/function.failed` →
 *     dead-letter alerts when a function exhausts retries.
 *   - Sentry catches actual exceptions inside running functions.
 *
 * Throttle is handled by sendAlert's Redis-keyed dedup
 * (sha1(level+title+source), 5-min TTL) so consecutive cron ticks
 * for the same stuck job collapse to one Telegram message.
 */
export const queueDepthWatch: InngestFunction.Any = inngest.createFunction(
  {
    id: 'queue-depth-watch',
    name: 'Queue-depth watcher (stuck BulkAiJob rows → Telegram)',
    retries: 0, // failing to alert is recoverable; the next tick fires in 15 min
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async () => {
    const now = Date.now();
    const queuedThreshold = new Date(now - 30 * 60 * 1000); // 30 min ago
    const runningThreshold = new Date(now - 60 * 60 * 1000); // 60 min ago

    // Cross-tenant cron — BulkAiJob is an RLS table. No tenant GUC is set in
    // Inngest workers, so plain prisma reads return 0 rows. Use withRlsBypass
    // to see all stores' jobs for the health check.
    const [stuckQueued, stuckRunning] = await withRlsBypass(tx =>
      Promise.all([
        tx.bulkAiJob.findMany({
          where: { status: 'queued', createdAt: { lt: queuedThreshold } },
          select: {
            id: true,
            storeId: true,
            kind: true,
            createdAt: true,
            store: { select: { name: true, slug: true } },
          },
          take: 20,
        }),
        tx.bulkAiJob.findMany({
          where: { status: 'running', startedAt: { lt: runningThreshold } },
          select: {
            id: true,
            storeId: true,
            kind: true,
            processed: true,
            total: true,
            startedAt: true,
            store: { select: { name: true, slug: true } },
          },
          take: 20,
        }),
      ])
    );

    const stuckCount = stuckQueued.length + stuckRunning.length;

    if (stuckCount === 0) {
      // Healthy state — log a quiet line for trend visibility, no alert.
      return { ok: true, stuckQueued: 0, stuckRunning: 0 };
    }

    for (const job of stuckQueued) {
      const ageMin = Math.floor((now - job.createdAt.getTime()) / 60_000);
      await sendAlert({
        level: 'p1',
        scope: 'store',
        store: { id: job.storeId, name: job.store?.name ?? job.storeId, slug: job.store?.slug },
        source: 'inngest.queue-depth',
        title: `bulk-ai-job stuck in queued (${job.kind}) — ${ageMin}m old`,
        body: `Job ${job.id} for store "${job.store?.name ?? job.storeId}" has been queued for ${ageMin} minutes. Most likely cause: Inngest function not registered after a deploy. Check the Inngest dashboard and re-PUT /api/v1/inngest if needed.`,
        context: { jobId: job.id, kind: job.kind, ageMinutes: ageMin, type: 'stuck_queued' },
      });
    }

    for (const job of stuckRunning) {
      const ageMin = Math.floor((now - (job.startedAt?.getTime() ?? now)) / 60_000);
      const progress = job.total > 0 ? `${job.processed}/${job.total}` : 'unknown';
      // Auto-reap: a stuck-running row > 60min almost always means the
      // worker died mid-execution (Railway redeploy window, Inngest
      // disconnect, an exception that escaped the try/catch).
      // Marking failed here clears the dashboard confusion + lets the
      // merchant retry from the UI without needing manual SQL.
      try {
        // Auto-reap write also needs bypass — same reason as the reads above.
        await withRlsBypass(tx =>
          tx.bulkAiJob.update({
            where: { id: job.id },
            data: {
              status: 'failed',
              errorMessage: `auto-reaped by queue-depth-watch: stuck running ${ageMin}m at progress ${progress}. likely cause: worker died mid-execution (deploy window / crash / inngest disconnect). retry from UI.`,
              completedAt: new Date(),
            },
          })
        );
      } catch (err) {
        logger.error(
          { jobId: job.id, err: (err as Error).message },
          'queue-depth-watch: auto-reap failed'
        );
      }
      await sendAlert({
        level: 'p1',
        scope: 'store',
        store: { id: job.storeId, name: job.store?.name ?? job.storeId, slug: job.store?.slug },
        source: 'inngest.queue-depth',
        title: `bulk-ai-job auto-reaped after ${ageMin}m stuck running (${job.kind}, ${progress})`,
        body: `Job ${job.id} for store "${job.store?.name ?? job.storeId}" was running ${ageMin} min at progress ${progress} without updates — auto-marked failed. Common cause: a Railway redeploy window killed the Inngest invocation. Merchant can retry from the UI; partial progress is lost.`,
        context: {
          jobId: job.id,
          kind: job.kind,
          ageMinutes: ageMin,
          type: 'stuck_running_auto_reaped',
        },
      });
    }

    logger.warn(
      { stuckQueued: stuckQueued.length, stuckRunning: stuckRunning.length },
      'queue-depth-watch: stuck jobs detected, alerts dispatched'
    );

    return { ok: true, stuckQueued: stuckQueued.length, stuckRunning: stuckRunning.length };
  }
);
