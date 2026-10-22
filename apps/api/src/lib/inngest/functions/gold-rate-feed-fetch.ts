import type { InngestFunction } from 'inngest';
import { runInStoreScope, withStore } from '@ebda/database';
import { GOLD_KARATS } from '@ebda/shared';
import logger from '../../logger';
import { maskEmail } from '../../pii-mask';
import { inngest } from '../client';
import { goldFeedStores } from '../../definer';
import { sendAlert } from '../../../services/alerts.service';
import { EmailService } from '../../../services/email.service';
import { GoldRateService } from '../../../services/gold-rate/gold-rate.service';
import {
  FEED_TIMEOUT_MS,
  goldFeed,
  storeCandidateRates,
  type GoldFeedQuote,
  type GoldFeedResult,
} from '../../../services/gold-rate/feed/adapter';
import { config } from '../../../config';

/**
 * The automatic gold rate (Phase B5 Task 11; Ruling B5-15). Every 6 hours (minute 5 of hours 0, 6, 12, 18; 120
 * runs a month) it fetches the free keyless sources ONCE (never per store) and applies the result to every
 * store that turned the automatic rate on.
 *
 * Cost shape (INNGEST-BUDGET-1): the first thing it does is an UN-STEPPED definer read of the stores
 * that opted in; with none it returns, so an empty tick costs ONE execution. Only with at least one
 * opted-in store does it open `fetch` and one `apply-<store>` step per store.
 *
 * Order of trust: primary (XAU/USD x USD/EGP) -> fallback (one currency file) -> the last stored rate
 * while it is inside the store's max age (nothing written) -> the merchant's manual rate -> the
 * fail-closed block. Both sources down: no write, one P1 per run. Sources disagree by more than 2 %:
 * every opted-in store gets a PENDING rate (never auto-applied) and the operator gets a P1. A rate
 * over a store's jump gate is stored pending too (`GoldRateService.applyRates`, actor `feed`).
 */
export async function handleGoldRateFeedFetch(
  { step }: { step: { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> } },
  adapter: { fetch(signal: AbortSignal): Promise<GoldFeedResult> } = goldFeed()
) {
  {
    // Un-stepped: the empty tick (no store opted in) must cost ONE execution.
    const stores = await goldFeedStores();
    if (stores.length === 0) return { stores: 0 };

    const result = await step.run('fetch', async (): Promise<GoldFeedResult> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FEED_TIMEOUT_MS);
      try {
        return await adapter.fetch(ctl.signal);
      } finally {
        clearTimeout(timer);
      }
    });

    if (result.kind === 'down') {
      // Fail LOUD, never a silent stub (Ruling B5-15): nothing is written; the last stored rate keeps
      // serving inside each store's max age, then the manual rate, then the block.
      await step.run('alert-down', () =>
        sendAlert({
          level: 'p1',
          scope: 'platform',
          source: 'cron.gold-rate-feed',
          title: 'Gold rate feed: every source is down',
          body: `${stores.length} store(s) use the automatic rate and none was updated this run.`,
          context: { stores: stores.length },
        })
      );
      return { stores: stores.length, outcome: 'down' };
    }

    const disagree = result.kind === 'disagree';
    const quote: GoldFeedQuote = disagree ? result.primary : result.quote;
    if (disagree) {
      await step.run('alert-disagree', () =>
        sendAlert({
          level: 'p1',
          scope: 'platform',
          source: 'cron.gold-rate-feed-disagree',
          title: 'Gold rate feed: sources disagree',
          body: `The primary and fallback 24k rates differ by ${result.diffBps} bps (gate: 200). Nothing was auto-applied; every opted-in store has a PENDING rate to confirm.`,
          context: {
            primary24k: result.primary.per24kGramPiastres,
            fallback24k: result.fallback.per24kGramPiastres,
            diffBps: result.diffBps,
          },
        })
      );
    }

    let applied = 0;
    let pending = 0;
    for (const s of stores) {
      const out = await step.run(`apply-${s.storeId}`, async () => {
        const candidates = storeCandidateRates(quote, s.premiumBps);
        const reference = {
          source: quote.source,
          fetchedAt: quote.fetchedAt,
          premiumBps: s.premiumBps,
          ...quote.reference,
          ...(disagree
            ? {
                disagreeDiffBps: result.diffBps,
                otherSource24k: result.fallback.per24kGramPiastres,
              }
            : {}),
        };
        const res = await runInStoreScope(s.storeId, () =>
          GoldRateService.applyRates(
            s.storeId,
            { rates: GOLD_KARATS.map(k => ({ karat: k, ratePerGram: candidates.get(k)! })) },
            { feed: reference, forcePending: disagree }
          )
        );
        for (const p of res.pending) {
          const info = await withStore(s.storeId, tx =>
            tx.store.findUnique({
              where: { id: s.storeId },
              select: { name: true, owner: { select: { email: true } } },
            })
          );
          const to = info?.owner?.email;
          if (!to) continue;
          await EmailService.sendGoldRateNotice(s.storeId, 'pending', {
            to,
            storeName: info?.name ?? s.storeId,
            adminUrl: config.adminUrl,
            karat: p.karat,
            rateText: `${(p.ratePerGram / 100).toLocaleString('en-US')} EGP`,
            jumpText: p.jumpBps != null ? `${(p.jumpBps / 100).toFixed(1)}%` : '',
          });
          logger.info(
            { storeId: s.storeId, to: maskEmail(to), karat: p.karat },
            'gold-rate-feed: pending rate email sent'
          );
        }
        return { applied: res.applied.length, pending: res.pending.length };
      });
      applied += out.applied;
      pending += out.pending;
    }
    logger.info(
      { stores: stores.length, applied, pending, source: quote.source, disagree },
      'gold-rate-feed-fetch completed'
    );
    return { stores: stores.length, applied, pending, outcome: disagree ? 'disagree' : 'ok' };
  }
}

export const goldRateFeedFetchCron: InngestFunction.Any = inngest.createFunction(
  {
    id: 'gold-rate-feed-fetch',
    name: 'Gold rate — automatic feed (6-hourly)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '5 */6 * * *' }],
  },
  ({ step }) => handleGoldRateFeedFetch({ step })
);
