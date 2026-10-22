import type { InngestFunction } from 'inngest';
import { withStore } from '@ebda/database';
import logger from '../../logger';
import { maskEmail } from '../../pii-mask';
import { inngest } from '../client';
import { goldRateWatch } from '../../definer';
import { redis } from '../../../services/redis.service';
import { sendAlert } from '../../../services/alerts.service';
import { EmailService } from '../../../services/email.service';
import { rateAgeMinutes } from '../../../services/gold-rate/gate';
import { config } from '../../../config';

/** Minutes before the max age at which the owner is warned (Ruling B5-16: 22 h of 26). */
export const WARN_BEFORE_MINUTES = 240;
const SENTINEL_TTL_SECONDS = 3 * 24 * 60 * 60;

/** Claim a once-only sentinel (a Durable Object key on Workers: it is not a `cache:` key). */
async function claimOnce(key: string): Promise<boolean> {
  try {
    const client = redis.getClient();
    if (!client) return false;
    const res = await client.set(key, '1', 'EX', SENTINEL_TTL_SECONDS, 'NX');
    return res === 'OK';
  } catch (err) {
    // No dedupe store: skip rather than email the owner every hour. The next healthy run sends it.
    logger.warn({ err, key }, 'gold-rate-staleness-watch: sentinel store unavailable, skipping');
    return false;
  }
}

/**
 * Stale-rate alerts (Phase B5 Task 11; Ruling B5-16). Hourly (`7 * * * *`, 720 runs a month).
 *
 *   age >= maxAge - 4 h  -> one warning email per rate   (sentinel gold:stale-warn:<store>:<rateId>)
 *   age >= maxAge        -> one "selling paused" email + a store-scoped P1
 *                            (sentinel gold:stale-block:<store>:<rateId>)
 *
 * A new rate has a new id, so its sentinels are fresh and the cycle resets. The admin banner reads the
 * same age from GET /gold-rates, so no extra state exists. Only stores that opted in AND sell at least
 * one gold-priced product are returned by the definer; with none inside the window the tick returns
 * before opening any step, so an empty tick costs ONE execution (INNGEST-BUDGET-1).
 *
 * Deviation from the plan: hourly, not every 30 minutes. At 30 minutes the cron alone would be 1 440
 * runs and the monthly cron budget (12 000) would be exceeded; an hourly check still warns 4 hours
 * ahead and blocks within the hour.
 */
export async function handleGoldRateStalenessWatch(
  { step }: { step: { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> } },
  now: Date = new Date()
) {
  {
    const watch = await goldRateWatch(); // un-stepped
    if (watch.length === 0) return { stores: 0 };

    // one notice per (store, rate): the oldest karat decides the wording
    const byStore = new Map<string, typeof watch>();
    for (const w of watch) byStore.set(w.storeId, [...(byStore.get(w.storeId) ?? []), w]);

    let warned = 0;
    let blocked = 0;
    for (const [storeId, rows] of byStore) {
      const out = await step.run(`notify-${storeId}`, async () => {
        const oldest = rows.reduce((a, b) => (a.appliedAt <= b.appliedAt ? a : b));
        const age = rateAgeMinutes(oldest.appliedAt, now);
        // defensive: the definer only returns rows inside the warning window, but the handler never trusts a row alone
        if (age < oldest.maxAgeMinutes - WARN_BEFORE_MINUTES)
          return { sent: false, kind: 'warning' as const };
        const isBlocked = age >= oldest.maxAgeMinutes;
        const kind = isBlocked ? 'blocked' : 'warning';
        const sentinel = `gold:stale-${isBlocked ? 'block' : 'warn'}:${storeId}:${oldest.rateId}`;
        if (!(await claimOnce(sentinel))) return { sent: false, kind };

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
            context: { karat: oldest.karat, ageMinutes: age, maxAgeMinutes: oldest.maxAgeMinutes },
          });
        }
        return { sent: true, kind };
      });
      if (out.sent) {
        if (out.kind === 'blocked') blocked++;
        else warned++;
      }
    }
    return { stores: byStore.size, warned, blocked };
  }
}

export const goldRateStalenessWatchCron: InngestFunction.Any = inngest.createFunction(
  {
    id: 'gold-rate-staleness-watch',
    name: 'Gold rate — stale-rate alerts (hourly)',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '7 * * * *' }],
  },
  ({ step }) => handleGoldRateStalenessWatch({ step })
);
