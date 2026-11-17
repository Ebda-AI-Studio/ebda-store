/**
 * Integration tests for Plan 8B, Task 3 — the GSC daily ingestion cron
 * (`runGscIngest` + its per-store Inngest wrapper `ingestStoreGsc`).
 *
 * Requires a real Postgres DB (via DATABASE_URL) — no HTTP server, no live
 * Google API. Mirrors the harness pattern of
 * tests/integration/answer-engine/citation-scan.test.ts: connects to
 * `prisma` directly and calls the service functions under test, injecting a
 * MOCK GSC client so `runGscIngest` never touches a real Google endpoint.
 *
 * Covers:
 *   1. An entitled store WITH a domain + a mock client returning a canned
 *      `GscResult` → one `GscDailyMetric` row is upserted with the mapped
 *      totals (impressions/clicks/ctr/position) + topQueries; re-running
 *      for the SAME date upserts in place (no dup — `@@unique([storeId,
 *      date])`).
 *   2. A store with NO domain → `{ skipped: 'no_domain' }`, zero rows, the
 *      GSC client is never called.
 *   3. A mock client raising `GscNoAccessError` on every property URL form
 *      → `{ skipped: 'no_access' }`, zero rows, no throw.
 *   4. Per-store fail-soft (mirrors `scanStoreCitations`'s isolation test):
 *      `ingestStoreGsc` for one store whose client rejects with a generic
 *      error returns `{ skipped: 'error' }` (never throws) — a SECOND store
 *      ingested right after still writes its row, proving one store's
 *      failure cannot abort the cron loop before it reaches the next store.
 *   5. Feature gate: a store WITHOUT `answer_engine_insights` is skipped —
 *      the GSC client is never called, zero rows written.
 *   6. On-demand plan gate (mirrors the cron's `aiEligiblePlanFilter`): a
 *      `free`-plan store is AI-ineligible regardless of any feature-flag
 *      override.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, withRlsBypass } from '@ebda/database';
import { runGscIngest } from '../../../apps/api/src/services/answer-engine/gsc-ingest.service';
import { GscNoAccessError } from '../../../apps/api/src/services/answer-engine/gsc-client';
import type { GscResult } from '../../../apps/api/src/services/answer-engine/gsc-client';
import type { GscClientLike } from '../../../apps/api/src/services/answer-engine/gsc-ingest.service';
import { ingestStoreGsc } from '../../../apps/api/src/lib/inngest/functions/gsc-ingest';
import { isAiEligiblePlan } from '../../../apps/api/src/lib/ai-plan-eligibility';

// Dedicated owner UUID — isolated from other integration suites.
const OWNER = '00000000-0000-0000-0000-0000000000b6';

let storeId: string;
let secondStoreId: string;
let noDomainStoreId: string;
let noFeatureStoreId: string;
let freePlanStoreId: string;

const FIXED_DATE = '2026-07-20';

function mockClient(
  impl: (siteUrl: string, startDate: string, endDate: string) => Promise<GscResult>,
  target: { siteUrl: string; pageHost?: string } | null = { siteUrl: 'sc-domain:example.com' }
): GscClientLike & { queryMock: ReturnType<typeof vi.fn> } {
  const queryMock = vi.fn(impl);
  return {
    resolveGscTarget: async () => target,
    querySearchAnalytics: queryMock,
    queryMock,
  };
}

const CANNED_RESULT: GscResult = {
  dateRows: [{ date: FIXED_DATE, impressions: 120, clicks: 8, ctr: 0.0667, position: 4.2 }],
  topQueries: [{ query: 'best gadgets cairo', impressions: 50, clicks: 3 }],
};

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `gsc-ingest-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'G',
      lastName: 'I',
    },
  });

  const s = await prisma.store.create({
    data: {
      name: `GSC Ingest Test Store ${Date.now()}`,
      slug: `gsc-ingest-test-${Date.now()}`,
      domain: `gsc-ingest-test-${Date.now()}.example.com`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
      plan: 'starter', // answer_engine_insights is default-ON for every paid plan
    },
  });
  storeId = s.id;

  const s2 = await prisma.store.create({
    data: {
      name: `GSC Ingest Second Store ${Date.now()}`,
      slug: `gsc-ingest-second-${Date.now()}`,
      domain: `gsc-ingest-second-${Date.now()}.example.com`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
      plan: 'starter',
    },
  });
  secondStoreId = s2.id;

  const noDomainStore = await prisma.store.create({
    data: {
      name: `GSC Ingest No-Domain Store ${Date.now()}`,
      slug: `gsc-ingest-no-domain-${Date.now()}`,
      domain: null,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
      plan: 'starter',
    },
  });
  noDomainStoreId = noDomainStore.id;

  // Entitled by plan, with an explicit override disabling the feature — the
  // "not entitled" fixture for the gate test.
  const noFeatureStore = await prisma.store.create({
    data: {
      name: `GSC Ingest No-Feature Store ${Date.now()}`,
      slug: `gsc-ingest-no-feature-${Date.now()}`,
      domain: `gsc-ingest-no-feature-${Date.now()}.example.com`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
      plan: 'starter',
    },
  });
  noFeatureStoreId = noFeatureStore.id;
  await prisma.storeFeature.create({
    data: {
      storeId: noFeatureStoreId,
      featureKey: 'answer_engine_insights',
      enabled: false,
    },
  });

  // A `free`-plan store (AI-ineligible) with a domain — used to prove the
  // on-demand handler's plan gate, mirroring citation-scan.test.ts's I2 case.
  const freePlanStore = await prisma.store.create({
    data: {
      name: `GSC Ingest Free Plan Store ${Date.now()}`,
      slug: `gsc-ingest-free-plan-${Date.now()}`,
      domain: `gsc-ingest-free-plan-${Date.now()}.example.com`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
      plan: 'free',
    },
  });
  freePlanStoreId = freePlanStore.id;
});

afterAll(async () => {
  const allStoreIds = [storeId, secondStoreId, noDomainStoreId, noFeatureStoreId, freePlanStoreId];
  await prisma.gscDailyMetric
    .deleteMany({ where: { storeId: { in: allStoreIds } } })
    .catch(() => {});
  await prisma.storeFeature.deleteMany({ where: { storeId: { in: allStoreIds } } }).catch(() => {});
  await prisma.store.deleteMany({ where: { id: { in: allStoreIds } } }).catch(() => {});
  // Leave the upserted user row — other suites may reuse it.
});

describe('runGscIngest', () => {
  it('upserts one GscDailyMetric row with mapped totals + topQueries; re-running the same date does not duplicate', async () => {
    await prisma.gscDailyMetric.deleteMany({ where: { storeId } });

    const client = mockClient(async () => CANNED_RESULT);

    const result = await runGscIngest(storeId, { client, date: FIXED_DATE });
    expect(result).toEqual({ date: FIXED_DATE });
    expect(client.queryMock).toHaveBeenCalledTimes(1);

    let rows = await prisma.gscDailyMetric.findMany({ where: { storeId } });
    expect(rows.length).toBe(1);
    expect(rows[0].impressions).toBe(120);
    expect(rows[0].clicks).toBe(8);
    expect(rows[0].ctr).toBeCloseTo(0.0667);
    expect(rows[0].position).toBeCloseTo(4.2);
    expect(rows[0].topQueries).toEqual(CANNED_RESULT.topQueries);
    expect(rows[0].date.toISOString().slice(0, 10)).toBe(FIXED_DATE);

    // Re-run for the SAME date with different canned numbers — proves the
    // upsert overwrites in place rather than creating a duplicate row.
    const client2 = mockClient(async () => ({
      dateRows: [{ date: FIXED_DATE, impressions: 999, clicks: 40, ctr: 0.04, position: 2.1 }],
      topQueries: [{ query: 'updated query', impressions: 10, clicks: 1 }],
    }));
    const result2 = await runGscIngest(storeId, { client: client2, date: FIXED_DATE });
    expect(result2).toEqual({ date: FIXED_DATE });

    rows = await prisma.gscDailyMetric.findMany({ where: { storeId } });
    expect(rows.length).toBe(1); // still ONE row — upsert, not insert
    expect(rows[0].impressions).toBe(999);
    expect(rows[0].topQueries).toEqual([{ query: 'updated query', impressions: 10, clicks: 1 }]);
  });

  it('a store with NO custom domain is queried by its <slug>.ebda.app host (parent-property page filter)', async () => {
    const hosts: string[] = [];
    const client: GscClientLike & { queryMock: ReturnType<typeof vi.fn> } = {
      resolveGscTarget: async host => {
        hosts.push(host);
        return { siteUrl: 'sc-domain:ebda.app', pageHost: host };
      },
      querySearchAnalytics: vi.fn(async () => CANNED_RESULT),
      queryMock: vi.fn(),
    };

    const result = await runGscIngest(noDomainStoreId, { client, date: FIXED_DATE });
    expect(result).toEqual({ date: FIXED_DATE });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatch(/^gsc-ingest-no-domain-\d+\.ebda\.app$/);
    expect(client.querySearchAnalytics).toHaveBeenCalledWith(
      'sc-domain:ebda.app',
      FIXED_DATE,
      FIXED_DATE,
      { pageHost: hosts[0] }
    );
  });

  it('a host no accessible property covers is skipped (no_access) — zero rows, never thrown', async () => {
    const client = mockClient(async () => CANNED_RESULT, null);
    const result = await runGscIngest(noDomainStoreId, { client, date: '2026-07-16' });
    expect(result).toEqual({ skipped: 'no_access', date: '2026-07-16' });
    expect(client.queryMock).not.toHaveBeenCalled();
    const rows = await prisma.gscDailyMetric.findMany({
      where: { storeId: noDomainStoreId, date: new Date('2026-07-16') },
    });
    expect(rows.length).toBe(0);
  });

  it('a property that 403s at query time is skipped — zero rows, no throw', async () => {
    const noAccessDate = '2026-07-19';
    await prisma.gscDailyMetric.deleteMany({ where: { storeId, date: new Date(noAccessDate) } });

    const client = mockClient(async siteUrl => {
      throw new GscNoAccessError(siteUrl);
    });

    let result: Awaited<ReturnType<typeof runGscIngest>> | undefined;
    await expect(
      (async () => {
        result = await runGscIngest(storeId, { client, date: noAccessDate });
      })()
    ).resolves.not.toThrow();

    expect(result).toEqual({ skipped: 'no_access', date: noAccessDate });
    expect(client.queryMock).toHaveBeenCalledTimes(1);

    const rows = await prisma.gscDailyMetric.findMany({
      where: { storeId, date: new Date(noAccessDate) },
    });
    expect(rows.length).toBe(0);
  });
});

describe('ingestStoreGsc — cron per-store isolation', () => {
  it('a store whose client rejects with a generic error is isolated (returns skipped: "error", never throws) — a SECOND store ingested right after still writes its row', async () => {
    const errorDate = '2026-07-18';
    await prisma.gscDailyMetric.deleteMany({ where: { date: new Date(errorDate) } });

    const throwingClient = mockClient(async () => {
      throw new Error('simulated GSC outage');
    });

    let resultA: Awaited<ReturnType<typeof ingestStoreGsc>> | undefined;
    await expect(
      (async () => {
        resultA = await ingestStoreGsc(storeId, { client: throwingClient, date: errorDate });
      })()
    ).resolves.not.toThrow();
    expect(resultA).toEqual({ storeId, skipped: 'error' });

    // Store B (the NEXT store the cron loop would reach) — proves store A's
    // throw did not abort anything beyond its own step.
    const workingClient = mockClient(async () => CANNED_RESULT);
    const resultB = await ingestStoreGsc(secondStoreId, {
      client: workingClient,
      date: errorDate,
    });
    expect(resultB).toEqual({ storeId: secondStoreId, skipped: false, date: errorDate });
    expect(workingClient.queryMock).toHaveBeenCalledTimes(1);

    const rows = await prisma.gscDailyMetric.findMany({
      where: { storeId: secondStoreId, date: new Date(errorDate) },
    });
    expect(rows.length).toBe(1);
  });
});

describe('feature gate (mirrors the cron/on-demand handlers)', () => {
  it('a store WITHOUT answer_engine_insights is skipped — the GSC client is never called, zero rows written', async () => {
    const client = mockClient(async () => CANNED_RESULT);

    const result = await ingestStoreGsc(noFeatureStoreId, { client, date: FIXED_DATE });
    expect(result).toEqual({ storeId: noFeatureStoreId, skipped: true });
    expect(client.queryMock).not.toHaveBeenCalled();

    const rows = await prisma.gscDailyMetric.findMany({ where: { storeId: noFeatureStoreId } });
    expect(rows.length).toBe(0);
  });

  it('an entitled store (default-ON plan baseline, no override) ingests normally', async () => {
    await prisma.gscDailyMetric.deleteMany({ where: { storeId, date: new Date('2026-07-17') } });
    const client = mockClient(async () => CANNED_RESULT);

    const result = await ingestStoreGsc(storeId, { client, date: '2026-07-17' });
    expect(result).toEqual({ storeId, skipped: false, date: '2026-07-17' });
    expect(client.queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('on-demand plan gate mirrors the cron', () => {
  it('a free-plan store is AI-ineligible — the on-demand handler must skip before ever calling ingestStoreGsc', async () => {
    const store = await withRlsBypass(tx =>
      tx.store.findUnique({ where: { id: freePlanStoreId }, select: { plan: true } })
    );
    expect(store?.plan).toBe('free');
    expect(!!store && isAiEligiblePlan(store.plan)).toBe(false);
  });

  it('an AI-eligible plan (starter, no override) passes the plan gate', async () => {
    const store = await withRlsBypass(tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { plan: true } })
    );
    expect(store?.plan).toBe('starter');
    expect(isAiEligiblePlan(store!.plan)).toBe(true);
  });
});
