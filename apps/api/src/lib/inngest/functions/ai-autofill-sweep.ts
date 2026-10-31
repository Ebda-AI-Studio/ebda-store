/**
 * AI-first autofill sweep — daily leader-locked catalogue sweep
 *
 * Daily at 03:00 Egypt (= 00:00 UTC), for every store with autopilot
 * enabled:
 *   1. Recomputes order-driven FBT recommendations (recalculateFBT).
 *   2. Sweeps all active products: fills empty AI fields + refreshes stale ones
 *      (sweepStore from ai-autofill.service.ts).
 *
 * Leader-locked via Redis so only one Railway replica runs the job per tick.
 * retries: 1 — a full catalogue sweep is expensive; let failures surface fast.
 *
 * PR2 — crash-resumable batching. The active-store id list is loaded ONCE
 * inside `step.run('load-stores', ...)` (stable set + order across
 * retries), then split into `BULK_AI_BATCH_SIZE`-sized batches, each
 * processed inside its own `step.run(\`batch-${i}\`, ...)`. A crash mid-sweep
 * resumes at the first unfinished batch of stores instead of restarting the
 * whole platform sweep from store 0 — each store's per-store try/catch is
 * unchanged, and `sweepStore`/`recalculateFBT` are already idempotent
 * (force:false short-circuits already-balanced pairs; the refresh gate only
 * re-touches products idle > STALE_TTL_DAYS), so re-running a batch that
 * partially succeeded before a crash costs at most a few cheap no-op reads
 * per already-swept store.
 */

import type { JobDef } from '../../jobs/types';
import { runInStoreScope } from '@ebda/database';
import { allStoresDirectory } from '../../jobs/store-db';
import { withLeaderLock } from '../../leader-election';
import { sweepStore } from '../../../services/ai-autofill.service';
import { recommendationService } from '../../../services/recommendation.service';
import logger from '../../logger';
import { inngest } from '../client';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';

/**
 * One store's daily work, under that store's scope (review I3). The cron used to call
 * `recalculateFBT` / `sweepStore` with NO ambient scope: the tenant guard refused the first query
 * (`TenantScopeViolation`, and under `ebda_app` RLS it would have read nothing), so every store
 * logged "store failed" and neither the FBT recompute nor the autofill backfill ever ran.
 * `runInStoreScope`, not one transaction: the sweep interleaves AI calls and throttle sleeps,
 * so each query is its own short transaction (CLAUDE.md, long jobs). Exported for tests.
 */
export function sweepAutofillStore(storeId: string) {
  return runInStoreScope(storeId, async () => {
    await recommendationService.recalculateFBT(storeId);
    return sweepStore(storeId);
  });
}

// NOTE: inferred WITHOUT the `JobDef` contextual type on this
// `const` — annotating that directly here breaks TS's inference of
// `step.run`'s return type for object literals mixing a plain string[] with
// a richer array-of-objects sibling (the annotation widens the contextual
// type fed into `createFunction`'s generics, and Jsonify then collapses the
// string[] to `unknown[]`). Assigning to the annotated export on a separate
// line avoids feeding the annotation back into inference.
const aiAutofillSweepFn = inngest.createFunction(
  {
    id: 'ai-autofill-sweep',
    name: 'AI-first: daily catalogue autofill sweep',
    retries: 1,
    concurrency: { limit: 1 },
    // Daily at 00:00 UTC (02:00/03:00 Cairo — pinned to UTC on purpose: the Gemini quota resets then). Was every-3-days, but on a large initial
    // backfill the sweep hits the Gemini free-tier daily cap and aborts partway
    // (throw on isAiQuotaCapError) — a 3-day cadence then left the remainder
    // unbalanced for days. Daily lets each run resume the backlog right after the
    // quota resets. Steady-state cost stays ~zero: balance force:false short-
    // circuits already-balanced pairs and the refresh gate only re-touches
    // products idle > STALE_TTL_DAYS, so a caught-up catalogue makes no Gemini calls.
    triggers: [{ cron: '0 0 * * *' }],
  },
  async ({ event, step }) => {
    // 12h lock TTL: a crash-safety ceiling that comfortably covers even a very
    // large throttled sweep (2.5s/product → 12h ≈ 17k products) yet still clears
    // before the next daily tick — so a crashed run can't wedge the sweep for
    // days, and a slow legit run can't have its lock expire mid-sweep and trigger
    // a parallel double-run. The lock is released on normal completion (Lua del in
    // withLeaderLock's finally), so the TTL only matters on a hard crash.
    await withLeaderLock('ai-autofill-sweep', 12 * 60 * 60 * 1000, async () => {
      // Active stores only — don't burn the shared Gemini quota sweeping
      // suspended / inactive / churned stores. Loaded ONCE so batch
      // boundaries are stable across retries.
      const storeIds = await step.run('load-stores', async () => {
        // `stores` is under RLS: a cron lists stores through the directory definer. DO stores are listed too: the sweep
        // reaches each one through its Durable Object (Ruling CF-JOBS-4), one leader-locked run keeps ONE shared quota.
        const stores = await allStoresDirectory(event, s => s.status === 'active');
        return stores.map(s => s.id);
      });

      const batches = chunk(storeIds, BULK_AI_BATCH_SIZE);

      for (let i = 0; i < batches.length; i++) {
        const batchIds = batches[i];

        await step.run(`batch-${i}`, async () => {
          for (const storeId of batchIds) {
            try {
              const res = await sweepAutofillStore(storeId);
              logger.info({ storeId, ...res }, '[ai-autofill-sweep] store swept');
            } catch (err) {
              logger.error({ err, storeId }, '[ai-autofill-sweep] store failed');
            }
          }
        });
      }
    }).catch(err => logger.error({ err }, '[ai-autofill-sweep] leader lock error'));
  }
);
export const aiAutofillSweep: JobDef = aiAutofillSweepFn;
