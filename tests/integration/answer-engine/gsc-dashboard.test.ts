/**
 * Integration tests for Task 4 — merchant-facing Google Search Console
 * dashboard read API (`GET /stores/:storeId/answer-engine/gsc`).
 *
 * Requires a real Postgres DB (via DATABASE_URL) and real Redis (via
 * REDIS_URL); hits a real running API server at localhost:4000. Mirrors the
 * harness pattern used by tests/integration/answer-engine/dashboard.test.ts
 * (real login -> real JWT, store_admin owning their own store via
 * prisma.store.create + ownerId).
 *
 * Covers:
 *   1. Store A's trend/totals/topQueries computed correctly from seeded
 *      `GscDailyMetric` rows.
 *   2. TENANT ISOLATION (required, negative):
 *      a. Store A's response NEVER contains Store B's rows, even though
 *         both stores have GSC data seeded at the same time.
 *      b. A store_admin who owns Store B gets 403 (not data) when hitting
 *         Store A's gsc endpoint directly.
 *   3. A store with ZERO `GscDailyMetric` rows -> `hasData:false` /
 *      `connected:false` — a "not connected" empty state, NOT an error and
 *      NOT a fake all-zero chart.
 *   4. Feature-off store -> 403 FEATURE_DISABLED (same fail-closed gate as
 *      the 8A summary route).
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
  const email = `aei-gsc-${label}-${RUN_ID}@example.test`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PW, 10),
      firstName: 'AEI',
      lastName: `Gsc${label}`,
      role: 'store_admin',
      emailVerified: true,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);

  const domain = `aei-gsc-${label}-${RUN_ID}.example.com`;
  const store = await prisma.store.create({
    data: {
      name: `AEI GSC Test Store ${label} ${RUN_ID}`,
      slug: `aei-gsc-${label}-${RUN_ID}`,
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

function utcDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

let storeA: StoreFixture;
let storeB: StoreFixture;
let emptyStore: StoreFixture;
let noFeatureStore: StoreFixture;

const STORE_B_UNIQUE_QUERY = `store-b-unique-query-${RUN_ID}`;

beforeAll(async () => {
  storeA = await createStoreAdminWithStore('a');
  storeB = await createStoreAdminWithStore('b');
  emptyStore = await createStoreAdminWithStore('empty');
  noFeatureStore = await createStoreAdminWithStore('nofeature');

  // Explicitly disable the feature for this store (starter plan is
  // baseline-ON, so this proves the override — not the plan — is what
  // gates it).
  await prisma.storeFeature.create({
    data: { storeId: noFeatureStore.storeId, featureKey: 'answer_engine_insights', enabled: false },
  });

  await prisma.gscDailyMetric.createMany({
    data: [
      {
        storeId: storeA.storeId,
        date: utcDate('2026-07-18'),
        impressions: 100,
        clicks: 10,
        ctr: 0.1,
        position: 8,
        topQueries: [{ query: 'old query', impressions: 50, clicks: 2 }],
      },
      {
        storeId: storeA.storeId,
        date: utcDate('2026-07-19'),
        impressions: 200,
        clicks: 20,
        ctr: 0.1,
        position: 6,
        topQueries: [{ query: 'mid query', impressions: 80, clicks: 6 }],
      },
      {
        storeId: storeA.storeId,
        date: utcDate('2026-07-20'),
        impressions: 300,
        clicks: 45,
        ctr: 0.15,
        position: 4,
        topQueries: [
          { query: 'best gadgets cairo', impressions: 120, clicks: 20 },
          { query: 'smart widget store', impressions: 60, clicks: 5 },
        ],
      },
      // Store B — distinct query text/domain, must never leak into A's response.
      {
        storeId: storeB.storeId,
        date: utcDate('2026-07-20'),
        impressions: 999,
        clicks: 99,
        ctr: 0.099,
        position: 2,
        topQueries: [{ query: STORE_B_UNIQUE_QUERY, impressions: 999, clicks: 99 }],
      },
    ],
  });
});

afterAll(async () => {
  const storeIds = [storeA.storeId, storeB.storeId, emptyStore.storeId, noFeatureStore.storeId];
  await prisma.gscDailyMetric.deleteMany({ where: { storeId: { in: storeIds } } }).catch(() => {});
  await prisma.storeFeature.deleteMany({ where: { storeId: { in: storeIds } } }).catch(() => {});
  await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
});

describe('GET /stores/:storeId/answer-engine/gsc', () => {
  it("returns Store A's trend, totals, and top queries from the latest row", async () => {
    const res = await fetch(`${API_URL}/stores/${storeA.storeId}/answer-engine/gsc`, {
      headers: authHeaders(storeA.token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const { connected, hasData, trend, totals, topQueries, lastUpdatedAt } = body.data;

    expect(connected).toBe(true);
    expect(hasData).toBe(true);

    // ── trend: ascending by date, 3 days ────────────────────────────────
    expect(trend.length).toBe(3);
    expect(trend.map((t: any) => t.date)).toEqual(['2026-07-18', '2026-07-19', '2026-07-20']);
    expect(trend[2]).toMatchObject({ impressions: 300, clicks: 45, position: 4 });

    // ── totals: impressions/clicks summed, ctr = clicks/impressions ─────
    expect(totals.impressions).toBe(600);
    expect(totals.clicks).toBe(75);
    expect(totals.ctr).toBeCloseTo(75 / 600);
    // impression-weighted avg position: (8*100 + 6*200 + 4*300) / 600
    expect(totals.avgPosition).toBeCloseTo((8 * 100 + 6 * 200 + 4 * 300) / 600);

    // ── top queries: from the LATEST row (2026-07-20) only ──────────────
    expect(topQueries.length).toBe(2);
    expect(topQueries.map((q: any) => q.query)).toEqual([
      'best gadgets cairo',
      'smart widget store',
    ]);
    expect(topQueries.some((q: any) => q.query === 'old query')).toBe(false);

    expect(lastUpdatedAt).not.toBeNull();

    // ── TENANT ISOLATION (required) ─────────────────────────────────────
    const rawBody = JSON.stringify(body);
    expect(rawBody).not.toContain(STORE_B_UNIQUE_QUERY);
    expect(rawBody).not.toContain(storeB.domain);
    expect(totals.impressions).not.toBe(600 + 999);
  });

  it("Store B's own response contains only its own row, never Store A's data", async () => {
    const res = await fetch(`${API_URL}/stores/${storeB.storeId}/answer-engine/gsc`, {
      headers: authHeaders(storeB.token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.hasData).toBe(true);
    expect(body.data.trend.length).toBe(1);
    expect(body.data.topQueries).toEqual([
      { query: STORE_B_UNIQUE_QUERY, impressions: 999, clicks: 99 },
    ]);
    const rawBody = JSON.stringify(body);
    expect(rawBody).not.toContain('best gadgets cairo');
    expect(rawBody).not.toContain(storeA.domain);
  });

  it('a store_admin who owns Store B gets 403 (not data) when requesting Store A gsc directly', async () => {
    const res = await fetch(`${API_URL}/stores/${storeA.storeId}/answer-engine/gsc`, {
      headers: authHeaders(storeB.token),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).not.toBe(true);
  });

  it('a store with ZERO GscDailyMetric rows returns hasData:false / connected:false (not an error, not a fake zero chart)', async () => {
    const res = await fetch(`${API_URL}/stores/${emptyStore.storeId}/answer-engine/gsc`, {
      headers: authHeaders(emptyStore.token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.connected).toBe(false);
    expect(body.data.hasData).toBe(false);
    expect(body.data.trend).toEqual([]);
    expect(body.data.totals).toBeNull();
    expect(body.data.topQueries).toEqual([]);
    expect(body.data.lastUpdatedAt).toBeNull();
  });

  it('a store with answer_engine_insights disabled gets 403 FEATURE_DISABLED, never data', async () => {
    const res = await fetch(`${API_URL}/stores/${noFeatureStore.storeId}/answer-engine/gsc`, {
      headers: authHeaders(noFeatureStore.token),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code ?? body.code).toBe('FEATURE_DISABLED');
    expect(body.data).toBeUndefined();
  });
});
