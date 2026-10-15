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
 * terms searched at least SEARCH_LOG_MIN_SEARCHES_SHOWN times).
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
import { acrossStores, storeDirectory, withStore } from '@ebda/database';
import { normalizeArabicSearch, REGION, zonedIsoDay } from '@ebda/shared';
import logger from '../lib/logger';
import { withSavepoint } from '../lib/savepoint';

export const SEARCH_LOG_RETENTION_DAYS = 90;
/** Distinct terms one store may add per Cairo day (soft: concurrent inserts can pass it by a few). */
export const SEARCH_LOG_MAX_TERMS_PER_DAY = 1000;
/** Stored term length, in code points (VARCHAR(100)). */
export const SEARCH_LOG_TERM_MAX = 100;
/** Raw input longer than this is not a search anyone typed: never stored. */
const SEARCH_LOG_RAW_MAX = 1000;
/**
 * k-anonymity floor for the read API: a term is listed only when it was searched at least this
 * many times in the window, so a one-off pasted name or address is never shown (Ruling
 * SEARCH-T5-6). Totals still count every search.
 */
export const SEARCH_LOG_MIN_SEARCHES_SHOWN = 2;

const INT4_MAX = 2_147_483_647;

// Every pattern runs on the FOLDED term (`foldSearchLogTerm`): NFKC (fullwidth digits and `＠`
// become ASCII), invisible format characters removed (RLM/LRM/ZWJ/ZWNJ/zero-width space), then
// the search normaliser (Arabic-Indic / Persian digits to ASCII, Latin lower case, single spaces).
/** Any `@` (a half-typed address is still an address). */
const EMAIL_LIKE = /@/;
/**
 * 8+ digits with ANY non-letter between them (space, dash of any kind, slash, underscore,
 * comma, dot, brackets): a phone (local, +20, 0020) or a 14-digit national id.
 */
const PHONE_LIKE = /\d(?:[^\p{L}\d]*\d){7,}/u;
/** Order numbers: `ORD<sep><base36 secs>…` and the legacy `ORD-<ms>-<hex>`, any separator. */
const ORDER_NUMBER_LIKE = /(?:^|[^\p{L}\d])ord[^\p{L}\d]+[a-z\d]{5,}/u;
/** WhatsApp payment-link order numbers `WA<sep><6+ with a digit><sep><5+>` (stricter: "wa" is a Franco word). */
const WA_ORDER_NUMBER_LIKE =
  /(?:^|[^\p{L}\d])wa[^\p{L}\d]+(?=[a-z]*\d)[a-z\d]{6,}[^\p{L}\d]+[a-z\d]{5,}/u;
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
/** Links can carry tokens and tracking ids. */
const URL_LIKE = /:\/\/|(?:^|\s)www\./;
/** Invisible format characters (bidi marks, zero-width joiners/spaces, soft hyphen). */
const FORMAT_CHARS = /\p{Cf}/gu;

/** A 20+ char letters-and-digits run that is mostly random: a cuid, a hex token, a payment reference. */
function hasIdLikeToken(norm: string): boolean {
  for (const tok of norm.split(/[\s/?&=#]+/)) {
    if (tok.length < 20 || !/^[a-z0-9_-]+$/.test(tok)) continue;
    if (/^[0-9a-f_-]+$/.test(tok) && /\d/.test(tok)) return true; // hex token
    const digits = tok.replace(/[^0-9]/g, '').length;
    if (/[a-z]/.test(tok) && digits / tok.length >= 0.2) return true;
  }
  return false;
}

/**
 * The one folding both the PII gate and the stored value use, so they can never disagree:
 * NFKC, strip invisible format characters, then the shared search normaliser.
 */
export function foldSearchLogTerm(raw: string): string {
  return normalizeArabicSearch((raw ?? '').normalize('NFKC').replace(FORMAT_CHARS, ''));
}

/**
 * True for a term that may identify a person or an order: an email, a phone or national id
 * (in any digit script, with any separators or invisible marks), an order number, an
 * id/token, or a link. Such a term is never stored. Folds first (E3), so it is safe on a raw
 * or an already-folded term.
 */
export function isPersonalDataTerm(term: string): boolean {
  const norm = foldSearchLogTerm(term);
  return (
    EMAIL_LIKE.test(norm) ||
    PHONE_LIKE.test(norm) ||
    ORDER_NUMBER_LIKE.test(norm) ||
    WA_ORDER_NUMBER_LIKE.test(norm) ||
    UUID_LIKE.test(norm) ||
    URL_LIKE.test(norm) ||
    hasIdLikeToken(norm)
  );
}

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
  const storeIds =
    opts.storeIds ?? (await storeDirectory(undefined, { includeDeleted: true })).map(s => s.id);
  let failedStores = 0;
  const results = await acrossStores(storeId => purgeSearchLog(storeId, opts.now), {
    storeIds,
    onStoreError: (storeId, err) => {
      failedStores += 1;
      logger.error({ storeId, code: errCode(err) }, '[SEARCH-LOG] purge failed for store');
    },
  });
  return { purged: results.reduce((n, r) => n + r.value, 0), failedStores };
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
