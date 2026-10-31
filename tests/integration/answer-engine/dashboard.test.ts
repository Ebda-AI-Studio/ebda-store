/**
 * Integration tests for Task 7 — merchant-facing answer-engine dashboard
 * read API (`GET /stores/:storeId/answer-engine/summary`).
 *
 * Requires a real Postgres DB (via DATABASE_URL) and real Redis (via
 * REDIS_URL); hits a real running API server at localhost:4000. Mirrors the
 * harness pattern used by tests/integration/answer-engine/provider-config.test.ts
 * (real login -> real JWT) and tests/integration/feature-flag-enforcement.test.ts
 * (store_admin owning their own store, via prisma.store.create + ownerId).
 *
 * Covers:
 *   1. Correct aggregates for a store with seeded AnswerEngineCheck rows:
 *      per-engine cited count/rate, the grounded caveat (an engine whose
 *      only latest check returned zero citedUrls), the latest per-prompt
 *      win/lose list (with competitorUrls on losses), and a trend bucket.
 *   2. TENANT ISOLATION (required, negative):
 *      a. Store A's summary NEVER contains Store B's rows, even though both
 *         stores have AnswerEngineCheck data seeded at the same time.
 *      b. A store_admin who owns Store B gets 403 (not data) when hitting
 *         Store A's summary endpoint directly.
 *   3. Feature-off store -> 403 FEATURE_DISABLED (this codebase's real
 *      fail-closed gate — see requireFeature in feature-gate.ts; there is no
 *      literal 404 path for a disabled feature anywhere else in this repo).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';
import { API_BASE } from '../../helpers/api-base';
import { identityTokenFor } from '../../helpers/identity-session';

// One knob (TEST_API_URL) configures the whole integration suite; see
// tests/helpers/api-base.ts for why it is not the server's own API_URL.
const API_URL = API_BASE;

const PW = 'Test1234!pw';
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

interface StoreFixture {
  storeId: string;
  userId: string;
  token: string;
  domain: string;
}

const createdUserIds: string[] = [];
const createdStoreIds: string[] = [];

async function createStoreAdminWithStore(
  label: string,
  plan: 'starter' | 'free' = 'starter'
): Promise<StoreFixture> {
  const email = `aei-dash-${label}-${RUN_ID}@example.test`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PW, 10),
      firstName: 'AEI',
      lastName: `Dash${label}`,
      role: 'store_admin',
      emailVerified: true,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);

  const domain = `aei-dash-${label}-${RUN_ID}.example.com`;
  const store = await prisma.store.create({
    data: {
      name: `AEI Dashboard Test Store ${label} ${RUN_ID}`,
      slug: `aei-dash-${label}-${RUN_ID}`,
      domain,
      ownerId: user.id,
      plan,
      status: 'active',
    },
    select: { id: true },
  });
  createdStoreIds.push(store.id);

  // Store admins sign in at the identity service; the stand-in mints its token.
  const token = await identityTokenFor(user.id);

  return {
    storeId: store.id,
    userId: user.id,
    token,
    domain,
  };
}

function authHeaders(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

let storeA: StoreFixture;
let storeB: StoreFixture;
let noFeatureStore: StoreFixture;

const STORE_B_UNIQUE_PROMPT = `store-b-unique-prompt-${RUN_ID}`;

beforeAll(async () => {
  storeA = await createStoreAdminWithStore('a');
  storeB = await createStoreAdminWithStore('b');
  noFeatureStore = await createStoreAdminWithStore('nofeature');

  // Explicitly disable the feature for the third store (starter plan is
  // baseline-ON, so this proves the override — not the plan — is what
  // gates it).
  await prisma.storeFeature.create({
    data: { storeId: noFeatureStore.storeId, featureKey: 'answer_engine_insights', enabled: false },
  });

  const now = new Date();

  await prisma.answerEngineCheck.createMany({
    data: [
      // gemini: one cited, one not (competitor) — groundedCaveat false
      // (at least one of the latest checks has a non-empty citedUrls).
      {
        storeId: storeA.storeId,
        engine: 'gemini',
        promptText: 'best gadgets in Egypt',
        locale: 'en',
        cited: true,
        rank: 1,
        snippet: 'Great gadgets at this store.',
        citedUrls: [`https://${storeA.domain}/best-gadgets`],
        competitorUrls: [],
        runAt: now,
      },
      {
        storeId: storeA.storeId,
        engine: 'gemini',
        promptText: 'where to buy smart widget in Egypt',
        locale: 'en',
        cited: false,
        citedUrls: [],
        competitorUrls: ['https://competitor-a1.example'],
        runAt: now,
      },
      // perplexity: one cited, one not (competitor) — groundedCaveat false.
      {
        storeId: storeA.storeId,
        engine: 'perplexity',
        promptText: 'best gadgets in Egypt',
        locale: 'en',
        cited: true,
        rank: 2,
        snippet: 'Also available at this store.',
        citedUrls: [`https://${storeA.domain}/gadgets`],
        competitorUrls: [],
        runAt: now,
      },
      {
        storeId: storeA.storeId,
        engine: 'perplexity',
        promptText: 'where to buy smart widget in Egypt',
        locale: 'en',
        cited: false,
        citedUrls: [],
        competitorUrls: ['https://competitor-a2.example'],
        runAt: now,
      },
      // openai: ONLY check has empty citedUrls -> groundedCaveat TRUE.
      {
        storeId: storeA.storeId,
        engine: 'openai',
        promptText: 'best gadgets in Egypt',
        locale: 'en',
        cited: false,
        citedUrls: [],
        competitorUrls: ['https://competitor-a3.example'],
        runAt: now,
      },
      // Store B — distinct prompt text/domain, must never leak into A's summary.
      {
        storeId: storeB.storeId,
        engine: 'gemini',
        promptText: STORE_B_UNIQUE_PROMPT,
        locale: 'en',
        cited: true,
        citedUrls: [`https://${storeB.domain}/z`],
        competitorUrls: [],
        runAt: now,
      },
    ],
  });
});

afterAll(async () => {
  const storeIds = [storeA.storeId, storeB.storeId, noFeatureStore.storeId];
  await prisma.answerEngineCheck
    .deleteMany({ where: { storeId: { in: storeIds } } })
    .catch(() => {});
  await prisma.storeFeature.deleteMany({ where: { storeId: { in: storeIds } } }).catch(() => {});
  await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
});

describe('GET /stores/:storeId/answer-engine/summary', () => {
  it("returns Store A's correct per-engine aggregates, grounded caveat, and per-prompt win/lose list", async () => {
    const res = await fetch(`${API_URL}/stores/${storeA.storeId}/answer-engine/summary`, {
      headers: authHeaders(storeA.token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const { engines, trend, prompts, lastRunAt } = body.data;

    // ── per-engine aggregates ──────────────────────────────────────────
    const byEngine = Object.fromEntries(engines.map((e: any) => [e.engine, e]));
    expect(byEngine.gemini).toMatchObject({ totalChecks: 2, citedCount: 1, groundedCaveat: false });
    expect(byEngine.gemini.citedRate).toBeCloseTo(0.5);
    expect(byEngine.perplexity).toMatchObject({
      totalChecks: 2,
      citedCount: 1,
      groundedCaveat: false,
    });
    expect(byEngine.openai).toMatchObject({ totalChecks: 1, citedCount: 0, groundedCaveat: true });

    // ── per-prompt win/lose (latest run) ────────────────────────────────
    expect(prompts.length).toBe(5);
    const geminiWin = prompts.find(
      (p: any) => p.engine === 'gemini' && p.promptText === 'best gadgets in Egypt'
    );
    expect(geminiWin.cited).toBe(true);
    expect(geminiWin.competitorUrls).toEqual([]);

    const geminiLoss = prompts.find(
      (p: any) => p.engine === 'gemini' && p.promptText === 'where to buy smart widget in Egypt'
    );
    expect(geminiLoss.cited).toBe(false);
    expect(geminiLoss.competitorUrls).toEqual(['https://competitor-a1.example']);

    // ── trend ────────────────────────────────────────────────────────────
    expect(trend.length).toBeGreaterThanOrEqual(1);
    const totalTrendChecks = trend.reduce((sum: number, t: any) => sum + t.totalChecks, 0);
    expect(totalTrendChecks).toBe(5);
    const totalTrendCited = trend.reduce((sum: number, t: any) => sum + t.citedCount, 0);
    expect(totalTrendCited).toBe(2);

    expect(lastRunAt).not.toBeNull();

    // ── TENANT ISOLATION (required) ─────────────────────────────────────
    // Store A's summary must NEVER contain Store B's rows, even though
    // Store B has data seeded at the same time.
    expect(prompts.some((p: any) => p.promptText === STORE_B_UNIQUE_PROMPT)).toBe(false);
    const rawBody = JSON.stringify(body);
    expect(rawBody).not.toContain(STORE_B_UNIQUE_PROMPT);
    expect(rawBody).not.toContain(storeB.domain);
  });

  it("Store B's own summary contains only its own row, never Store A's data", async () => {
    const res = await fetch(`${API_URL}/stores/${storeB.storeId}/answer-engine/summary`, {
      headers: authHeaders(storeB.token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.prompts.length).toBe(1);
    expect(body.data.prompts[0].promptText).toBe(STORE_B_UNIQUE_PROMPT);
    const rawBody = JSON.stringify(body);
    expect(rawBody).not.toContain('best gadgets in Egypt');
    expect(rawBody).not.toContain(storeA.domain);
  });

  it('a store_admin who owns Store B gets 403 (not data) when requesting Store A summary directly', async () => {
    const res = await fetch(`${API_URL}/stores/${storeA.storeId}/answer-engine/summary`, {
      headers: authHeaders(storeB.token),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    // requireStoreAccess denial — never a 200 with (even partial) data.
    expect(body.success).not.toBe(true);
  });

  it('a store with answer_engine_insights disabled gets 403 FEATURE_DISABLED, never data', async () => {
    const res = await fetch(`${API_URL}/stores/${noFeatureStore.storeId}/answer-engine/summary`, {
      headers: authHeaders(noFeatureStore.token),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code ?? body.code).toBe('FEATURE_DISABLED');
    expect(body.data).toBeUndefined();
  });

  // Issue #929: a Gemini row that recorded a `groundingUnavailableReason`
  // (the provider's grounded call was rejected/rationed and it fell back to
  // an ungrounded call — see `gemini.provider.ts`) must surface as
  // `groundingUnavailable: true`, distinct from the pre-existing
  // `groundedCaveat` ("grounded fine, cited nothing"). Own store, isolated
  // from the fixtures above, so it can't perturb their totalChecks/citedCount
  // assertions.
  it('an engine whose latest check recorded a groundingUnavailableReason reports groundingUnavailable: true', async () => {
    const groundingStore = await createStoreAdminWithStore('grounding-unavailable');

    await prisma.answerEngineCheck.create({
      data: {
        storeId: groundingStore.storeId,
        engine: 'gemini',
        promptText: 'best gadgets in Egypt',
        locale: 'en',
        cited: false,
        citedUrls: [],
        competitorUrls: [],
        groundingUnavailableReason: 'http_429',
        runAt: new Date(),
      },
    });

    const res = await fetch(`${API_URL}/stores/${groundingStore.storeId}/answer-engine/summary`, {
      headers: authHeaders(groundingStore.token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    const byEngine = Object.fromEntries(body.data.engines.map((e: any) => [e.engine, e]));
    expect(byEngine.gemini).toMatchObject({ groundedCaveat: true, groundingUnavailable: true });
  });
});
