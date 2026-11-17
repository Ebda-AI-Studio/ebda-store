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
 *   1. Resolve the store host: verified `store.domain`, else
 *      `<slug>.ebda.app`. No host → `{ skipped: 'no_domain' }`.
 *   2. Resolve the target date — defaults to YESTERDAY (UTC, `YYYY-MM-DD`).
 *      GSC data typically lags 2-3 days behind real-time, so "yesterday"
 *      will often come back thin/zeroed for the first day or two after a
 *      query hits a freshly-indexed property; this is expected for v1 and
 *      self-corrects as the upsert re-runs on subsequent days.
 *   3. `client.resolveGscTarget(host)` picks the most specific property the
 *      service account can see (sites.list, cached): exact `sc-domain:` /
 *      URL-prefix first, else a parent `sc-domain:` property plus a `page`
 *      filter restricted to the host. No match → `{ skipped: 'no_access' }`
 *      (also on a 403 at query time). Any OTHER error propagates to the cron's
 *      per-store wrapper (`ingestStoreGsc`), which isolates it (fail-soft).
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
import { storeHost } from '@ebda/shared';
import {
  resolveGscTarget,
  querySearchAnalytics,
  GscNoAccessError,
  type GscResult,
  type GscTarget,
} from './gsc-client';

/** The subset of the gsc-client module `runGscIngest` depends on — narrowed
 * to an interface so tests can inject a mock without importing the real
 * module's internals. */
export interface GscClientLike {
  /** Most specific accessible property covering the host, or null. */
  resolveGscTarget: (host: string) => Promise<GscTarget | null>;
  querySearchAnalytics: (
    siteUrl: string,
    startDate: string,
    endDate: string,
    opts?: { pageHost?: string }
  ) => Promise<GscResult>;
}

const defaultClient: GscClientLike = { resolveGscTarget, querySearchAnalytics };

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
    select: { domain: true, slug: true },
  });

  // The store's public host: its VERIFIED custom domain, else `<slug>.ebda.app`.
  const host = store?.domain || (store?.slug ? storeHost(store.slug) : null);
  if (!host) {
    logger.info({ storeId, date }, 'gsc-ingest: store has no public host, skipping');
    return { skipped: 'no_domain', date };
  }

  const target = await client.resolveGscTarget(host);
  if (!target) {
    logger.info(
      { storeId, date },
      'gsc-ingest: no accessible GSC property covers this host, skipping'
    );
    return { skipped: 'no_access', date };
  }

  let result: GscResult;
  try {
    result = await client.querySearchAnalytics(
      target.siteUrl,
      date,
      date,
      target.pageHost ? { pageHost: target.pageHost } : undefined
    );
  } catch (err) {
    if (err instanceof GscNoAccessError) {
      // Listed but 403 on query (revoked between list and query): skip.
      logger.info({ storeId, date }, 'gsc-ingest: GSC property no longer accessible, skipping');
      return { skipped: 'no_access', date };
    }
    // Any other error (network/auth/config) is isolated by the cron wrapper.
    throw err;
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
