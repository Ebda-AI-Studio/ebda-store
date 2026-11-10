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
});
