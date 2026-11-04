import type { JobDef } from '../../jobs/types';

import { sweepStoresDb, withStoreRw, withStoreDb } from '../../jobs/store-db';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';

/**
 * Hourly watcher that surfaces stuck background jobs as P1
 * Telegram alerts. The Inngest dashboard already shows function-level
 * status; this catches the failure modes that Inngest itself can't:
 *
 *   1. A BulkAiJob row stuck in `queued` for >30 min — typical cause:
 *      the job's start failed or its Workflow instance errored.
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
 *
 * PR2 (2026-07) — the bulk-ai-* sweeps are now crash-checkpointed at the
 * batch level (`step.run('batch-N', ...)` per BULK_AI_BATCH_SIZE items —
 * see `../batch-utils.ts`), so a stuck-running job almost always has real
 * completed batches Inngest will skip on replay. Auto-reap now RE-ENQUEUES
 * the original event (same jobId) so the sweep resumes from the first
 * unfinished batch, instead of permanently failing a job that could finish
 * cleanly with a resend. Gated on same-day AI quota (don't re-hammer an
 * exhausted quota) and a per-job max-resume count (`BulkAiJob.autoResumeCount`,
 * capped at MAX_AUTO_RESUMES) so a job that keeps crashing at the same batch
 * can't loop forever — once either guard trips, falls back to the original
 * mark-failed + P1-alert path.
 */

// How many times a single stuck job may be auto-resumed before we give up
// and fall back to marking it failed. Keeps a job that crashes at the same
// batch every time from looping forever.
const MAX_AUTO_RESUMES = 3;

// Maps BulkAiJob.kind -> the Inngest event name its sweep function listens
// on (see apps/api/src/routes/ai.routes.ts for the original `inngest.send`
// call sites this mirrors). Kinds not listed here (none currently) would
// fall through to the mark-failed path since there's nowhere to resend to.
const RESUME_EVENT_BY_KIND: Record<string, string> = {
  translate: 'bulk-ai/translate-requested',
  seo: 'bulk-ai/seo-requested',
  product_faqs: 'bulk-ai/product-faqs-requested',
  category_assign: 'bulk-ai/categorize-requested',
  image_alt: 'bulk-ai/image-alt-requested',
  excerpt: 'bulk-ai/excerpt-requested',
  product_tags: 'bulk-ai/tags-requested',
  faq_aeo: 'bulk-ai/faq-aeo-requested',
  howto_aeo: 'bulk-ai/howto-aeo-requested',
  meta_aeo: 'bulk-ai/meta-aeo-requested',
  recommendations: 'bulk-ai/recommendations-requested',
  llms_txt: 'bulk-ai/llms-txt-requested',
  citation_copy: 'bulk-ai/citation-copy-requested',
  brand_facts: 'bulk-ai/brand-facts-requested',
  description_balance: 'bulk-ai/balance-descriptions.requested',
  description_revert: 'bulk-ai/revert-balance.requested',
};

// NOTE: inferred WITHOUT the `JobDef` contextual type on this
// `const` — annotating that directly here breaks TS's inference of
// `step.run`'s return type for object literals mixing a plain string[] with
// a richer array-of-objects sibling (the annotation widens the contextual
// type fed into `createFunction`'s generics, and Jsonify then collapses the
// string[] to `unknown[]`). Assigning to the annotated export on a separate
// line avoids feeding the annotation back into inference.
const queueDepthWatchFn = inngest.createFunction(
  {
    id: 'queue-depth-watch',
    name: 'Queue-depth watcher (stuck BulkAiJob rows → Telegram)',
    retries: 0, // failing to alert is recoverable; the next tick fires in an hour
    // HOURLY (Ruling INNGEST-BUDGET-1): a 30/60-min stuck threshold watch; an hourly tick sees it at most 1h late.
    triggers: [{ cron: '7 * * * *' }],
  },
  async ({ event }) => {
    const now = Date.now();
    const queuedThreshold = new Date(now - 30 * 60 * 1000); // 30 min ago
    const runningThreshold = new Date(now - 60 * 60 * 1000); // 60 min ago

    // Cross-tenant cron — BulkAiJob is an RLS table. No tenant GUC is set in
    // Inngest workers, so plain prisma reads return 0 rows. Each store is read
    // in its own scope and the per-store partials are merged to the same
    // global 20-row ceilings.
    // Store by store through the store's backend: the cron run visits the Postgres stores, a DO store's alarm run reads that
    // store's own Durable Object (Ruling CF-JOBS-4B). The store's display name is a platform row, attached after the read.
    const queued = await sweepStoresDb(event, {
      fetch: (storeId, db) =>
        db.bulkAiJob.findMany({
          where: { storeId, status: 'queued', createdAt: { lt: queuedThreshold } },
          select: { id: true, storeId: true, kind: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
          take: 20,
        }),
      orderKey: j => j.createdAt,
      take: 20,
    });
    const running = await sweepStoresDb(event, {
      fetch: (storeId, db) =>
        db.bulkAiJob.findMany({
          where: { storeId, status: 'running', startedAt: { lt: runningThreshold } },
          select: {
            id: true,
            storeId: true,
            kind: true,
            processed: true,
            total: true,
            startedAt: true,
            force: true,
            direction: true,
            autoResumeCount: true,
          },
          orderBy: { startedAt: 'asc' },
          take: 20,
        }),
      orderKey: j => j.startedAt?.getTime() ?? 0,
      take: 20,
    });
    const labels = new Map<string, { name: string; slug?: string }>();
    for (const id of new Set([...queued, ...running].map(j => j.storeId))) {
      const st = await withStoreDb(id, db =>
        db.store.findUnique({ where: { id }, select: { name: true, slug: true } })
      );
      labels.set(id, { name: st?.name ?? id, slug: st?.slug ?? undefined });
    }
    const withStoreLabel = <J extends { storeId: string }>(j: J) => ({
      ...j,
      store: labels.get(j.storeId) ?? { name: j.storeId, slug: undefined },
    });
    const stuckQueued = queued.map(withStoreLabel);
    const stuckRunning = running.map(withStoreLabel);

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

    let autoResumed = 0;
    let autoReaped = 0;

    for (const job of stuckRunning) {
      const ageMin = Math.floor((now - (job.startedAt?.getTime() ?? now)) / 60_000);
      const progress = job.total > 0 ? `${job.processed}/${job.total}` : 'unknown';

      const resumeEvent = RESUME_EVENT_BY_KIND[job.kind];
      const guardTripped = job.autoResumeCount >= MAX_AUTO_RESUMES;

      let quotaExhausted = false;
      if (resumeEvent && !guardTripped) {
        try {
          await assertAiQuota({ storeId: job.storeId, bulk: true });
        } catch (err) {
          if (isAiQuotaCapError(err)) quotaExhausted = true;
          else throw err;
        }
      }

      if (resumeEvent && !guardTripped && !quotaExhausted) {
        // Crash-resumable path: the sweep is batch-checkpointed (PR2), so
        // re-sending its original event lets Inngest replay memoized
        // batches and continue from the first unfinished one. Flip the row
        // back to 'queued' immediately so this same tick's stuck-running
        // scan (and the next one) doesn't re-flag it while it's just
        // waiting to be picked up again.
        try {
          await withStoreRw(job.storeId, tx =>
            tx.bulkAiJob.update({
              where: { id: job.id, storeId: job.storeId },
              data: { status: 'queued', autoResumeCount: { increment: 1 } },
            })
          );
          await inngest.send({
            name: resumeEvent,
            data: {
              jobId: job.id,
              storeId: job.storeId,
              force: job.force,
              ...(job.kind === 'translate' ? { direction: job.direction } : {}),
            },
          });
          autoResumed++;
          logger.info(
            {
              jobId: job.id,
              storeId: job.storeId,
              kind: job.kind,
              ageMin,
              progress,
              resumeCount: job.autoResumeCount + 1,
            },
            'queue-depth-watch: auto-resumed stuck-running job'
          );
          await sendAlert({
            level: 'info',
            scope: 'store',
            store: { id: job.storeId, name: job.store?.name ?? job.storeId, slug: job.store?.slug },
            source: 'inngest.queue-depth',
            title: `bulk-ai-job auto-resumed after ${ageMin}m stuck running (${job.kind}, ${progress})`,
            body: `Job ${job.id} for store "${job.store?.name ?? job.storeId}" was running ${ageMin} min at progress ${progress} without updates — re-enqueued (attempt ${job.autoResumeCount + 1}/${MAX_AUTO_RESUMES}). It will resume from the first unfinished batch.`,
            context: {
              jobId: job.id,
              kind: job.kind,
              ageMinutes: ageMin,
              type: 'stuck_running_auto_resumed',
            },
          });
          continue;
        } catch (err) {
          logger.error(
            { jobId: job.id, err: (err as Error).message },
            'queue-depth-watch: auto-resume failed, falling back to mark-failed'
          );
          // fall through to the mark-failed path below
        }
      }

      // Fallback: no resume mapping for this kind, the resume-count guard
      // tripped, quota is exhausted, or the re-enqueue attempt itself
      // failed. Mark failed + alert exactly as before PR2.
      autoReaped++;
      const reason = !resumeEvent
        ? 'no resume mapping for this job kind'
        : guardTripped
          ? `auto-resume cap reached (${MAX_AUTO_RESUMES})`
          : quotaExhausted
            ? 'AI quota exhausted for today'
            : 're-enqueue attempt failed';
      try {
        await withStoreRw(job.storeId, tx =>
          tx.bulkAiJob.update({
            where: { id: job.id, storeId: job.storeId },
            data: {
              status: 'failed',
              errorMessage: `auto-reaped by queue-depth-watch: stuck running ${ageMin}m at progress ${progress} (${reason}). likely cause: worker died mid-execution (deploy window / crash / inngest disconnect). retry from UI.`,
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
        body: `Job ${job.id} for store "${job.store?.name ?? job.storeId}" was running ${ageMin} min at progress ${progress} without updates — auto-marked failed (${reason}). Merchant can retry from the UI; partial progress up to the last completed batch is lost.`,
        context: {
          jobId: job.id,
          kind: job.kind,
          ageMinutes: ageMin,
          type: 'stuck_running_auto_reaped',
          reason,
        },
      });
    }

    logger.warn(
      {
        stuckQueued: stuckQueued.length,
        stuckRunning: stuckRunning.length,
        autoResumed,
        autoReaped,
      },
      'queue-depth-watch: stuck jobs detected, alerts dispatched'
    );

    return {
      ok: true,
      stuckQueued: stuckQueued.length,
      stuckRunning: stuckRunning.length,
      autoResumed,
      autoReaped,
    };
  }
);
export const queueDepthWatch: JobDef = queueDepthWatchFn;
