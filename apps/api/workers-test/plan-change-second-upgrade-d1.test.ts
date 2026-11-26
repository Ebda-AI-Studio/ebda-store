/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * G35-PRORATE-1 on the D1 path (money review of #887): the change-plan quote reads the subscription and the period's
 * payments from the platform D1 (production has no Postgres), through the BUILT Worker with the real D1 schema and a DO store.
 * A store that already upgraded into its current plan this period (base + the prorated difference) is quoted a SECOND
 * upgrade crediting the current plan's WHOLE total, not base + the first difference.
 * Driver proven here: workerd + platform D1 (platform_cutover on) + StoreDO; the Postgres twin is
 * tests/integration/subscription-billing.test.ts "two upgrades in one period".
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { accessToken, authState } from './helpers';

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  PLATFORM_DB: D1Database;
  TEST_PLATFORM_MIGRATIONS: unknown[];
  E2E_DB: string;
};
const DAY = 86_400_000;
let ip = 0;
const quote = (storeId: string, token: string, planCode: string) =>
  e.API.fetch(
    `https://api.ebda.app/api/v1/stores/${storeId}/billing/change-plan/quote?planCode=${planCode}`,
    {
      headers: { 'cf-connecting-ip': `10.8.0.${ip++ & 255}`, authorization: `Bearer ${token}` },
    }
  );

let storeId = '';
let adminTok = '';
const seedEvent = (
  id: string,
  type: string,
  planCode: string,
  amount: number,
  createdAt: number,
  forPeriodEnd: number | null
) =>
  e.PLATFORM_DB.prepare(
    `INSERT INTO billing_events (id, store_id, type, plan_code, for_period_end, amount_minor, currency, provider, idempotency_key, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'EGP', 'stub', ?7, 'succeeded', ?8, ?8)`
  )
    .bind(id, storeId, type, planCode, forPeriodEnd, amount, `idem-${id}`, createdAt)
    .run();

describe.skipIf(e.E2E_DB === '1')('G35 second upgrade in one period, D1 path', () => {
  it('fixture: a DO store, the plans, a store admin, a growth subscription mid-period', async () => {
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
    for (const [i, k] of [
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
    ].entries())
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
      )
        .bind(`g35-marker-${i}`, k)
        .run();
    const made = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: 'owner-g35',
        name: 'G35 Shop',
        slug: 'g35-shop',
        operator: true,
      }),
    });
    expect(made.status).toBe(200);
    storeId = ((await made.json()) as { id: string }).id;
    await authState('user:tv:owner-g35', [['set', 'user:tv:owner-g35', '0', {}]]);
    adminTok = await accessToken({
      userId: 'owner-g35',
      jti: 'j-g35-o',
      role: 'store_admin',
      storeId,
    });
    const now = Date.now();
    const end = now + 20 * DAY;
    await e.PLATFORM_DB.prepare(
      `UPDATE store_subscriptions SET plan_code = 'growth', status = 'active', current_period_start = ?2, current_period_end = ?3,
         billing_interval = 'monthly', provider = 'stub', trial_ends_at = NULL, pending_plan_code = NULL WHERE store_id = ?1`
    )
      .bind(storeId, end - 31 * DAY, end)
      .run();
    // the period: Basic paid in full, then an upgrade into Growth priced for THIS period (the days-left difference)
    await seedEvent('ev-base', 'renewal', 'basic', 149_000, end - 31 * DAY, end);
    await seedEvent('ev-up1', 'upgrade', 'growth', 130_000, now - DAY, end);
  });

  it("a second upgrade credits Growth's whole catalogue total, not base + the first difference", async () => {
    const r = await quote(storeId, adminTok, 'business');
    const body = (await r.json()) as { success: boolean; data: any };
    expect(r.status, JSON.stringify(body)).toBe(200);
    expect(body.data.basis).toBe('prorated');
    // Growth is 349000 (VAT included at the platform rate in force); base + first difference is only 279000
    expect(body.data.currentTotalMinor).toBeGreaterThan(149_000 + 130_000);
    expect(body.data.currentTotalMinor).toBe(
      DEFAULT_PLAN_SEEDS.find(p => p.code === 'growth')!.priceMonthlyMinor
    );
  });

  it('with the first upgrade refunded the credit falls back to what was paid', async () => {
    await e.PLATFORM_DB.prepare(
      `INSERT INTO billing_events (id, store_id, type, plan_code, amount_minor, currency, provider, idempotency_key, status, related_event_id, created_at, updated_at)
       VALUES ('ev-ref', ?1, 'refund', 'growth', 130000, 'EGP', 'stub', 'idem-ev-ref', 'succeeded', 'ev-up1', ?2, ?2)`
    )
      .bind(storeId, Date.now())
      .run();
    const r = await quote(storeId, adminTok, 'business');
    const body = (await r.json()) as { data: any };
    expect(body.data.currentTotalMinor).toBe(149_000);
  });
});
