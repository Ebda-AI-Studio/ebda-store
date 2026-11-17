/**
 * GSC Daily Ingestion — Plan 8B, Task 3 (Answer Engine Insights / AEO)
 *
 * Two Inngest functions:
 *
 *   gscIngestCron    — daily cron (04:00 UTC) that ingests Google Search
 *                      Console Search Analytics for every AI-eligible store
 *                      (custom domain or `<slug>.ebda.app`) and the `answer_engine_insights`
 *                      feature enabled.
 *
 *   gscIngestOnDemand — event-driven, triggered by `gsc/ingest-requested`
 *                       (e.g. an admin "Sync now" button, or an integration
 *                       test driving ingestion without waiting for the cron).
 *
 * Both delegate to `runGscIngest()` from gsc-ingest.service.ts. Each
 * per-store step is wrapped in `step.run()` so Inngest retries only the
 * failing store without re-running healthy ones (mirrors
 * answer-engine-citation-scan.ts / stock-reorder-scan.ts).
 *
 * DORMANT UNTIL CREDENTIALED: `isGscConfigured()` is checked FIRST, before
 * any store enumeration — with no `GSC_SERVICE_ACCOUNT_JSON` set, the cron
 * logs and returns immediately. This mirrors how Plan 8A's paid
 * answer-engine providers stay dormant until an admin sets a key: no wasted
 * enumeration/DB work, and no risk of a half-configured ingestion attempt.
 *
 * Concurrency: limit 1 on the cron so overlapping deploys don't double-run.
 */
import { readStorePlan } from '../../store-plan';
import type { JobDef } from '../../jobs/types';
import { allStoresDirectory, runInStoreCtx, withStoreDb } from '../../jobs/store-db';
import logger from '../../logger';
import { inngest } from '../client';
import { chunk, BULK_AI_BATCH_SIZE } from '../batch-utils';
import { isAiEligiblePlan } from '../../ai-plan-eligibility';
import type { StorePlan } from '@ebda/shared';
import { StoreService } from '../../../services/store.service';
import { featureService } from '../../../services/feature.service';
import { isGscConfigured } from '../../../services/answer-engine/gsc-client';
import {
  runGscIngest,
  type RunGscIngestOptions,
} from '../../../services/answer-engine/gsc-ingest.service';
import {
  ensureGscDomainProperty,
  realGscVerificationDeps,
  type GscVerificationDeps,
} from '../../../services/answer-engine/gsc-domain-verification.service';

// ---------------------------------------------------------------------------
// Per-store ingest body — isolated so ONE store can never abort the cron
// ---------------------------------------------------------------------------

export interface GscIngestStoreResult {
  storeId: string;
  /** `false` = ingested; `true` = feature-gate skip; `'no_domain'` /
   * `'no_access'` = runGscIngest's own skip reasons; `'error'` = the
   * feature check or the ingest itself threw and was isolated (see below). */
  skipped: boolean | 'no_domain' | 'no_access' | 'error';
  date?: string;
}

/**
 * The exact body `step.run(\`gsc-${storeId}\`, ...)` wraps for both the
 * daily cron loop and the on-demand handler's own ingest step.
 *
 * PER-STORE ISOLATION (mirrors `scanStoreCitations` in
 * answer-engine-citation-scan.ts): the pre-loop
 * `featureService.isFeatureEnabled` read, `runInTenantContext`, and
 * `runGscIngest` itself are all wrapped in one try/catch. A throw from any
 * of them (DB outage, GSC auth/network error other than a per-property
 * no-access 403) is converted into a `{ skipped: 'error' }` marker so the
 * cron's `for` loop simply continues to the next store instead of Inngest
 * exhausting this step's retries and failing the WHOLE cron run.
 */
/**
 * Custom-domain stores get their own GSC property automatically (META
 * verification served by the storefront, then sites.add — GAP 2). FAIL-SOFT and
 * isolated from the ingest: any failure is logged and tomorrow's run retries.
 */
async function ensureDomainPropertySoft(
  storeId: string,
  deps?: GscVerificationDeps
): Promise<void> {
  try {
    const d: GscVerificationDeps = deps ?? {
      ...realGscVerificationDeps,
      readStore: id =>
        withStoreDb(id, db =>
          db.store.findUnique({
            where: { id },
            select: { domain: true, googleSiteVerification: true },
          })
        ),
      publishToken: async (id, token) => {
        await StoreService.updateSeo(id, { googleSiteVerification: token });
      },
    };
    const status = await ensureGscDomainProperty(storeId, d);
    if (status !== 'no_domain' && status !== 'already_connected') {
      logger.info({ storeId, status }, 'gsc-ingest: custom-domain property check');
    }
  } catch (err) {
    logger.warn(
      { storeId, err: err instanceof Error ? err.message : String(err) },
      'gsc-ingest: custom-domain property setup failed, continuing with ingest'
    );
  }
}

export async function ingestStoreGsc(
  storeId: string,
  opts: RunGscIngestOptions & { verifyDeps?: GscVerificationDeps } = {}
): Promise<GscIngestStoreResult> {
  try {
    const enabled = await featureService.isFeatureEnabled(storeId, 'answer_engine_insights');
    if (!enabled) {
      logger.info({ storeId }, 'gsc-ingest: answer_engine_insights disabled, skipping');
      return { storeId, skipped: true };
    }

    // runGscIngest uses bare prisma internally. Wrap in runInTenantContext
    // so FORCE RLS policies see the correct store GUC for the
    // GscDailyMetric read/upsert.
    const { verifyDeps, ...ingestOpts } = opts;
    const result = await runInStoreCtx(storeId, async () => {
      await ensureDomainPropertySoft(storeId, verifyDeps);
      return runGscIngest(storeId, ingestOpts);
    });
    if (result.skipped) {
      return { storeId, skipped: result.skipped, date: result.date };
    }
    return { storeId, skipped: false, date: result.date };
  } catch (err) {
    logger.error(
      { storeId, err: err instanceof Error ? err.message : String(err) },
      'gsc-ingest: per-store ingest threw, isolating this store and continuing the cron'
    );
    return { storeId, skipped: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Daily cron — 04:00 UTC
// ---------------------------------------------------------------------------

// NOTE: inferred WITHOUT the `JobDef` contextual type on this
// `const` — annotating directly here breaks TS's inference of `step.run`'s
// return type once its result is threaded through `chunk()` (a generic
// helper). Same trap documented in bulk-ai-translate.ts / the citation scan
// cron; the fix is identical — assign to the annotated export on a separate
// statement below.
const gscIngestCronFn = inngest.createFunction(
  {
    id: 'gsc-ingest-cron',
    name: 'GSC daily ingestion — daily cron (force-managed)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 4 * * *' }], // 04:00 UTC daily
  },
  async ({ event, step }) => {
    // Dormant until credentialed: no service account configured → log +
    // return immediately, BEFORE any store enumeration. Ahmad confirmed
    // Force manages a single Google service account (gsc-client.ts) — until
    // it's provisioned this cron must be a true no-op, not a partial scan.
    if (!isGscConfigured()) {
      await step.run('gsc-not-configured', async () => {
        logger.info('gsc-ingest-cron: GSC_SERVICE_ACCOUNT_JSON not configured, dormant no-op');
      });
      return { configured: false, stores: 0, ingested: 0, skipped: 0, errored: 0 };
    }

    // Cross-tenant cron — list stores with withRlsBypass so FORCE RLS on the
    // stores table does not filter to 0 rows (no tenant GUC is set yet).
    const stores = await step.run('list-stores', () =>
      // `stores` is under RLS: a cron lists stores through the directory definer. Durable Object stores are listed too
      // (Ruling NZ-AN-1): one cron serves every store, the ingest reads each through its own backend.
      allStoresDirectory(
        event,
        s =>
          s.status === 'active' &&
          // every active store has a public host: its custom domain or <slug>.ebda.app
          s.aiFeaturesEnabled &&
          // free (lapsed-payment / demo) plans are excluded from AI spend.
          isAiEligiblePlan(s.plan as StorePlan)
      ).then(list => list.map(s => ({ id: s.id })))
    );

    const batches = chunk(stores, BULK_AI_BATCH_SIZE);

    let ingested = 0;
    let skipped = 0;
    let errored = 0;

    for (const batch of batches) {
      for (const store of batch) {
        // NOTE: all branches return the SAME flat shape (`{ storeId,
        // skipped, date }`) — same step.run return-type collision guard
        // documented in bulk-ai-translate.ts / the citation scan cron.
        const result = await step.run(`gsc-${store.id}`, () => ingestStoreGsc(store.id));

        if (result.skipped === 'error') {
          errored += 1;
          continue;
        }
        if (result.skipped) {
          skipped += 1;
          continue;
        }
        ingested += 1;
      }
    }

    logger.info({ stores: stores.length, ingested, skipped, errored }, 'gsc-ingest-cron completed');
    return { configured: true, stores: stores.length, ingested, skipped, errored };
  }
);

export const gscIngestCron: JobDef = gscIngestCronFn;

// ---------------------------------------------------------------------------
// On-demand — triggered by `gsc/ingest-requested` event
// ---------------------------------------------------------------------------

export const gscIngestOnDemand: JobDef = inngest.createFunction(
  {
    id: 'gsc-ingest-on-demand',
    name: 'GSC daily ingestion — on-demand (force-managed)',
    retries: 1,
    triggers: [{ event: 'gsc/ingest-requested' }],
  },
  async ({ event, step }) => {
    const { storeId } = event.data;

    if (!isGscConfigured()) {
      logger.info({ storeId }, 'gsc-ingest-on-demand: GSC not configured, dormant no-op');
      return { skipped: true, reason: 'not_configured' };
    }

    const enabled = await featureService.isFeatureEnabled(storeId, 'answer_engine_insights');
    if (!enabled) {
      logger.info({ storeId }, 'gsc-ingest-on-demand: answer_engine_insights disabled, skipping');
      return { skipped: true, reason: 'feature_disabled' };
    }

    // Plan gate — a super-admin `StoreFeature` override can force-enable
    // `answer_engine_insights` on a `free`/lapsed store; the CRON already
    // excludes those via `isAiEligiblePlan` when enumerating stores, so
    // this on-demand twin must apply the same exclusion (mirrors
    // `stock-reorder-scan.ts` / `answer-engine-citation-scan.ts`'s on-demand
    // plan gate).
    const store = await withStoreDb(storeId, db => readStorePlan(db as never, storeId));
    if (!store || !isAiEligiblePlan(store.plan)) {
      logger.info(
        { storeId, plan: store?.plan },
        'gsc-ingest-on-demand: plan ineligible for AI, skipping'
      );
      return { skipped: true, reason: 'plan_ineligible', plan: store?.plan ?? null };
    }

    // On-demand also runs without HTTP tenant context — wrap so FORCE RLS
    // sees the correct GUC.
    const result = await step.run(`gsc-${storeId}`, () =>
      runInStoreCtx(storeId, () => runGscIngest(storeId))
    );

    logger.info({ storeId, ...result }, 'gsc-ingest-on-demand completed');
    return { skipped: false, ...result };
  }
);
