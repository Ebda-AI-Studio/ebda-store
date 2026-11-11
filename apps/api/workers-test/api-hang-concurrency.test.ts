/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * API-HANG-1: concurrent public reads on workerd (the built Worker: D1 + StoreDO + the AuthState DO). 200 concurrent cold
 * reads across 5 stores (store resolve + product list, one client address each) all answer, none 5xx, none slower than
 * 2 s, and none waits on a cache write-back. Run:
 *   npm run cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/api-hang-concurrency.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };
  TEST_PLATFORM_MIGRATIONS: unknown[];
};
const BASE = 'https://api.ebda.app/api/v1';
const MARKER_KEYS = [
  'platform_cutover.billing',
  'platform_cutover.access',
  'platform_cutover.platform',
  'platform_cutover.inbox',
  'platform_cutover.ai-usage',
  'platform_cutover.analytics',
  'platform_cutover.payments',
  'platform_cutover.ops',
  'platform_cutover.audit',
  'customer_auth_cutover.__all',
];

let n = 0;
const nextIp = () => `198.51.${(n >> 8) & 255}.${n++ & 255 || 1}`;
const STORES = 5;
const CONCURRENT = 200;
const HANG_MS = 2_000;
// measured 2026-11-10 on local workerd with 150 ms per AuthState call: 348 ms with the write-back in waitUntil, 654-661 ms with it
// on the response path (the code before API-HANG-1)
const DELAY_ROUNDTRIPS_MAX = 3;
// the relative bound (Ruling API-HANG-3): 3 serial round trips (450 ms) + 90 ms of jitter; the pre-API-HANG-1 code is ~5 (+600 ms)
const PROD_LIKE_EXTRA_MS = 540;

export function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(e.E2E_DB === '1')('API-HANG-1: concurrent public reads never hang', () => {
  const stores: Array<{ id: string; slug: string }> = [];

  it('fixture: 5 DO stores with products', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    for (const p of DEFAULT_PLAN_SEEDS)
      await e.PLATFORM_DB.prepare(
        'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor, price_yearly_minor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
      )
        .bind(
          `plan-${p.code}`,
          p.code,
          p.nameEn,
          p.nameAr,
          p.featureTier,
          JSON.stringify(p.limits),
          p.priceMonthlyMinor,
          p.priceYearlyMinor
        )
        .run();
    for (const [i, k] of MARKER_KEYS.entries())
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
      )
        .bind(`rl-do-marker-${i}`, k)
        .run();
    for (let s = 0; s < STORES; s++) {
      const slug = `hang-shop-${s}`;
      const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
        method: 'POST',
        body: JSON.stringify({
          ownerId: `owner-hang-${s}`,
          name: `Hang ${s}`,
          slug,
          operator: true,
        }),
      });
      expect(created.status).toBe(200);
      const id = ((await created.json()) as { id: string }).id;
      const now = Date.now();
      const seeded = await e.API.fetch(`${BASE}/internal/store-do/${id}/seed`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer workers-test-seed-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          products: Array.from({ length: 6 }, (_, i) => ({
            id: crypto.randomUUID(),
            storeId: id,
            name: `P${i}`,
            slug: `hang-${s}-p${i}`,
            price: 5000 + i,
            inventory: 10,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          })),
        }),
      });
      expect(seeded.status).toBe(200);
      stores.push({ id, slug });
    }
  }, 120_000);

  it(`${CONCURRENT} concurrent cold reads across ${STORES} stores: all answer, no 5xx, none over ${HANG_MS} ms`, async () => {
    const one = async (i: number) => {
      const s = stores[i % STORES];
      const path = i % 2 === 0 ? `/public/stores/${s.slug}` : '/public/products?limit=24';
      const t0 = Date.now();
      const res = await e.API.fetch(`${BASE}${path}`, {
        headers: { 'cf-connecting-ip': nextIp(), 'x-store-id': s.id },
      });
      await res.text();
      return { ms: Date.now() - t0, status: res.status, path };
    };
    const results = await Promise.all(Array.from({ length: CONCURRENT }, (_, i) => one(i)));
    const ms = results.map(r => r.ms).sort((a, b) => a - b);
    const summary = `p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${ms[ms.length - 1]} ms`;
    const bad = results.filter(r => r.status >= 500 || r.status === 0);
    expect(bad, summary).toEqual([]);
    expect(
      results.filter(r => r.ms > HANG_MS),
      summary
    ).toEqual([]);
    void summary;
  }, 120_000);
  // The `x-dev-authstate-*` headers are honoured only with DEV_STATS=1 (this test config; never production): see
  // cf/auth-state-client.ts `call`. They make local workerd behave like production: a real DO round trip, or a stuck instance.
  const STALL_BUDGET_MS = 2_500 + 1_500; // AUTH_STATE_TIMEOUT_MS + the rest of the request
  let cold = 0;
  const coldProducts = (s: { id: string }, headers: Record<string, string>) =>
    e.API.fetch(`${BASE}/public/products?limit=${(cold++ % 40) + 1}&page=${cold}`, {
      headers: { 'cf-connecting-ip': nextIp(), 'x-store-id': s.id, ...headers },
    });

  it('a STUCK cache-generation instance: cold reads still answer 200 within the deadline, none hangs', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const t0 = Date.now();
        const res = await coldProducts(stores[i % STORES], {
          'x-dev-authstate-stall': 'cachegen:',
        });
        await res.text();
        return { ms: Date.now() - t0, status: res.status };
      })
    );
    const ms = results.map(r => r.ms).sort((a, b) => a - b);
    const summary = `p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${ms[ms.length - 1]} ms`;
    expect(
      results.filter(r => r.status !== 200),
      summary
    ).toEqual([]);
    expect(ms[ms.length - 1], summary).toBeLessThan(STALL_BUDGET_MS);
  }, 45_000);

  it('a production-like 150 ms AuthState round trip: a cold read waits on ONE generation read, not three', async () => {
    // RELATIVE budget (Ruling API-HANG-3): a fixed 500 ms p95 failed at 557 ms on a shared 2-vCPU runner (3x slower CPU than a
    // laptop) with no code change. What this test pins is the NUMBER of serial 150 ms round trips on the cold path, so it measures
    // the same 25 cold reads with no delay (the runner's own speed) and with 150 ms, takes the MIN p95 of ROUNDS rounds of each
    // (scheduler noise only adds time; a real regression raises every round) and bounds the difference.
    const round = async (delay: string) => {
      const results = await Promise.all(
        Array.from({ length: 25 }, async (_, i) => {
          const t0 = Date.now();
          const res = await coldProducts(stores[i % STORES], { 'x-dev-authstate-delay-ms': delay });
          await res.text();
          return { ms: Date.now() - t0, status: res.status };
        })
      );
      const ms = results.map(r => r.ms).sort((x, y) => x - y);
      expect(
        results.filter(r => r.status !== 200),
        `p95 ${pct(ms, 95)} ms`
      ).toEqual([]);
      return pct(ms, 95);
    };
    const ROUNDS = 3;
    const base: number[] = [];
    const slow: number[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      base.push(await round('0'));
      slow.push(await round('150'));
    }
    const delta = Math.min(...slow) - Math.min(...base);
    const summary = `p95 with 150 ms calls ${slow.join('/')} ms, without ${base.join('/')} ms: +${delta} ms over ${DELAY_ROUNDTRIPS_MAX} round trips of 150 ms`;
    // critical path: limiter batch (+ tenant shard) + 1 generation read = 2-3 x 150 ms. The write-back on the response path (the
    // code before API-HANG-1) adds 2 x 150 ms + the KV put to every cold read (+600 ms measured locally: 5 round trips).
    expect(delta, summary).toBeLessThan(PROD_LIKE_EXTRA_MS);
    void summary;
  }, 90_000);

  it('a stuck limiter instance: a credential limiter answers 429 + Retry-After (fail closed), a public read is served', async () => {
    const stall = { 'x-dev-authstate-stall': 'rl:' };
    const t0 = Date.now();
    const login = await e.API.fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'cf-connecting-ip': nextIp(), 'content-type': 'application/json', ...stall },
      body: JSON.stringify({
        email: 'nobody@exit-test.invalid',
        password: 'Wrong-pass-1',
        storeId: stores[0].id,
      }),
    });
    const loginBody = (await login.json()) as { error?: { code?: string } };
    const loginMs = Date.now() - t0;
    expect(login.status, JSON.stringify(loginBody)).toBe(429);
    expect(loginBody.error?.code).toBeTruthy();
    expect(Number(login.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(loginMs).toBeLessThan(STALL_BUDGET_MS);

    const t1 = Date.now();
    const read = await e.API.fetch(`${BASE}/public/stores/${stores[1].slug}`, {
      headers: { 'cf-connecting-ip': nextIp(), ...stall },
    });
    await read.text();
    expect(read.status).toBe(200);
    expect(Date.now() - t1).toBeLessThan(STALL_BUDGET_MS);
  }, 45_000);
});
