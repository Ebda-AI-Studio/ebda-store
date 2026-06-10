/**
 * AI-first autofill sweep — 3-day leader-locked catalogue sweep
 *
 * Every 3 days at 03:00 Kuwait (= 00:00 UTC), for every store with autopilot
 * enabled:
 *   1. Recomputes order-driven FBT recommendations (recalculateFBT).
 *   2. Sweeps all active products: fills empty AI fields + refreshes stale ones
 *      (sweepStore from ai-autofill.service.ts).
 *
 * Leader-locked via Redis so only one Railway replica runs the job per tick.
 * retries: 1 — a full catalogue sweep is expensive; let failures surface fast.
 */

import type { InngestFunction } from 'inngest';
import { runInTenantContext, withRlsBypass } from '@force/database';
import { withLeaderLock } from '../../leader-election';
import { sweepStore } from '../../../services/ai-autofill.service';
import { recommendationService } from '../../../services/recommendation.service';
import logger from '../../logger';
import { inngest } from '../client';

export const aiAutofillSweep: InngestFunction.Any = inngest.createFunction(
  {
    id: 'ai-autofill-sweep',
    name: 'AI-first: 3-day catalogue autofill sweep',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 0 */3 * *' }], // 03:00 KW = 00:00 UTC (Kuwait is UTC+3)
  },
  async () => {
    await withLeaderLock('ai-autofill-sweep', 3 * 24 * 60 * 60 * 1000, async () => {
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
          await runInTenantContext(s.id, async () => {
            await recommendationService.recalculateFBT(s.id);
            const res = await sweepStore(s.id);
            logger.info({ storeId: s.id, ...res }, '[ai-autofill-sweep] store swept');
          });
        } catch (err) {
          logger.error({ err, storeId: s.id }, '[ai-autofill-sweep] store failed');
        }
      }
    }).catch(err => logger.error({ err }, '[ai-autofill-sweep] leader lock error'));
  }
);
