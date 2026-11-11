// Account-wide ceiling on indexer Workers AI calls (PR3 final review minor 2, Ruling SEARCH-T11-19).
//
// `SEARCH_EMBED_STORE_DAILY_CAP` bounds DISTINCT products per store per day; it does not count the
// calls a batch retry, a single-product isolation pass or a failing run spends, and it is per store.
// This counts every indexer provider call across all stores in Redis (on the Worker: the AuthState
// Durable Object, strongly consistent) per Cairo day and refuses calls past
// `SEARCH_EMBED_GLOBAL_DAILY_CAP` (default 20 000 calls ≈ ≤ 500 000 products ≈ ≤ ~300 M input
// tokens ≈ ≤ ~$3.5/day at bge-m3's $0.0118/M). Fails CLOSED: with no Redis there is no proof of
// budget, so the indexer does not spend (it stays lexical-only and logs why).
import { regionDayStart, regionDayStartOffset } from '@ebda/shared';
import { BoundedMap } from '../bounded-map';
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
/**
 * Default query embeds per searcher (normalised IP) per fixed minute. Sized for carrier-grade NAT:
 * Egyptian mobile networks put many shoppers behind one public IPv4, so a tight per-IP limit would
 * turn legitimate shoppers keyword-only at scale (review M5). This limit only slows ONE client
 * draining the shared budgets; the daily budgets are what bound spend. Ruling SEARCH-T12-11.
 */
export const SEARCH_EMBED_PER_SEARCHER_PER_MIN = 60;

/** `SEARCH_EMBED_PER_SEARCHER_PER_MIN` (docs/ENVIRONMENT.md); a bad value falls back; 0 = none. */
export const searcherPerMinuteCap = () =>
  capFromEnv('SEARCH_EMBED_PER_SEARCHER_PER_MIN', SEARCH_EMBED_PER_SEARCHER_PER_MIN);
/** The per-minute searcher key lives two windows (Redis/KV TTL floor 120 s). */
const SEARCHER_KEY_TTL_SECONDS = 120;

/**
 * The searcher identity for the query-embed limit: the client IP, IPv6 grouped by its /64 (one
 * subscriber prefix; passed explicitly, the library default is /56). No IP = no identity =
 * `undefined`, so the gate refuses the embed (keyword-only) instead of putting every IP-less request
 * in one shared bucket (review M4).
 */
export function searcherFromIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const key = ipKeyGenerator(ip, 64);
  return key ? `ip:${key}` : undefined;
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
/**
 * Why a query embed was refused. `budget-store` / `budget-platform` = a DAILY cap is spent: a stable
 * state until the next Cairo day, so keyword-only results are a full answer of that mode and may be
 * cached under a key that says so (Ruling SEARCH-T12-10). Every other reason is per client or
 * transient and its results are never cached.
 */
export type QueryEmbedRefusal =
  | 'no-searcher'
  | 'searcher-limit'
  | 'budget-store'
  | 'budget-platform'
  | 'no-redis'
  | 'error';

/**
 * In-isolate "daily budget spent until <next Cairo day start, ms>" marks, keyed by store id or
 * PLATFORM. Set by the refusal that discovers it; while set, `takeQueryEmbed` refuses without any
 * Redis round trip. Staleness: BOUNDED by the Cairo day (the mark expires at the day start the
 * counters roll over); an isolate that never saw the refusal learns it on its own first refusal.
 */
const PLATFORM = '*';
const spentUntil = new BoundedMap<string, number>(1000);

/** Test seam. */
export function clearQueryBudgetSpentForTests(): void {
  spentUntil.clear();
}

function nextCairoDayStart(now: Date): number {
  return regionDayStartOffset(now, 1).getTime();
}

/** End (ms) of the spent state for this store, or 0 when its query budget is not known spent. */
export function queryBudgetSpentUntil(storeId: string, now: Date = new Date()): number {
  // A configured cap of 0 is "spent" by definition, with no round trip.
  if (
    embedGlobalDailyCap() <= 0 ||
    queryEmbedGlobalDailyCap() <= 0 ||
    queryEmbedStoreDailyCap() <= 0
  )
    return nextCairoDayStart(now);
  const t = now.getTime();
  const until = Math.max(spentUntil.get(storeId) ?? 0, spentUntil.get(PLATFORM) ?? 0);
  return until > t ? until : 0;
}

/** True while this store's (or the platform's) daily query-embed budget is known to be spent. */
export function queryBudgetSpent(storeId: string, now: Date = new Date()): boolean {
  return queryBudgetSpentUntil(storeId, now) > 0;
}

/**
 * Charge ONE query-time provider call to every budget; `ok: false` = do not call the provider, with
 * the reason. Call it once per real call, right before it (never on a cache hit).
 */
export async function takeQueryEmbedResult(
  storeId: string,
  searcher: string | undefined
): Promise<{ ok: true; settle?: () => Promise<void> } | { ok: false; reason: QueryEmbedRefusal }> {
  const now = new Date();
  if (queryBudgetSpent(storeId, now)) {
    const platform =
      (spentUntil.get(PLATFORM) ?? 0) > now.getTime() ||
      embedGlobalDailyCap() <= 0 ||
      queryEmbedGlobalDailyCap() <= 0;
    return { ok: false, reason: platform ? 'budget-platform' : 'budget-store' };
  }
  if (!searcher) return { ok: false, reason: 'no-searcher' };
  const daily = [embedGlobalDailyCap(), queryEmbedGlobalDailyCap(), queryEmbedStoreDailyCap()];
  const client = redis.getClient();
  if (!client || !redis.isAvailable()) return { ok: false, reason: 'no-redis' };
  try {
    // ONE parallel round trip (Ruling SEARCH-WARM-1): the searcher's per-minute counter and the three daily
    // counters are INCRed together (they live on different AuthState shards, so the calls overlap) instead of
    // searcher-then-daily-then-expire in series, which cost ~4 DO round trips on the timed storefront path.
    // Semantics kept: the call is made only on `ok`, a refusal by ANY counter refunds ALL of them so each daily
    // counter equals the provider calls actually made, and a crash can only over-count. A client over its own
    // per-minute limit refunds the daily counters and never marks a budget "spent" (its transient INCR must not
    // look like a spent day to everyone else).
    const sKey = searcherEmbedKey(searcher, now);
    const keys = [
      embedCallBudgetKey(now),
      queryEmbedGlobalKey(now),
      queryEmbedStoreKey(storeId, now),
    ];
    const [sUsed, ...used] = await Promise.all([sKey, ...keys].map(k => client.incr(k)));
    const ttls: Array<[string, number, number]> = [
      [sKey, SEARCHER_KEY_TTL_SECONDS, sUsed],
      ...keys.map((k, i): [string, number, number] => [k, DAY_TTL_SECONDS, used[i]]),
    ];
    // TTLs are set only on a counter's first INCR, OFF the timed path: the caller overlaps this with the embed.
    const settle = async () => {
      await Promise.all(ttls.filter(t => t[2] === 1).map(t => client.expire(t[0], t[1])));
    };
    if (sUsed > searcherPerMinuteCap()) {
      await Promise.all(keys.map(k => client.decr(k)));
      await settle();
      return { ok: false, reason: 'searcher-limit' };
    }
    if (used.every((u, i) => u <= daily[i])) return { ok: true, settle };
    await Promise.all(keys.map(k => client.decr(k)));
    await settle();
    // Mark the spent scope until the next Cairo day (no more round trips in this isolate).
    const platformSpent = used[0] > daily[0] || used[1] > daily[1];
    spentUntil.set(platformSpent ? PLATFORM : storeId, nextCairoDayStart(now));
    // Log the FIRST refusal per counter per day only (u === cap + 1), never every request.
    used.forEach((u, i) => {
      if (u === daily[i] + 1)
        logger.warn(
          { storeId, budget: ['account', 'query', 'store'][i], cap: daily[i] },
          '[search] query embed budget reached; keyword-only search until the next Cairo day'
        );
    });
    return { ok: false, reason: platformSpent ? 'budget-platform' : 'budget-store' };
  } catch (err) {
    logger.warn({ err }, '[search] query embed budget check failed, not spending');
    return { ok: false, reason: 'error' };
  }
}

/** Boolean form of `takeQueryEmbedResult`. */
export async function takeQueryEmbed(
  storeId: string,
  searcher: string | undefined,
  opts: { overlap?: (ttlWrites: Promise<void>) => void } = {}
): Promise<boolean> {
  const r = await takeQueryEmbedResult(storeId, searcher);
  if (r.ok && r.settle) {
    // The caller may overlap the TTL writes with its own work (the query embed); default: finish them here.
    if (opts.overlap) opts.overlap(r.settle().catch(() => undefined));
    else await r.settle();
  }
  return r.ok;
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
