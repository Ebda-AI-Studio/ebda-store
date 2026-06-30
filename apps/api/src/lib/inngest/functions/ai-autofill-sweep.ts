/**
 * AI-first autofill sweep — daily leader-locked catalogue sweep
 *
 * Daily at 03:00 Kuwait (= 00:00 UTC), for every store with autopilot
 * enabled:
 *   1. Recomputes order-driven FBT recommendations (recalculateFBT).
 *   2. Sweeps all active products: fills empty AI fields + refreshes stale ones
 *      (sweepStore from ai-autofill.service.ts).
 *
 * Leader-locked via Redis so only one Railway replica runs the job per tick.
 * retries: 1 — a full catalogue sweep is expensive; let failures surface fast.
 */

import type { InngestFunction } from 'inngest';
import { withRlsBypass } from '@force/database';
import { withLeaderLock } from '../../leader-election';
import { sweepStore } from '../../../services/ai-autofill.service';
import { recommendationService } from '../../../services/recommendation.service';
import logger from '../../logger';
import { inngest } from '../client';

export const aiAutofillSweep: InngestFunction.Any = inngest.createFunction(
  {
    id: 'ai-autofill-sweep',
    name: 'AI-first: daily catalogue autofill sweep',
    retries: 1,
    concurrency: { limit: 1 },
    // Daily at 03:00 KW (= 00:00 UTC). Was every-3-days, but on a large initial
    // backfill the sweep hits the Gemini free-tier daily cap and aborts partway
    // (throw on isAiQuotaCapError) — a 3-day cadence then left the remainder
    // unbalanced for days. Daily lets each run resume the backlog right after the
    // quota resets. Steady-state cost stays ~zero: balance force:false short-
    // circuits already-balanced pairs and the refresh gate only re-touches
    // products idle > STALE_TTL_DAYS, so a caught-up catalogue makes no Gemini calls.
    triggers: [{ cron: '0 0 * * *' }],
  },
  async () => {
    // 12h lock TTL: a crash-safety ceiling that comfortably covers even a very
    // large throttled sweep (2.5s/product → 12h ≈ 17k products) yet still clears
    // before the next daily tick — so a crashed run can't wedge the sweep for
    // days, and a slow legit run can't have its lock expire mid-sweep and trigger
    // a parallel double-run. The lock is released on normal completion (Lua del in
    // withLeaderLock's finally), so the TTL only matters on a hard crash.
    await withLeaderLock('ai-autofill-sweep', 12 * 60 * 60 * 1000, async () => {
      // Active stores only — don't burn the shared Gemini quota sweeping
      // suspended / inactive / churned stores.
      const stores = await withRlsBypass(tx =>
        tx.store.findMany({
          where: { deletedAt: null, status: 'active' },
          select: { id: true },
        })
      );

      for (const s of stores) {
        try {
          await (async () => {
            await recommendationService.recalculateFBT(s.id);
            const res = await sweepStore(s.id);
            logger.info({ storeId: s.id, ...res }, '[ai-autofill-sweep] store swept');
          })();
        } catch (err) {
          logger.error({ err, storeId: s.id }, '[ai-autofill-sweep] store failed');
        }
      }
    }).catch(err => logger.error({ err }, '[ai-autofill-sweep] leader lock error'));
  }
);
