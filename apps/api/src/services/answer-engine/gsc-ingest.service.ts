/**
 * GSC daily ingestion — the per-store work (Plan 8B, Task 3).
 *
 * `runGscIngest` is deliberately split OUT of the Inngest cron/on-demand
 * functions (mirrors `runCitationScan` in citation-scan.service.ts) so it's
 * fully testable without a running Inngest server or a live Google API:
 * tests inject a mock `client` and assert on the `GscDailyMetric` row it
 * upserts.
 *
 * Flow, per store:
 *   1. Load `store.domain`. No domain → `{ skipped: 'no_domain' }` (GSC
 *      properties are keyed by domain; nothing to query).
 *   2. Resolve the target date — defaults to YESTERDAY (UTC, `YYYY-MM-DD`).
 *      GSC data typically lags 2-3 days behind real-time, so "yesterday"
 *      will often come back thin/zeroed for the first day or two after a
 *      query hits a freshly-indexed property; this is expected for v1 and
 *      self-corrects as the upsert re-runs on subsequent days.
 *   3. Try each GSC property URL form from `gscSiteUrlsForDomain(domain)` in
 *      order (`sc-domain:` then `https://.../`) — Search Console access is
 *      granted per-property-form, so a service account may have access to
 *      one form and not the other. On `GscNoAccessError` for a given form,
 *      try the next; if EVERY form is inaccessible → `{ skipped: 'no_access'
 *      }` (recorded via a log line, no DB row written). Any OTHER error
 *      (network, auth, config) propagates to the caller — the Inngest cron's
 *      per-store wrapper (`ingestStoreGsc`) catches it and isolates the
 *      failure to that one store (fail-soft contract), it is not swallowed
 *      here.
 *   4. UPSERT one `GscDailyMetric` row on `(storeId, date)` — idempotent:
 *      re-running the same day overwrites the existing row instead of
 *      creating a duplicate (enforced by the `@@unique([storeId, date])`
 *      constraint from Task 1).
 *
 * The GSC client is INJECTABLE via `opts.client` (defaults to the real
 * `gsc-client` module functions) so integration tests never make a live GSC
 * call — see tests/integration/answer-engine/gsc-ingest.test.ts.
 */
import { prisma, Prisma } from '@ebda/database';
import { storeDb } from '../../lib/repo-factory';
import { analyticsWrite } from '../../lib/analytics-backend';
import logger from '../../lib/logger';
import {
  gscSiteUrlsForDomain,
  querySearchAnalytics,
  GscNoAccessError,
  type GscResult,
} from './gsc-client';

/** The subset of the gsc-client module `runGscIngest` depends on — narrowed
 * to an interface so tests can inject a mock without importing the real
 * module's internals. */
export interface GscClientLike {
  gscSiteUrlsForDomain: (domain: string) => string[];
  querySearchAnalytics: (siteUrl: string, startDate: string, endDate: string) => Promise<GscResult>;
}

const defaultClient: GscClientLike = { gscSiteUrlsForDomain, querySearchAnalytics };

/** Yesterday, UTC, as `YYYY-MM-DD` — the default ingestion target date. */
function yesterdayUtc(): string {
  const now = new Date();
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)
  );
  return yesterday.toISOString().slice(0, 10);
}

export interface RunGscIngestResult {
  /** Set when nothing was ingested for this store: no domain configured, or
   * the GSC service account has no access to any property form for this
   * domain on this date. Undefined on a successful upsert. */
  skipped?: 'no_domain' | 'no_access';
  /** The `YYYY-MM-DD` date targeted (always set, even on skip, so callers
   * can log which date was attempted). */
  date: string;
}

export interface RunGscIngestOptions {
  /** Injectable for tests — defaults to the real gsc-client module
   * functions. Tests pass a mock so no live Google API call is ever made. */
  client?: GscClientLike;
  /** Target date override (`YYYY-MM-DD`), defaults to yesterday (UTC). */
  date?: string;
}

export async function runGscIngest(
  storeId: string,
  opts: RunGscIngestOptions = {}
): Promise<RunGscIngestResult> {
  const client = opts.client ?? defaultClient;
  const date = opts.date ?? yesterdayUtc();

  const store = await (
    await storeDb(storeId)
  ).store.findUnique({
    where: { id: storeId },
    select: { domain: true },
  });

  if (!store?.domain) {
    logger.info({ storeId, date }, 'gsc-ingest: store has no domain configured, skipping');
    return { skipped: 'no_domain', date };
  }

  const siteUrls = client.gscSiteUrlsForDomain(store.domain);

  let result: GscResult | undefined;
  for (const siteUrl of siteUrls) {
    try {
      // Properties are tried in order; we stop at the first that succeeds,
      // so this is intentionally sequential rather than a parallel
      // Promise.all.
      result = await client.querySearchAnalytics(siteUrl, date, date);
      break;
    } catch (err) {
      if (err instanceof GscNoAccessError) {
        // Try the next property URL form.
        continue;
      }
      // Any other error (network/auth/config) is not this function's to
      // swallow — the cron's per-store wrapper isolates it.
      throw err;
    }
  }

  if (!result) {
    logger.info(
      { storeId, date, siteUrls },
      'gsc-ingest: no GSC property access for any site URL form, skipping'
    );
    return { skipped: 'no_access', date };
  }

  const dateRow = result.dateRows.find(row => row.date === date) ?? result.dateRows[0];
  const impressions = dateRow?.impressions ?? 0;
  const clicks = dateRow?.clicks ?? 0;
  const ctr = dateRow?.ctr ?? 0;
  const position = dateRow?.position ?? 0;

  const upsertArgs = {
    where: { storeId_date: { storeId, date: new Date(`${date}T00:00:00.000Z`) } },
    create: {
      storeId,
      date: new Date(`${date}T00:00:00.000Z`),
      impressions,
      clicks,
      ctr,
      position,
      topQueries: result.topQueries as unknown as Prisma.InputJsonValue,
    },
    update: {
      impressions,
      clicks,
      ctr,
      position,
      topQueries: result.topQueries as unknown as Prisma.InputJsonValue,
    },
  };
  // Ruling NZ-AN-1: the store's DO once its analytics moved, else Postgres (the ambient tenant transaction)
  await analyticsWrite(
    storeId,
    w => w.gscDailyMetric.upsert(upsertArgs),
    () => prisma.gscDailyMetric.upsert(upsertArgs)
  );

  return { date };
}
