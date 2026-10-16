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
import { ipKeyGenerator } from 'express-rate-limit';
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

// ---- Storefront query embeds (Task 12, Rulings SEARCH-T12-3, SEARCH-T12-6) -------------------
// THE gate for every query-time Workers AI call. `takeQueryEmbed` is called exactly once per
// actual provider call, immediately before it, and never on a query-vector cache hit (which costs
// nothing). It INCRs four counters (atomic INCR, then compare) and grants only when ALL have room:
//   1. the account-wide total above (shared with the indexer: one daily spend ceiling for both);
//   2. a query-wide Cairo-day cap set BELOW it (shoppers can never use up the indexer's share);
//   3. a per-store Cairo-day cap (traffic aimed at one store cannot spend every store's);
//   4. a per-SEARCHER per-minute cap (one client, by normalised IP, whatever URL shape, query
//      string or entry point — storefront list or MCP `search_products` — it arrives through).
// No searcher = no embed (default deny: a new caller must opt in with an identity). Refused =
// keyword-only search, never an error. No Redis = refused (fails closed, like the indexer). Unique
// queries defeat the cache, so these counters, not the cache, are what bound the spend.
export const DEFAULT_QUERY_GLOBAL_DAILY_CAP = 10_000;
export const DEFAULT_QUERY_STORE_DAILY_CAP = 1_000;
/** Query embeds per searcher (normalised IP) per minute. */
export const SEARCH_EMBED_PER_SEARCHER_PER_MIN = 20;
/** The per-minute searcher key lives two windows (Redis/KV TTL floor 120 s). */
const SEARCHER_KEY_TTL_SECONDS = 120;

/** The searcher identity for the query-embed limit: the client IP, IPv6 collapsed to its /64. */
export function searcherFromIp(ip: string | undefined): string {
  return `ip:${ipKeyGenerator(ip ?? '') || 'noip'}`;
}
export function searcherEmbedKey(searcher: string, now: Date): string {
  return `search:embed:searcher:${searcher}:${Math.floor(now.getTime() / 60_000)}`;
}

function capFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
/** `SEARCH_QUERY_EMBED_GLOBAL_DAILY_CAP`: storefront query embeds per Cairo day, all stores. */
export const queryEmbedGlobalDailyCap = () =>
  capFromEnv('SEARCH_QUERY_EMBED_GLOBAL_DAILY_CAP', DEFAULT_QUERY_GLOBAL_DAILY_CAP);
/** `SEARCH_QUERY_EMBED_STORE_DAILY_CAP`: storefront query embeds per Cairo day, per store. */
export const queryEmbedStoreDailyCap = () =>
  capFromEnv('SEARCH_QUERY_EMBED_STORE_DAILY_CAP', DEFAULT_QUERY_STORE_DAILY_CAP);

export function queryEmbedGlobalKey(now: Date): string {
  return `search:embed:query:${regionDayStart(now).toISOString()}`;
}
export function queryEmbedStoreKey(storeId: string, now: Date): string {
  return `search:embed:query:${storeId}:${regionDayStart(now).toISOString()}`;
}

/**
 * Charge ONE query-time provider call to every budget; false = do not call the provider.
 * Call it once per real call, right before it (never on a cache hit).
 */
export async function takeQueryEmbed(
  storeId: string,
  searcher: string | undefined
): Promise<boolean> {
  if (!searcher) return false;
  const daily = [embedGlobalDailyCap(), queryEmbedGlobalDailyCap(), queryEmbedStoreDailyCap()];
  if (daily.some(c => c <= 0)) return false;
  const client = redis.getClient();
  if (!client || !redis.isAvailable()) return false;
  const now = new Date();
  try {
    // 1. The searcher's per-minute limit FIRST, and alone: a client over its limit never touches
    //    the shared daily budgets, so it cannot burn the store's or the platform's day.
    const sKey = searcherEmbedKey(searcher, now);
    const sUsed = await client.incr(sKey);
    if (sUsed === 1) await client.expire(sKey, SEARCHER_KEY_TTL_SECONDS);
    if (sUsed > SEARCH_EMBED_PER_SEARCHER_PER_MIN) return false;
    // 2. The daily budgets (INCR, then compare). A refusal by ANY of them refunds all three, so each
    //    daily counter equals the provider calls actually made (a crash between the two steps
    //    over-counts by one; it can never under-count).
    const keys = [
      embedCallBudgetKey(now),
      queryEmbedGlobalKey(now),
      queryEmbedStoreKey(storeId, now),
    ];
    const used = await Promise.all(keys.map(k => client.incr(k)));
    await Promise.all(
      used.map((u, i) => (u === 1 ? client.expire(keys[i], DAY_TTL_SECONDS) : undefined))
    );
    if (used.every((u, i) => u <= daily[i])) return true;
    await Promise.all(keys.map(k => client.decr(k)));
    // Log the FIRST refusal per counter per day only (u === cap + 1), never every request.
    used.forEach((u, i) => {
      if (u === daily[i] + 1)
        logger.warn(
          { storeId, budget: ['account', 'query', 'store'][i], cap: daily[i] },
          '[search] query embed budget reached; keyword-only search until the next Cairo day'
        );
    });
    return false;
  } catch (err) {
    logger.warn({ err }, '[search] query embed budget check failed, not spending');
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
