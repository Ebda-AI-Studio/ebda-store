/**
 * First-party storefront search log (search program P0, Task 5; Rulings SEARCH-4, SEARCH-T5-6).
 *
 * One row per (store, Cairo day, NORMALISED term) in `search_query_daily`: a counter, not an
 * event log. What a row holds: the normalised term, daily counts, and the DAY it was last
 * counted (no time of day). It is never linked to a user, session, IP, user agent or order.
 * A term shaped like a phone, an email, a national id, an order number, an id or a link is
 * dropped before the insert. Free text CAN still contain a name or a place a shopper typed
 * (`احمد محمد`, `شارع التحرير`): that cannot be filtered by shape and is accepted under Ruling
 * SEARCH-T5-6 (unlinked, one store's merchant only, 90 days; `getSearchInsights` shows only
 * terms searched at least SEARCH_LOG_MIN_SEARCHES_SHOWN times, each searcher counting a term once
 * per SEARCH_LOG_SEARCHER_DEDUPE_TTL_S: `claimSearcherSearch`).
 *
 * Writer: `GET /public/products` (page 1 of a real query) through
 * `deferAfterTenantCommit('search-log', ...)`: after the request transaction commits, in a
 * fresh tenant transaction, never on the response's latency path (E2).
 * Reader: `getSearchInsights` (admin `/stores/[id]/insights/searches` + the analytics card,
 * Task 6). Retention: `purgeSearchLogAcrossStores`, run daily by `search-log-purge-daily`
 * (90 days). Store deletion: the FK cascades.
 *
 * Bloat cap: at most SEARCH_LOG_MAX_TERMS_PER_DAY distinct terms per store per day. Once a
 * store's day is full, known terms still count and new ones are dropped, so a bot sending
 * random strings can add at most that many rows per store per day (and can starve that day's
 * NEW terms: Ruling SEARCH-T5-4).
 */
import { createHmac } from 'node:crypto';
import { storeDirectory, withoutHiddenStores, withStore } from '@ebda/database';
import { runInStoreCtx } from '../lib/jobs/store-db';
import { foldSearchLogTerm, isPersonalDataTerm, REGION, zonedIsoDay } from '@ebda/shared';
import { derivedSecret } from '../lib/derived-secret';
import logger from '../lib/logger';
import { redis } from './redis.service';
import { withSavepoint } from '../lib/savepoint';
import { analyticsMoney } from '../lib/analytics-backend';

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

export const SEARCH_LOG_RETENTION_DAYS = 90;
/** Distinct terms one store may add per Cairo day (soft: concurrent inserts can pass it by a few). */
export const SEARCH_LOG_MAX_TERMS_PER_DAY = 1000;
/** Stored term length, in code points (VARCHAR(100)). */
export const SEARCH_LOG_TERM_MAX = 100;
/** Raw input longer than this is not a search anyone typed: never stored. */
const SEARCH_LOG_RAW_MAX = 1000;
/**
 * k-anonymity floor for the read API: a term is listed only when it was searched at least this
 * many times in the window by DISTINCT searchers (`claimSearcherSearch` dedupes one searcher's
 * re-fetches), so a one-off pasted name or address is never shown (Ruling SEARCH-T5-6). Totals
 * still count every counted search.
 */
export const SEARCH_LOG_MIN_SEARCHES_SHOWN = 2;

const INT4_MAX = 2_147_483_647;

/**
 * Distinct-searcher dedupe window (Ruling SEARCH-T5-6, revised 2026-10-16): one searcher counts a
 * term once per 30 minutes, so a sort / category change or a retry (each re-fetches page 1)
 * does not count again. ≥ the repo's 120s Redis TTL floor.
 */
export const SEARCH_LOG_SEARCHER_DEDUPE_TTL_S = 30 * 60;
const SEARCHER_KEY_PREFIX = 'search-log:seen:';

// The personal-data gate lives in `@ebda/shared` (`search/personal-data-term.ts`) so the
// storefront's ad-pixel Search event uses the SAME test (Ruling SEARCH-T5-9). Re-exported here
// for existing callers.
export { foldSearchLogTerm, isPersonalDataTerm };

/**
 * The term as it is stored: folded (so spelling variants share one row), checked as a WHOLE,
 * then capped at 100 code points (the cut is AFTER folding and checking, so a phone near the
 * end of a long input is caught, not half-cut). Null when it must not be stored: under 2
 * characters, over SEARCH_LOG_RAW_MAX raw, or personal-data shaped.
 */
export function searchLogTerm(rawTerm: string): string | null {
  if (!rawTerm || rawTerm.length > SEARCH_LOG_RAW_MAX) return null;
  const norm = foldSearchLogTerm(rawTerm);
  if ([...norm].length < 2 || isPersonalDataTerm(norm)) return null;
  // Cap by code point, then re-trim: the cut can leave a trailing space.
  return [...norm].slice(0, SEARCH_LOG_TERM_MAX).join('').replace(/ +$/, '');
}

/**
 * The short-lived Redis dedupe key for (store, searcher, term) on one Cairo day. The searcher is
 * a salted, daily-rotated HMAC of (IP + user agent): the salt is a key derived from
 * ENCRYPTION_KEY, and the day is part of the MAC input, so the same visitor hashes differently
 * tomorrow. The key holds only that hex digest (no IP, user agent or term) and lives in Redis for
 * SEARCH_LOG_SEARCHER_DEDUPE_TTL_S; it is never written to `search_query_daily` or a log line.
 */
export function searcherDedupeKey(
  storeId: string,
  storedTerm: string,
  searcher: { ip: string; userAgent: string },
  now: Date = new Date()
): string {
  const day = searchLogDay(now);
  const mac = createHmac('sha256', derivedSecret('ebda:search-searcher-salt:v1'))
    .update([day, storeId, searcher.ip, searcher.userAgent, storedTerm].join('\u0000'))
    .digest('hex');
  return `${SEARCHER_KEY_PREFIX}${mac}`;
}

/**
 * True when this search should be counted: the first page-1 request for this term by this
 * searcher in the dedupe window. Fail-open (Redis down, no key material): true, the search is
 * counted once for that request. A term the log would not store anyway returns true without
 * touching Redis (`recordSearch` drops it).
 */
export async function claimSearcherSearch(
  storeId: string,
  rawTerm: string,
  searcher: { ip: string; userAgent: string },
  now: Date = new Date()
): Promise<boolean> {
  const term = searchLogTerm(rawTerm);
  if (term === null) return true;
  const client = redis.getClient();
  if (!client || !redis.isAvailable()) return true;
  try {
    const key = searcherDedupeKey(storeId, term, searcher, now);
    const res = await client.set(key, '1', 'EX', SEARCH_LOG_SEARCHER_DEDUPE_TTL_S, 'NX');
    return res === 'OK';
  } catch (err) {
    logger.warn({ storeId, code: errCode(err) }, '[SEARCH-LOG] searcher dedupe unavailable');
    return true;
  }
}

/** The region (Africa/Cairo, DST-aware) calendar day containing `now`, as `YYYY-MM-DD`. */
export function searchLogDay(now: Date = new Date()): string {
  return zonedIsoDay(now, REGION.timezone);
}

/** `day` minus `n` calendar days, as `YYYY-MM-DD` (pure calendar arithmetic, no time zone). */
export function isoDayMinus(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

function errCode(err: unknown): string {
  const e = err as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
  } | null;
  return e?.meta?.driverAdapterError?.cause?.originalCode ?? e?.code ?? 'unknown';
}

/**
 * Count one storefront search. Fail-open: tracking never breaks a search, so every error is
 * logged (store id + error code only: never the term) and turned into `false`. Returns false
 * when the term was not stored (personal-data shaped, too short, or the store's day is full).
 *
 * Call it through `deferAfterTenantCommit('search-log', ...)` from a request handler: inside
 * a request it would otherwise write into the read request's transaction.
 */
export async function recordSearch(
  storeId: string,
  rawTerm: string,
  resultCount: number,
  opts: { maxTermsPerDay?: number; now?: Date } = {}
): Promise<boolean> {
  const term = searchLogTerm(rawTerm);
  if (!term) return false;
  const count = Number.isFinite(resultCount)
    ? Math.min(INT4_MAX, Math.max(0, Math.floor(resultCount)))
    : 0;
  const zero = count === 0 ? 1 : 0;
  const day = searchLogDay(opts.now);
  const cap = opts.maxTermsPerDay ?? SEARCH_LOG_MAX_TERMS_PER_DAY;
  try {
    // Ruling NZ-AN-1: a Durable Object store counts in its own DO once the analytics copy flipped
    const money = await analyticsMoney(storeId, 'write');
    if (money) {
      const r = await money.searchLogRecord({ dayMs: dayMs(day), term, count, zero, cap });
      return r.counted;
    }
    const affected = await withStore(storeId, tx =>
      // Savepoint: a failure must not poison the deferred task's transaction.
      withSavepoint(
        () => tx.$executeRaw`
          INSERT INTO search_query_daily
            (id, store_id, date, term, searches, zero_results, last_result_count, updated_at)
          SELECT gen_random_uuid()::text, ${storeId}, ${day}::date, ${term}, 1, ${zero}, ${count}, ${day}::date
          WHERE EXISTS (
                  SELECT 1 FROM search_query_daily
                  WHERE store_id = ${storeId} AND date = ${day}::date AND term = ${term})
             OR (SELECT count(*) FROM search_query_daily
                 WHERE store_id = ${storeId} AND date = ${day}::date) < ${cap}
          ON CONFLICT (store_id, date, term) DO UPDATE SET
            searches = LEAST(search_query_daily.searches, 2147483646) + 1,
            zero_results = LEAST(search_query_daily.zero_results, 2147483646) + EXCLUDED.zero_results,
            last_result_count = EXCLUDED.last_result_count,
            updated_at = EXCLUDED.updated_at`
      )
    );
    return affected > 0;
  } catch (err) {
    logger.warn({ storeId, code: errCode(err) }, '[SEARCH-LOG] search not counted');
    return false;
  }
}

/**
 * Delete this store's rows older than SEARCH_LOG_RETENTION_DAYS (dates before
 * today − 90 in Cairo). Runs in the store's own scope. Returns the number of rows deleted.
 */
export async function purgeSearchLog(storeId: string, now: Date = new Date()): Promise<number> {
  const cutoff = isoDayMinus(searchLogDay(now), SEARCH_LOG_RETENTION_DAYS);
  const money = await analyticsMoney(storeId, 'write');
  if (money) return (await money.searchLogPurge({ cutoffMs: dayMs(cutoff) })).deleted;
  return withStore(
    storeId,
    tx => tx.$executeRaw`
      DELETE FROM search_query_daily WHERE store_id = ${storeId} AND date < ${cutoff}::date`
  );
}

/**
 * The retention sweep: `purgeSearchLog` for every store (soft-deleted ones included), each in
 * its own tenant transaction. One failing store never stops the rest: its failure is logged
 * (store id + error code only) and counted, and the sweep carries on.
 */
export async function purgeSearchLogAcrossStores(
  opts: { storeIds?: string[]; now?: Date } = {}
): Promise<{ purged: number; failedStores: number }> {
  // Ruling NZ-AN-1: every store, Durable Object stores included (a DO store is purged in its own DO once its analytics moved,
  // else in Postgres like any store). `runInStoreCtx` opens the Postgres tenant transaction only for a Postgres store.
  const storeIds =
    opts.storeIds ??
    (await withoutHiddenStores(() => storeDirectory(undefined, { includeDeleted: true }))).map(
      s => s.id
    );
  let failedStores = 0;
  let purged = 0;
  for (const storeId of storeIds) {
    try {
      purged += await runInStoreCtx(storeId, () => purgeSearchLog(storeId, opts.now));
    } catch (err) {
      failedStores += 1;
      logger.error({ storeId, code: errCode(err) }, '[SEARCH-LOG] purge failed for store');
    }
  }
  return { purged, failedStores };
}

export type SearchInsightsDays = 7 | 30 | 90;
export type SearchInsightsFilterValue = 'zero' | 'all';

export interface SearchLogInsights {
  days: number;
  totals: { searches: number; zeroResultSearches: number; zeroResultRate: number | null };
  terms: Array<{ term: string; searches: number; zeroResults: number; lastResultCount: number }>;
}

/**
 * Read API for the admin search insights page + the "searches with no results" card (Task 6).
 *
 * Window: the last `days` Cairo days including today. `filter: 'zero'` keeps terms with at
 * least one zero-result search in the window (counting ALL their searches, not only the
 * zero-result days), ordered by zero-result searches; `'all'` orders by searches. Top 50.
 * Privacy floor (Ruling SEARCH-T5-6): a term is listed only when it was searched at least
 * SEARCH_LOG_MIN_SEARCHES_SHOWN times in the window, so a one-off pasted name or address never
 * shows; the totals still count every search.
 * `lastResultCount` is the result count of the term's most recent search. `zeroResultRate`
 * is null when there were no searches (unknown is never shown as 0%).
 */
export async function getSearchInsights(
  storeId: string,
  opts: { days: SearchInsightsDays; filter: SearchInsightsFilterValue; now?: Date }
): Promise<SearchLogInsights> {
  const since = isoDayMinus(searchLogDay(opts.now), opts.days - 1);
  const zeroOnly = opts.filter === 'zero';
  const money = await analyticsMoney(storeId, 'read');
  if (money) {
    const r = await money.searchInsights({
      sinceMs: dayMs(since),
      minShown: SEARCH_LOG_MIN_SEARCHES_SHOWN,
      zeroOnly,
      limit: 50,
    });
    const searches = r.totals.searches;
    return {
      days: opts.days,
      totals: {
        searches,
        zeroResultSearches: r.totals.zero,
        zeroResultRate: searches === 0 ? null : r.totals.zero / searches,
      },
      terms: r.terms.map(t => ({
        term: t.term,
        searches: t.searches,
        zeroResults: t.zero_results,
        lastResultCount: t.last_result_count,
      })),
    };
  }
  return withStore(storeId, async tx => {
    const [totals] = await tx.$queryRaw<Array<{ searches: number; zero: number }>>`
      SELECT COALESCE(SUM(searches), 0)::int AS searches, COALESCE(SUM(zero_results), 0)::int AS zero
      FROM search_query_daily
      WHERE store_id = ${storeId} AND date >= ${since}::date`;
    const terms = await tx.$queryRaw<
      Array<{ term: string; searches: number; zero_results: number; last_result_count: number }>
    >`
      SELECT term,
             SUM(searches)::int AS searches,
             SUM(zero_results)::int AS zero_results,
             (array_agg(last_result_count ORDER BY date DESC))[1] AS last_result_count
      FROM search_query_daily
      WHERE store_id = ${storeId} AND date >= ${since}::date
      GROUP BY term
      HAVING SUM(searches) >= ${SEARCH_LOG_MIN_SEARCHES_SHOWN}
         AND (${!zeroOnly}::boolean OR SUM(zero_results) > 0)
      ORDER BY CASE WHEN ${zeroOnly}::boolean THEN SUM(zero_results) ELSE SUM(searches) END DESC,
               SUM(searches) DESC, term ASC
      LIMIT 50`;
    const searches = totals?.searches ?? 0;
    const zero = totals?.zero ?? 0;
    return {
      days: opts.days,
      totals: {
        searches,
        zeroResultSearches: zero,
        zeroResultRate: searches === 0 ? null : zero / searches,
      },
      terms: terms.map(t => ({
        term: t.term,
        searches: t.searches,
        zeroResults: t.zero_results,
        lastResultCount: t.last_result_count,
      })),
    };
  });
}
