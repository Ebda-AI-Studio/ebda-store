import type { JobDef } from '../../jobs/types';
import { withStore } from '@ebda/database';
import logger from '../../logger';
import { maskEmail } from '../../pii-mask';
import { inngest } from '../client';
import { stepRunUnlessEmpty, type StepLike } from '../empty-exit';
import { goldRateWatchFor } from '../../jobs/gold-stores';
import {
  SentinelStoreUnavailableError,
  markSent,
  wasSent,
} from '../../../services/gold-rate/sentinel';
import { sendAlert } from '../../../services/alerts.service';
import { EmailService } from '../../../services/email.service';
import { rateAgeMinutes } from '../../../services/gold-rate/gate';
import { config } from '../../../config';

/** Minutes before the max age at which the owner is warned (Ruling B5-16: 22 h of 26). */
export const WARN_BEFORE_MINUTES = 240;

/**
 * Stale-rate alerts (Phase B5 Task 11; Ruling B5-16). Hourly (`7 * * * *`, 720 runs a month).
 *
 *   age >= maxAge - 4 h  -> one warning email per rate   (sentinel gold:stale-warn:<store>:<rateId>)
 *   age >= maxAge        -> one "selling paused" email + a store-scoped P1
 *                            (sentinel gold:stale-block:<store>:<rateId>)
 *
 * A new rate has a new id, so its sentinels are fresh and the cycle resets. The admin banner reads the
 * same age from GET /gold-rates, so no extra state exists. Every store that sells at least one gold-priced
 * product is returned by the definer (nothing in the API reads `enabled`, so the watch does not either); with none inside the window the tick returns
 * before opening any step, so an empty tick costs ONE execution (INNGEST-BUDGET-1).
 *
 * Deviation from the plan: hourly, not every 30 minutes. At 30 minutes the cron alone would be 1 440
 * runs and the monthly cron budget (12 000) would be exceeded; an hourly check still warns 4 hours
 * ahead and blocks within the hour.
 */
export async function handleGoldRateStalenessWatch(
  { step, event }: { step: StepLike; event?: { data?: unknown } },
  now: Date = new Date()
) {
  {
    // Read inside a step on a Workflow (no database between steps); an empty tick still costs one
    // execution on Inngest. A step result is JSON, so the date comes back as a string: rebuild it.
    const watch = (await stepRunUnlessEmpty(step, 'watch', () => goldRateWatchFor(event, now))).map(
      w => ({
        ...w,
        appliedAt: new Date(w.appliedAt),
      })
    );
    if (watch.length === 0) return { stores: 0 };

    // one notice per (store, rate): the oldest karat decides the wording
    const byStore = new Map<string, typeof watch>();
    for (const w of watch) byStore.set(w.storeId, [...(byStore.get(w.storeId) ?? []), w]);

    let warned = 0;
    let blocked = 0;
    const sentinelErr = await step.run('probe-sentinel', async () => {
      try {
        await wasSent('gold:stale-probe'); // is the dedupe store there at all?
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    });
    if (sentinelErr !== null) {
      const err = new Error(sentinelErr);
      // Fail LOUD (Ruling B5-36): without a dedupe store the notice can neither go out once nor be skipped quietly.
      logger.error(
        { err },
        'gold-rate-staleness-watch: sentinel store unavailable, no notice sent'
      );
      await sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'cron.gold-rate-staleness-no-sentinel-store',
        title: 'Gold rate stale notices cannot be sent: no dedupe store',
        body: `${byStore.size} store(s) have a rate near or past its max age and no owner was told: the sentinel store (Redis) is unavailable.`,
        context: { stores: byStore.size },
      }).catch(() => undefined);
      return { stores: byStore.size, warned, blocked, outcome: 'no-sentinel-store' };
    }
    for (const [storeId, rows] of byStore) {
      const out = await step
        .run(`notify-${storeId}`, async () => {
          const oldest = rows.reduce((a, b) => (a.appliedAt <= b.appliedAt ? a : b));
          const age = rateAgeMinutes(oldest.appliedAt, now);
          // defensive: the definer only returns rows inside the warning window, but the handler never trusts a row alone
          if (age < oldest.maxAgeMinutes - WARN_BEFORE_MINUTES)
            return { sent: false, kind: 'warning' as const };
          const isBlocked = age >= oldest.maxAgeMinutes;
          const kind = isBlocked ? 'blocked' : 'warning';
          const sentinel = `gold:stale-${isBlocked ? 'block' : 'warn'}:${storeId}:${oldest.rateId}`;
          // Marked AFTER the send (below): a send that throws leaves it unset and the next run retries.
          if (await wasSent(sentinel)) return { sent: false, kind };

          const info = await withStore(storeId, tx =>
            tx.store.findUnique({
              where: { id: storeId },
              select: { name: true, slug: true, owner: { select: { email: true } } },
            })
          );
          const to = info?.owner?.email;
          if (to) {
            await EmailService.sendGoldRateNotice(storeId, kind, {
              to,
              storeName: info?.name ?? storeId,
              adminUrl: config.adminUrl,
              hours: Math.floor(age / 60),
              maxHours: Math.round(oldest.maxAgeMinutes / 60),
            });
            logger.info(
              { storeId, to: maskEmail(to), kind },
              'gold-rate-staleness-watch: notice sent'
            );
          }
          if (isBlocked) {
            await sendAlert({
              level: 'p1',
              scope: 'store',
              store: { id: storeId, name: info?.name ?? storeId, slug: info?.slug ?? undefined },
              source: 'cron.gold-rate-staleness',
              title: 'Gold rate is stale: selling gold-priced pieces is paused',
              body: `The ${oldest.karat}k rate is ${Math.floor(age / 60)} h old (max ${Math.round(oldest.maxAgeMinutes / 60)} h).`,
              context: {
                karat: oldest.karat,
                ageMinutes: age,
                maxAgeMinutes: oldest.maxAgeMinutes,
              },
            });
          }
          await markSent(sentinel);
          return { sent: true, kind };
        })
        .catch(async (err: unknown) => {
          // One store's failure must not stop the stores after it, and must not be silent.
          if (err instanceof SentinelStoreUnavailableError) throw err;
          logger.error(
            { err, storeId },
            'gold-rate-staleness-watch: notice failed, will retry next run'
          );
          await sendAlert({
            level: 'p1',
            scope: 'platform',
            source: 'cron.gold-rate-staleness-failed',
            title: 'Gold rate stale notice failed to send',
            body: `The stale-rate notice for store ${storeId} threw; it is retried on the next hourly run.`,
            context: { storeId, error: err instanceof Error ? err.message : String(err) },
          }).catch(() => undefined);
          return { sent: false, kind: 'warning' as const };
        });
      if (out.sent) {
        if (out.kind === 'blocked') blocked++;
        else warned++;
      }
    }
    return { stores: byStore.size, warned, blocked };
  }
}

export const goldRateStalenessWatchCron: JobDef = inngest.createFunction(
  {
    id: 'gold-rate-staleness-watch',
    name: 'Gold rate — stale-rate alerts (hourly)',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '7 * * * *' }],
  },
  ({ step, event }) => handleGoldRateStalenessWatch({ step, event })
);
