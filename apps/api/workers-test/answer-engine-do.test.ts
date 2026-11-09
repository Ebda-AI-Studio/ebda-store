/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * P1 2026-11-09: production paged `POSTGRES_REMOVED ($transaction)` from the cron `answer-engine-citation-scan-cron`. The route
 * sweep's job store sat on a plan / feature set the scan skips before its first store read, so the scan's body never ran
 * there. This drives the weekly cron body for a Durable Object store that the scan DOES scan (AI-eligible plan, the
 * `answer_engine_insights` feature on, every cutover marker set as in production) and asserts it never reaches Postgres.
 *
 *   EBDA_WORKERS_TEST_DB_URL=postgresql://u:p@127.0.0.1:1/x npx vitest run --config vitest.workers.config.mts workers-test/answer-engine-do.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
};

// EXACTLY production's `ebda-platform` markers on 2026-11-09 (read-only `SELECT key FROM system_settings`): every family but
// `ai-usage` was flipped. With Postgres gone, an unflipped family must still be served by D1, never by a Prisma call.
const MARKER_KEYS = [
  'platform_cutover.billing',
  'platform_cutover.access',
  'platform_cutover.platform',
  'platform_cutover.inbox',
  'platform_cutover.analytics',
  'platform_cutover.payments',
  'platform_cutover.ops',
  'platform_cutover.audit',
  'customer_auth_cutover.__all',
];

describe.skipIf(e.E2E_DB === '1')('answer-engine citation scan on a DO store, no Postgres', () => {
  it('the weekly cron body scans an AI-eligible DO store without a Postgres reach', async () => {
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
        .bind(`ae-marker-${i}`, k)
        .run();
    const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: 'owner-ae',
        name: 'AE Shop',
        slug: 'ae-shop',
        operator: true,
      }),
    });
    expect(created.status).toBe(200);
    const storeId = ((await created.json()) as { id: string }).id;
    // what the scan selects: an AI-eligible plan and the feature on (the AI switch defaults ON on the DO)
    await e.PLATFORM_DB.prepare("UPDATE stores SET plan = 'professional' WHERE id = ?1")
      .bind(storeId)
      .run();
    await e.PLATFORM_DB.prepare(
      'INSERT OR REPLACE INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 1, ?4)'
    )
      .bind('ae-feat', storeId, 'answer_engine_insights', Date.now())
      .run();
    // a product, so the scan has prompts and reaches the provider path (quota check, usage row, check row): an empty store
    // returns before any of it
    const seeded = await e.API.fetch(
      `https://api.ebda.app/api/v1/internal/store-do/${storeId}/seed`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer workers-test-seed-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          products: [
            {
              id: '55555555-5555-4555-8555-555555555555',
              storeId,
              name: 'Linen shirt',
              slug: 'linen-shirt',
              price: 1000,
              inventory: 3,
              status: 'active',
            },
          ],
        }),
      }
    );
    expect(seeded.status).toBe(200);

    const reaches = async (reset: boolean) =>
      (
        (await (
          await e.API.fetch(`https://api.ebda.app/__dev/pg-reaches${reset ? '?reset=1' : ''}`)
        ).json()) as { reaches: Array<{ label: string; stack: string }> }
      ).reaches;
    await reaches(true);
    const ran = await e.API.fetch('https://api.ebda.app/__dev/run-jobs', { method: 'POST' });
    expect(ran.status).toBe(200);
    const body = (await ran.json()) as { jobs: Array<{ id: string; ok: boolean; error?: string }> };
    const scan = body.jobs.find(j => j.id === 'answer-engine-citation-scan-cron');
    expect(scan, JSON.stringify(scan)).toMatchObject({ ok: true });
    const mine = (await reaches(false)).filter(r => /answer-engine/.test(r.label));
    for (const r of mine)
      // eslint-disable-next-line no-console
      console.log('AE_PG_REACH ' + JSON.stringify(r).slice(0, 1500));
    expect(
      mine.map(r => r.label),
      'answer-engine job bodies that reached Postgres'
    ).toEqual([]);
  }, 300_000);
});
