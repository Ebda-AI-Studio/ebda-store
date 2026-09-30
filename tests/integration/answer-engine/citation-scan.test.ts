/**
 * Integration tests for Task 6 — the answer-engine citation scan
 * (`runCitationScan`) + buyer-intent prompt generation (`generatePrompts`).
 *
 * Requires a real Postgres DB (via DATABASE_URL) — no HTTP server, no live
 * LLM API. Mirrors the harness pattern of
 * tests/integration/accounting/reorder-scan.test.ts: connects to `prisma`
 * directly and calls the service functions under test, injecting MOCK
 * providers so `runCitationScan` never touches a real Gemini/Perplexity/
 * OpenAI endpoint.
 *
 * Covers:
 *   1. `generatePrompts` returns EN+AR buyer-intent prompts derived from a
 *      seeded category + product.
 *   2. `runCitationScan` writes an `AnswerEngineCheck` with `cited=true` for
 *      a mock answer citing the store's own domain.
 *   3. A mock answer citing only a competitor → `cited=false`,
 *      `competitorUrls` populated.
 *   4. A provider that THROWS is caught — that engine is skipped
 *      (`provider_error`), other engines still write their rows, and
 *      `runCitationScan` never throws.
 *   5. Budget guard: a paid engine already at its daily cap (seeded
 *      `aiUsage` rows) is skipped (`budget_cap_reached`) BEFORE any call —
 *      the mock provider is never invoked.
 *   6. Feature gate: mirroring the cron/on-demand handlers' own
 *      `featureService.isFeatureEnabled` check — a store without
 *      `answer_engine_insights` is skipped, zero rows written, and the
 *      provider is never queried.
 *   7. Money-path fix wave (2026-07-22):
 *      - C1: `isPaidEngineOverBudget` aggregates `aiUsage` rows ACROSS ALL
 *        stores, even when called from INSIDE a tenant context (proving the
 *        `withRlsBypass` fix — a per-tenant-scoped count would only see the
 *        current store's rows and under-count).
 *      - I2: the on-demand handler's plan gate mirrors the cron's
 *        `aiEligiblePlanFilter` — a `free`-plan store with a super-admin
 *        `StoreFeature` override force-enabling `answer_engine_insights` is
 *        still skipped (no provider call, zero rows) because `free` is AI
 *        ineligible.
 *   8. Whole-branch fix wave (2026-07-22) — cron per-store isolation:
 *      `scanStoreCitations` (the exact body the weekly cron's
 *      `step.run` wraps per store) catches a throw from the pre-loop
 *      `featureService.isFeatureEnabled` check and returns a
 *      `{ skipped: 'error' }` marker instead of propagating — proving one
 *      store's failure cannot abort the cron loop before it reaches the
 *      next store.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, withRlsBypass, runInTenantContext } from '@force/database';
import { generatePrompts } from '../../../apps/api/src/services/answer-engine/prompts';
import { runCitationScan } from '../../../apps/api/src/services/answer-engine/citation-scan.service';
import { isPaidEngineOverBudget } from '../../../apps/api/src/services/answer-engine/budget';
import type {
  AnswerEngineProvider,
  EngineAnswer,
} from '../../../apps/api/src/services/answer-engine/provider';
import { featureService } from '../../../apps/api/src/services/feature.service';
import { isAiEligiblePlan } from '../../../apps/api/src/lib/ai-plan-eligibility';
import { scanStoreCitations } from '../../../apps/api/src/lib/inngest/functions/answer-engine-citation-scan';

// Dedicated owner UUID — isolated from other integration suites.
const OWNER = '00000000-0000-0000-0000-0000000000ae';

let storeId: string;
let noFeatureStoreId: string;
let freePlanStoreId: string;

function mockProvider(
  engine: string,
  impl: (storeId: string, prompt: string) => Promise<EngineAnswer>
): AnswerEngineProvider & { queryMock: ReturnType<typeof vi.fn> } {
  const queryMock = vi.fn(impl);
  return { engine, query: queryMock, queryMock };
}

const FIXED_PROMPTS = [{ text: 'best gadgets in Kuwait', locale: 'en' as const }];

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `aei-scan-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'A',
      lastName: 'E',
    },
  });

  const s = await prisma.store.create({
    data: {
      name: `AEI Scan Test Store ${Date.now()}`,
      slug: `aei-scan-test-${Date.now()}`,
      domain: `aei-scan-test-${Date.now()}.example.com`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
      plan: 'starter', // answer_engine_insights is default-ON for every paid plan
    },
  });
  storeId = s.id;

  await prisma.category.create({
    data: {
      storeId,
      name: 'Gadgets',
      nameAr: 'أجهزة',
      slug: `gadgets-${Date.now()}`,
      isActive: true,
    },
  });
  await prisma.product.create({
    data: {
      storeId,
      name: 'Smart Widget',
      nameAr: 'ودجت ذكي',
      slug: `smart-widget-${Date.now()}`,
      price: 5000,
      status: 'active',
      isBestSeller: true,
    },
  });

  // A second store, entitled by plan, with an explicit override disabling
  // the feature — the "not entitled" fixture for the gate test.
  const noFeatureStore = await prisma.store.create({
    data: {
      name: `AEI No-Feature Store ${Date.now()}`,
      slug: `aei-no-feature-test-${Date.now()}`,
      domain: `aei-no-feature-test-${Date.now()}.example.com`,
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

  // I2 fixture: a `free`-plan store (AI-ineligible) with a super-admin
  // `StoreFeature` override that FORCE-ENABLES `answer_engine_insights`.
  // `featureService.isFeatureEnabled` alone would say "enabled" here — the
  // plan gate is the only thing that should stop the on-demand handler.
  const freePlanStore = await prisma.store.create({
    data: {
      name: `AEI Free Plan Store ${Date.now()}`,
      slug: `aei-free-plan-test-${Date.now()}`,
      domain: `aei-free-plan-test-${Date.now()}.example.com`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
      plan: 'free',
    },
  });
  freePlanStoreId = freePlanStore.id;
  await prisma.storeFeature.create({
    data: {
      storeId: freePlanStoreId,
      featureKey: 'answer_engine_insights',
      enabled: true,
    },
  });
});

afterAll(async () => {
  await prisma.answerEngineCheck
    .deleteMany({ where: { storeId: { in: [storeId, noFeatureStoreId, freePlanStoreId] } } })
    .catch(() => {});
  await prisma.aiUsage
    .deleteMany({ where: { storeId: { in: [storeId, noFeatureStoreId, freePlanStoreId] } } })
    .catch(() => {});
  await prisma.storeFeature
    .deleteMany({ where: { storeId: { in: [noFeatureStoreId, freePlanStoreId] } } })
    .catch(() => {});
  await prisma.product.deleteMany({ where: { storeId } }).catch(() => {});
  await prisma.category.deleteMany({ where: { storeId } }).catch(() => {});
  await prisma.store
    .deleteMany({ where: { id: { in: [storeId, noFeatureStoreId, freePlanStoreId] } } })
    .catch(() => {});
  // Leave the upserted user row — other suites may reuse it.
});

describe('generatePrompts', () => {
  it('returns EN+AR buyer-intent prompts derived from seeded categories/products', async () => {
    const prompts = await generatePrompts(storeId);

    expect(prompts.length).toBeGreaterThan(0);

    const en = prompts.filter(p => p.locale === 'en');
    const ar = prompts.filter(p => p.locale === 'ar');
    expect(en.length).toBeGreaterThan(0);
    expect(ar.length).toBeGreaterThan(0);

    expect(prompts.some(p => p.locale === 'en' && p.text.includes('Gadgets'))).toBe(true);
    expect(prompts.some(p => p.locale === 'ar' && p.text.includes('أجهزة'))).toBe(true);
    expect(prompts.some(p => p.locale === 'en' && p.text.includes('Smart Widget'))).toBe(true);
    expect(prompts.some(p => p.locale === 'ar' && p.text.includes('ودجت ذكي'))).toBe(true);
  });
});

describe('runCitationScan', () => {
  it('writes an AnswerEngineCheck with cited=true when the mock answer cites the store domain', async () => {
    const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });

    const citing = mockProvider('gemini', async () => ({
      text: 'You can find great gadgets at this store.',
      citedUrls: [`https://${store.domain}/best-gadgets`],
      grounded: true,
    }));

    const results = await runCitationScan(storeId, {
      providers: [citing],
      prompts: FIXED_PROMPTS,
    });

    expect(results).toEqual([{ engine: 'gemini', checks: 1 }]);
    expect(citing.queryMock).toHaveBeenCalledTimes(1);

    const rows = await prisma.answerEngineCheck.findMany({ where: { storeId, engine: 'gemini' } });
    expect(rows.length).toBe(1);
    expect(rows[0].cited).toBe(true);
    expect(rows[0].promptText).toBe(FIXED_PROMPTS[0].text);
    expect(rows[0].locale).toBe('en');
  });

  it('a mock answer citing only a competitor → cited=false, competitorUrls populated', async () => {
    const competitorCiting = mockProvider('gemini', async () => ({
      text: 'Competitor Store has the best gadgets.',
      citedUrls: ['https://competitor-store.example'],
      grounded: true,
    }));

    await prisma.answerEngineCheck.deleteMany({ where: { storeId, engine: 'gemini' } });

    const results = await runCitationScan(storeId, {
      providers: [competitorCiting],
      prompts: FIXED_PROMPTS,
    });
    expect(results).toEqual([{ engine: 'gemini', checks: 1 }]);

    const rows = await prisma.answerEngineCheck.findMany({ where: { storeId, engine: 'gemini' } });
    expect(rows.length).toBe(1);
    expect(rows[0].cited).toBe(false);
    expect(rows[0].competitorUrls).toEqual(['https://competitor-store.example']);
  });

  it('a throwing provider is fail-soft skipped; other engines still write; no throw out of runCitationScan', async () => {
    await prisma.answerEngineCheck.deleteMany({ where: { storeId } });

    const throwing = mockProvider('openai', async () => {
      throw new Error('simulated provider outage');
    });
    const working = mockProvider('gemini', async () => ({
      text: 'Answer text',
      citedUrls: [],
      grounded: false,
    }));

    let results: Awaited<ReturnType<typeof runCitationScan>> | undefined;
    await expect(
      (async () => {
        results = await runCitationScan(storeId, {
          providers: [throwing, working],
          prompts: FIXED_PROMPTS,
        });
      })()
    ).resolves.not.toThrow();

    expect(results).toEqual([
      { engine: 'openai', checks: 0, skipped: 'provider_error' },
      { engine: 'gemini', checks: 1 },
    ]);

    const rows = await prisma.answerEngineCheck.findMany({ where: { storeId } });
    expect(rows.length).toBe(1);
    expect(rows[0].engine).toBe('gemini');
  });

  it('a paid engine already at its daily budget cap is skipped without ever calling the provider', async () => {
    process.env.ANSWER_ENGINE_OPENAI_DAILY_CAP = '2';
    await prisma.aiUsage.deleteMany({ where: { storeId, feature: 'answer_engine_openai' } });
    await prisma.answerEngineCheck.deleteMany({ where: { storeId, engine: 'openai' } });

    // Seed exactly the cap's worth of today's usage rows.
    await prisma.aiUsage.createMany({
      data: [
        { storeId, feature: 'answer_engine_openai', inputTokens: 0, outputTokens: 0 },
        { storeId, feature: 'answer_engine_openai', inputTokens: 0, outputTokens: 0 },
      ],
    });

    const openai = mockProvider('openai', async () => ({
      text: 'should never be called',
      citedUrls: [],
    }));

    const results = await runCitationScan(storeId, {
      providers: [openai],
      prompts: FIXED_PROMPTS,
    });

    expect(results).toEqual([{ engine: 'openai', checks: 0, skipped: 'budget_cap_reached' }]);
    expect(openai.queryMock).not.toHaveBeenCalled();

    const rows = await prisma.answerEngineCheck.findMany({ where: { storeId, engine: 'openai' } });
    expect(rows.length).toBe(0);

    delete process.env.ANSWER_ENGINE_OPENAI_DAILY_CAP;
  });
});

describe('feature gate (mirrors the cron/on-demand handlers)', () => {
  it('a store WITHOUT answer_engine_insights is skipped — the provider is never queried, zero rows written', async () => {
    const enabled = await featureService.isFeatureEnabled(
      noFeatureStoreId,
      'answer_engine_insights'
    );
    expect(enabled).toBe(false);

    const provider = mockProvider('gemini', async () => ({ text: 'x', citedUrls: [] }));

    // Exactly what answerEngineScanOnDemand / answerEngineCitationScanCron do
    // before calling runCitationScan.
    if (enabled) {
      await runCitationScan(noFeatureStoreId, { providers: [provider], prompts: FIXED_PROMPTS });
    }

    expect(provider.queryMock).not.toHaveBeenCalled();
    const rows = await prisma.answerEngineCheck.findMany({ where: { storeId: noFeatureStoreId } });
    expect(rows.length).toBe(0);
  });

  it('an entitled store (default-ON plan baseline, no override) has the feature enabled', async () => {
    const enabled = await featureService.isFeatureEnabled(storeId, 'answer_engine_insights');
    expect(enabled).toBe(true);
  });
});

describe('budget aggregation is platform-wide, not per-store (C1)', () => {
  it("isPaidEngineOverBudget sees usage aggregated across ALL stores, even when called from inside one store's tenant context", async () => {
    process.env.ANSWER_ENGINE_PERPLEXITY_DAILY_CAP = '2';
    await prisma.aiUsage.deleteMany({ where: { feature: 'answer_engine_perplexity' } });

    // Seed the cap's worth of usage split across TWO different stores —
    // neither store alone reaches the cap (1 row each), only the aggregate
    // does. A per-tenant-scoped count (the pre-fix RLS-filtered bug) would
    // see only ONE of these rows from inside either store's tenant context
    // and incorrectly report "under budget".
    await prisma.aiUsage.createMany({
      data: [
        { storeId, feature: 'answer_engine_perplexity', inputTokens: 0, outputTokens: 0 },
        {
          storeId: noFeatureStoreId,
          feature: 'answer_engine_perplexity',
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
    });

    // Called with no tenant context set (e.g. bare test invocation).
    const overBudgetNoContext = await isPaidEngineOverBudget('perplexity');
    expect(overBudgetNoContext).toBe(true);

    // Called from INSIDE `storeId`'s tenant context — exactly how the real
    // cron invokes it (`runInTenantContext(store.id, () =>
    // runCitationScan(store.id))` → `isPaidEngineOverBudget` inside). If the
    // count were tenant-scoped, `storeId` alone only has 1 of the 2 seeded
    // rows (under the cap of 2) and this would wrongly return `false`.
    const overBudgetInsideStoreId = await runInTenantContext(storeId, () =>
      isPaidEngineOverBudget('perplexity')
    );
    expect(overBudgetInsideStoreId).toBe(true);

    // Same proof from the OTHER store's tenant context — the count must be
    // identical (store-independent) in both directions.
    const overBudgetInsideNoFeatureStoreId = await runInTenantContext(noFeatureStoreId, () =>
      isPaidEngineOverBudget('perplexity')
    );
    expect(overBudgetInsideNoFeatureStoreId).toBe(true);

    await prisma.aiUsage.deleteMany({ where: { feature: 'answer_engine_perplexity' } });
    delete process.env.ANSWER_ENGINE_PERPLEXITY_DAILY_CAP;
  });

  it('runCitationScan run from inside a tenant context still skips a paid engine over the AGGREGATE budget', async () => {
    process.env.ANSWER_ENGINE_PERPLEXITY_DAILY_CAP = '1';
    await prisma.aiUsage.deleteMany({ where: { feature: 'answer_engine_perplexity' } });
    await prisma.answerEngineCheck.deleteMany({ where: { engine: 'perplexity' } });

    // The cap's single row lives on the OTHER store, not `storeId` — proves
    // the scan (run inside `storeId`'s tenant context, like the cron does)
    // is stopped by spend that happened anywhere on the platform.
    await prisma.aiUsage.create({
      data: {
        storeId: noFeatureStoreId,
        feature: 'answer_engine_perplexity',
        inputTokens: 0,
        outputTokens: 0,
      },
    });

    const perplexity = mockProvider('perplexity', async () => ({
      text: 'should never be called',
      citedUrls: [],
    }));

    const results = await runInTenantContext(storeId, () =>
      runCitationScan(storeId, { providers: [perplexity], prompts: FIXED_PROMPTS })
    );

    expect(results).toEqual([{ engine: 'perplexity', checks: 0, skipped: 'budget_cap_reached' }]);
    expect(perplexity.queryMock).not.toHaveBeenCalled();

    await prisma.aiUsage.deleteMany({ where: { feature: 'answer_engine_perplexity' } });
    delete process.env.ANSWER_ENGINE_PERPLEXITY_DAILY_CAP;
  });
});

describe('on-demand plan gate mirrors the cron (I2)', () => {
  it('a free-plan store with a StoreFeature override force-enabling answer_engine_insights is still skipped — no provider call, zero rows', async () => {
    // The feature-flag check alone says "enabled" (the override forces it).
    const enabled = await featureService.isFeatureEnabled(
      freePlanStoreId,
      'answer_engine_insights'
    );
    expect(enabled).toBe(true);

    // Exactly what `answerEngineScanOnDemand`'s plan gate does: load the
    // store's plan via `withRlsBypass` and check `isAiEligiblePlan`.
    const store = await withRlsBypass(tx =>
      tx.store.findUnique({ where: { id: freePlanStoreId }, select: { plan: true } })
    );
    expect(store?.plan).toBe('free');
    const planEligible = !!store && isAiEligiblePlan(store.plan);
    expect(planEligible).toBe(false);

    const provider = mockProvider('gemini', async () => ({ text: 'x', citedUrls: [] }));

    // Mirrors the on-demand handler's gate sequence: feature check, THEN
    // plan check, only running the scan if BOTH pass.
    if (enabled && planEligible) {
      await runCitationScan(freePlanStoreId, {
        providers: [provider],
        prompts: FIXED_PROMPTS,
      });
    }

    expect(provider.queryMock).not.toHaveBeenCalled();
    const rows = await prisma.answerEngineCheck.findMany({ where: { storeId: freePlanStoreId } });
    expect(rows.length).toBe(0);
  });

  it('an AI-eligible plan (starter, no override) passes the plan gate', async () => {
    const store = await withRlsBypass(tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { plan: true } })
    );
    expect(store?.plan).toBe('starter');
    expect(isAiEligiblePlan(store!.plan)).toBe(true);
  });
});

describe('scanStoreCitations — cron per-store isolation (whole-branch fix wave, 2026-07-22)', () => {
  // Arbitrary UUID — never touches the DB in this test: the mocked
  // `isFeatureEnabled` throws before any store lookup would happen, so it
  // doesn't need to be a real seeded store.
  const failingStoreId = '00000000-0000-0000-0000-0000000000af';

  it(
    'store A throwing on the pre-loop feature check is isolated ' +
      '(returns skipped: "error", never throws) — store B still gets scanned and its rows written',
    async () => {
      await prisma.answerEngineCheck.deleteMany({ where: { storeId, engine: 'gemini' } });

      const isFeatureEnabledSpy = vi
        .spyOn(featureService, 'isFeatureEnabled')
        .mockImplementation(async (sId: string) => {
          if (sId === failingStoreId) {
            throw new Error('simulated feature-service outage for store A');
          }
          return true;
        });

      try {
        // Store A (first in the cron's for-loop) — the pre-loop feature
        // check throws. `scanStoreCitations` must catch it and return an
        // error marker rather than let it propagate out of `step.run`.
        let resultA: Awaited<ReturnType<typeof scanStoreCitations>> | undefined;
        await expect(
          (async () => {
            resultA = await scanStoreCitations(failingStoreId);
          })()
        ).resolves.not.toThrow();
        expect(resultA).toEqual({
          storeId: failingStoreId,
          skipped: 'error',
          checks: 0,
          ungroundedChecks: 0,
        });

        // Store B (the NEXT store the cron loop would reach) — proves store
        // A's throw did not abort anything beyond its own step: B is scanned
        // normally and its AnswerEngineCheck row is written.
        const working = mockProvider('gemini', async () => ({
          text: 'Answer text',
          citedUrls: [],
          grounded: false,
        }));
        const resultB = await scanStoreCitations(storeId, {
          providers: [working],
          prompts: FIXED_PROMPTS,
        });
        expect(resultB).toEqual({ storeId, skipped: false, checks: 1, ungroundedChecks: 0 });
        expect(working.queryMock).toHaveBeenCalledTimes(1);

        const rows = await prisma.answerEngineCheck.findMany({
          where: { storeId, engine: 'gemini' },
        });
        expect(rows.length).toBe(1);
      } finally {
        isFeatureEnabledSpy.mockRestore();
      }
    }
  );
});
