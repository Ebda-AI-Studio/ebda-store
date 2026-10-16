// Account-wide ceiling on indexer Workers AI calls (PR3 final review minor 2, Ruling SEARCH-T11-19).
//
// `SEARCH_EMBED_STORE_DAILY_CAP` bounds DISTINCT products per store per day; it does not count the
// calls a batch retry, a single-product isolation pass or a failing run spends, and it is per store.
// This counts every indexer provider call across all stores in Redis (on the Worker: the AuthState
// Durable Object, strongly consistent) per Cairo day and refuses calls past
// `SEARCH_EMBED_GLOBAL_DAILY_CAP` (default 20 000 calls ≈ ≤ 500 000 products ≈ ≤ ~300 M input
// tokens ≈ ≤ ~$3.5/day at bge-m3's $0.0118/M). Fails CLOSED: with no Redis there is no proof of
// budget, so the indexer does not spend (it stays lexical-only and logs why).
import { regionDayStart } from '@ebda/shared';
import { redis } from '../../services/redis.service';
import { sendAlert } from '../../services/alerts.service';
import logger from '../logger';

export const DEFAULT_GLOBAL_DAILY_CAP = 20_000;
const DAY_TTL_SECONDS = 26 * 60 * 60; // > 1 day so a key outlives its whole Cairo day (TTL floor 120 s)

/** `SEARCH_EMBED_GLOBAL_DAILY_CAP`; a non-number falls back to the default; 0 stops every call. */
export function embedGlobalDailyCap(): number {
  const n = Number.parseInt(process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GLOBAL_DAILY_CAP;
}

/** One counter per Cairo day (keyed by the UTC instant that day starts). */
export function embedCallBudgetKey(now: Date): string {
  return `search:embed:calls:${regionDayStart(now).toISOString()}`;
}

/**
 * Take `n` provider calls from today's account-wide budget. One INCR per call (the Worker's Redis
 * shim has no INCRBY). Returns false — spend nothing — when the budget is spent or Redis is down.
 */
export async function takeEmbedCalls(n: number): Promise<boolean> {
  const cap = embedGlobalDailyCap();
  const client = redis.getClient();
  if (!client || !redis.isAvailable()) {
    logger.warn('[search-index] no Redis: global embed budget unprovable, not spending');
    return false;
  }
  const key = embedCallBudgetKey(new Date());
  try {
    for (let i = 0; i < n; i++) {
      const used = await client.incr(key);
      if (used === 1) await client.expire(key, DAY_TTL_SECONDS);
      if (used > cap) {
        await alertGlobalCapOnce(cap);
        return false;
      }
    }
    return true;
  } catch (err) {
    logger.warn({ err }, '[search-index] global embed budget check failed, not spending');
    return false;
  }
}

/** One P1 per Cairo day when the account-wide ceiling is reached. */
async function alertGlobalCapOnce(cap: number): Promise<void> {
  const client = redis.getClient();
  const first = await client
    ?.set(`${embedCallBudgetKey(new Date())}:alerted`, '1', 'EX', DAY_TTL_SECONDS, 'NX')
    .catch(() => null);
  if (first !== 'OK') return;
  logger.error({ cap }, '[search-index] global daily embedding budget reached');
  await sendAlert({
    level: 'p1',
    scope: 'platform',
    source: 'search-index.global-cap',
    title: 'Search: global daily embedding budget reached',
    body: `The indexer made ${cap} Workers AI calls today (SEARCH_EMBED_GLOBAL_DAILY_CAP) and stops until the next Cairo day. Search stays lexical for products not yet embedded.`,
    context: { cap },
  }).catch(() => undefined);
}

/** One outage alert per window, platform-wide (PR3 final review minor 7, Ruling SEARCH-T11-21). */
export const OUTAGE_ALERT_KEY = 'search:embed:outage-alerted';
const OUTAGE_WINDOW_SECONDS = 6 * 60 * 60; // the backstop's period: one alert per backstop tick at most

/**
 * Raise ONE platform P1 per 6 h window for a Workers AI outage seen by any store's indexer run
 * (every product failed retryably, twice). Without Redis it alerts anyway (an outage must not be
 * silent; deduplication is the part that degrades).
 */
export async function alertOutageOnce(context: { storeId: string; kind: string }): Promise<void> {
  const client = redis.getClient();
  if (client && redis.isAvailable()) {
    const first = await client
      .set(OUTAGE_ALERT_KEY, '1', 'EX', OUTAGE_WINDOW_SECONDS, 'NX')
      .catch(() => 'OK');
    if (first !== 'OK') return;
  }
  logger.error(
    { storeId: context.storeId, kind: context.kind },
    '[search-index] Workers AI outage: every product failed twice'
  );
  await sendAlert({
    level: 'p1',
    scope: 'platform',
    source: 'search-index.outage',
    title: 'Search: Workers AI embedding outage',
    body: `Every product in an indexer batch failed twice with a retryable error (${context.kind}; first seen for store ${context.storeId}). Indexing is paused for affected stores until the next event or backstop tick; nothing was quarantined. One alert per 6 h window.`,
    context,
  }).catch(() => undefined);
}
