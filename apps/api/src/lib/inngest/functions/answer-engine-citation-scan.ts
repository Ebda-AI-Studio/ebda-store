/**
 * Answer-Engine Citation Scan — Task 6 (AEO/GEO insights feature)
 *
 * Two Inngest functions:
 *
 *   answerEngineCitationScanCron — weekly cron (Monday 02:00 UTC) that scans
 *                                  every AI-eligible store with the
 *                                  `answer_engine_insights` feature enabled.
 *
 *   answerEngineScanOnDemand     — event-driven, triggered by
 *                                  `answer-engine/scan-requested` (e.g. an
 *                                  admin "Scan now" button, or — as here —
 *                                  the integration test driving the scan
 *                                  without waiting for the real cron).
 *
 * Both delegate to `runCitationScan()` from citation-scan.service.ts. Each
 * per-store step is wrapped in `step.run()` so Inngest retries only the
 * failing store without re-running healthy ones (mirrors
 * analytics-daily-rollup.ts / stock-reorder-scan.ts).
 *
 * Concurrency: limit 1 on the cron so overlapping deploys don't double-run.
 */
import type { InngestFunction } from 'inngest';
import { withRlsBypass, runInTenantContext } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { chunk, BULK_AI_BATCH_SIZE } from '../batch-utils';
import { aiEligiblePlanFilter, isAiEligiblePlan } from '../../ai-plan-eligibility';
import { featureService } from '../../../services/feature.service';
import { sendAlert } from '../../../services/alerts.service';
import { resetGeminiGroundingWarnOnce } from '../../../services/answer-engine/gemini.provider';
import {
  runCitationScan,
  type RunCitationScanOptions,
} from '../../../services/answer-engine/citation-scan.service';

// ---------------------------------------------------------------------------
// Per-store scan body — isolated so ONE store can never abort the cron
// ---------------------------------------------------------------------------

export interface ScanStoreResult {
  storeId: string;
  /** `false` = scanned; `true` = feature-gate skip; `'error'` = the pre-loop
   * feature check or the scan itself threw and was isolated (see below). */
  skipped: boolean | 'error';
  checks: number;
  /** Checks written from an ungrounded fallback — see issue 2119. */
  ungroundedChecks: number;
}

/**
 * The exact body `step.run(\`scan-${storeId}\`, ...)` wraps for both the
 * weekly cron loop and (indirectly, one store at a time) the on-demand
 * handler's own scan step.
 *
 * PER-STORE ISOLATION (whole-branch fix wave, 2026-07-22): the pre-loop
 * `featureService.isFeatureEnabled` read, `runInTenantContext`, and
 * `runCitationScan`'s OWN pre-loop reads (`getEnabledProviders`,
 * `generatePrompts`, its internal `store.findUnique`) all sit OUTSIDE
 * `runCitationScan`'s per-engine try/catch — a throw from any of them used
 * to propagate straight out of the `step.run` callback. Inngest exhausts
 * that step's retries and fails the WHOLE cron run, so a for-loop over many
 * stores never reaches the stores after the failing one. Wrapping the whole
 * body here converts any such throw into a `{ skipped: 'error' }` marker so
 * the cron's `for` loop simply continues to the next store.
 *
 * This is deliberately scoped to ONE store's failure, not a blanket
 * catch-all: a systemic outage (e.g. the DB is down) still throws for EVERY
 * store in turn, so it isn't hidden — it just surfaces as a large
 * `erroredStores` count in the cron's completion log instead of a single
 * hard function failure, and each occurrence is logged with the storeId +
 * error for follow-up.
 */
export async function scanStoreCitations(
  storeId: string,
  opts: RunCitationScanOptions = {}
): Promise<ScanStoreResult> {
  // The Gemini adapter warns once when grounding is unavailable; scope that
  // throttle to this store's scan rather than the whole (long-lived) process,
  // so a recurrence in a later week is logged again (issue 2119).
  resetGeminiGroundingWarnOnce();
  try {
    const enabled = await featureService.isFeatureEnabled(storeId, 'answer_engine_insights');
    if (!enabled) {
      logger.info(
        { storeId },
        'answer-engine-citation-scan: answer_engine_insights disabled, skipping'
      );
      return { storeId, skipped: true, checks: 0, ungroundedChecks: 0 };
    }

    // runCitationScan uses bare prisma internally. Wrap in
    // runInTenantContext so FORCE RLS policies see the correct store GUC
    // for the AnswerEngineCheck writes.
    const engineResults = await runInTenantContext(storeId, () => runCitationScan(storeId, opts));
    const checks = engineResults.reduce((sum, r) => sum + r.checks, 0);
    const ungroundedChecks = engineResults.reduce((sum, r) => sum + (r.ungrounded ?? 0), 0);
    return { storeId, skipped: false, checks, ungroundedChecks };
  } catch (err) {
    logger.error(
      { storeId, err: err instanceof Error ? err.message : String(err) },
      'answer-engine-citation-scan: per-store scan threw, isolating this store and continuing the cron'
    );
    return { storeId, skipped: 'error', checks: 0, ungroundedChecks: 0 };
  }
}

// ---------------------------------------------------------------------------
// Weekly cron — Monday 02:00 UTC
// ---------------------------------------------------------------------------

// NOTE: inferred WITHOUT the `InngestFunction.Any` contextual type on this
// `const` — annotating directly here breaks TS's inference of `step.run`'s
// return type once its result is threaded through `chunk()` (a generic
// helper). Same trap documented in bulk-ai-translate.ts; the fix is
// identical — assign to the annotated export on a separate statement below.
const answerEngineCitationScanCronFn = inngest.createFunction(
  {
    id: 'answer-engine-citation-scan-cron',
    name: 'Answer-engine citation scan — weekly cron (AI)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 2 * * 1' }], // Monday 02:00 UTC
  },
  async ({ step }) => {
    // INNGEST_DEPLOY_ID re-sync trap: this is a BRAND-NEW cron. Inngest only
    // re-syncs the function manifest (which crons/events it knows about)
    // when it detects a deploy-version change — see client.ts's
    // INNGEST_DEPLOY_ID mapping comment. Until the next Railway deploy bumps
    // that id, this cron trigger is invisible to Inngest's scheduler even
    // though it's registered in code (the event-triggered
    // `answerEngineScanOnDemand` twin works immediately since events don't
    // depend on the cron manifest sync). No action needed beyond a normal
    // deploy — called out here so a future "why isn't the weekly scan
    // running" investigation finds this fast.

    // Cross-tenant cron — list stores with withRlsBypass so FORCE RLS on the
    // stores table does not filter to 0 rows (no tenant GUC is set yet).
    const stores = await step.run('list-stores', () =>
      withRlsBypass(tx =>
        tx.store.findMany({
          where: {
            deletedAt: null,
            status: 'active',
            aiFeaturesEnabled: true,
            // free (lapsed-payment / demo) plans are excluded from AI spend.
            ...aiEligiblePlanFilter,
          },
          select: { id: true },
        })
      )
    );

    // Memoized, so a retried per-store step below sees the SAME instant and
    // resumes past the rows its crashed attempt already wrote (#910).
    const runStartedAt = new Date(await step.run('run-started-at', () => new Date().toISOString()));

    const batches = chunk(stores, BULK_AI_BATCH_SIZE);

    let scannedStores = 0;
    let skippedStores = 0;
    let erroredStores = 0;
    let totalChecks = 0;
    let ungroundedChecks = 0;
    let ungroundedStores = 0;

    for (const batch of batches) {
      for (const store of batch) {
        // NOTE: all branches return the SAME flat shape (`{ storeId, skipped,
        // checks }`). Returning a plain `[]` array on one branch alongside a
        // richer `CitationScanEngineResult[]` on another is the exact
        // step.run return-type collision documented in bulk-ai-translate.ts
        // (Jsonify collapses the union to `unknown[]`) — this shape
        // sidesteps it entirely. `scanStoreCitations` also isolates a
        // per-store throw (feature-check outage, or any of runCitationScan's
        // own pre-loop reads) into a `skipped: 'error'` marker so one bad
        // store can never abort this loop for the rest — see its docstring.
        const result = await step.run(`scan-${store.id}`, () =>
          scanStoreCitations(store.id, { runStartedAt })
        );

        if (result.skipped === 'error') {
          erroredStores += 1;
          continue;
        }
        if (result.skipped) {
          skippedStores += 1;
          continue;
        }
        scannedStores += 1;
        totalChecks += result.checks;
        ungroundedChecks += result.ungroundedChecks;
        if (result.ungroundedChecks > 0) ungroundedStores += 1;
      }
    }

    logger.info(
      {
        stores: stores.length,
        scannedStores,
        skippedStores,
        erroredStores,
        totalChecks,
        ungroundedChecks,
      },
      'answer-engine-citation-scan-cron completed'
    );

    // Issue 2119: a scan whose checks fell back to UNGROUNDED answers still
    // counts as a healthy run above, and the adapter only logs. Name the
    // degradation where an operator will see it: a retired or rationed
    // grounding model needs a new ANSWER_ENGINE_GEMINI_MODEL (RULINGS GEM-2).
    if (ungroundedChecks > 0) {
      await step.run('alert-grounding-unavailable', () =>
        sendAlert({
          level: 'p1',
          source: 'cron.answer-engine-citation-scan',
          title: 'Answer-engine search grounding unavailable',
          body:
            `${ungroundedChecks} of ${totalChecks} citation checks across ${ungroundedStores} ` +
            'store(s) fell back to ungrounded answers this run. Re-probe the Gemini model ' +
            '(ANSWER_ENGINE_GEMINI_MODEL, RULINGS GEM-2) — merchants see "grounding unavailable".',
          context: { ungroundedChecks, totalChecks, ungroundedStores },
        })
      );
    }

    return {
      stores: stores.length,
      scannedStores,
      skippedStores,
      erroredStores,
      totalChecks,
      ungroundedChecks,
    };
  }
);

export const answerEngineCitationScanCron: InngestFunction.Any = answerEngineCitationScanCronFn;

// ---------------------------------------------------------------------------
// On-demand — triggered by `answer-engine/scan-requested` event
// ---------------------------------------------------------------------------

export const answerEngineScanOnDemand: InngestFunction.Any = inngest.createFunction(
  {
    id: 'answer-engine-scan-on-demand',
    name: 'Answer-engine citation scan — on-demand (AI)',
    retries: 1,
    triggers: [{ event: 'answer-engine/scan-requested' }],
  },
  async ({ event, step }) => {
    const { storeId } = event.data;

    const enabled = await featureService.isFeatureEnabled(storeId, 'answer_engine_insights');
    if (!enabled) {
      logger.info(
        { storeId },
        'answer-engine-scan-on-demand: answer_engine_insights disabled, skipping'
      );
      return { skipped: true, reason: 'feature_disabled', engineResults: [] };
    }

    // Plan gate — a super-admin `StoreFeature` override can force-enable
    // `answer_engine_insights` on a `free`/lapsed store; the CRON already
    // excludes those via `aiEligiblePlanFilter` when enumerating stores, so
    // this on-demand twin must apply the same exclusion (mirrors
    // `stock-reorder-scan.ts`'s on-demand plan gate).
    const store = await withRlsBypass(tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { plan: true } })
    );
    if (!store || !isAiEligiblePlan(store.plan)) {
      logger.info(
        { storeId, plan: store?.plan },
        'answer-engine-scan-on-demand: plan ineligible for AI, skipping'
      );
      return {
        skipped: true,
        reason: 'plan_ineligible',
        plan: store?.plan ?? null,
        engineResults: [],
      };
    }

    // On-demand also runs without HTTP tenant context — wrap so FORCE RLS
    // sees the correct GUC.
    // See the cron: memoized so a retried `scan` step resumes (#910).
    const runStartedAt = new Date(await step.run('run-started-at', () => new Date().toISOString()));
    const engineResults = await step.run('scan', () =>
      runInTenantContext(storeId, () => runCitationScan(storeId, { runStartedAt }))
    );

    logger.info({ storeId, engineResults }, 'answer-engine-scan-on-demand completed');
    return { skipped: false, engineResults };
  }
);
