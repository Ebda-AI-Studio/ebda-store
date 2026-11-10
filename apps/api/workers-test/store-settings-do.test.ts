/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Merchant settings reads/writes on a DO store over the built Worker (Postgres removed): GET /stores/:id, GET /stores/:id/domain
 * and PUT /stores/:id answered 501 (include) and then 500 (the orders count used the POSTGRES_REMOVED tenant tx).
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { accessToken, authState } from './helpers';

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  PLATFORM_DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  E2E_DB: string;
};
const BASE = 'https://api.ebda.app/api/v1';
let ip = 0;
const LOOK = 'qamar.atelier';
const call = (path: string, token: string, init: RequestInit = {}) =>
  e.API.fetch(BASE + path, {
    ...init,
    headers: {
      'x-forwarded-for': `10.9.0.${ip++ & 255}`,
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });

describe.skipIf(e.E2E_DB === '1')('store settings on a DO store (no Postgres)', () => {
  let id = '';
  let tok = '';
  it('fixture: one DO store and its owner', async () => {
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
        .bind(`xs-marker-${i}`, k)
        .run();
    const made = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: 'owner-sg',
        name: 'SG Shop',
        slug: 'sg-shop',
        operator: true,
      }),
    });
    expect(made.status).toBe(200);
    id = ((await made.json()) as { id: string }).id;
    await authState('user:tv:owner-sg', [['set', 'user:tv:owner-sg', '0', {}]]);
    tok = await accessToken({ userId: 'owner-sg', jti: 'j-sg', role: 'store_admin', storeId: id });
  });

  it('GET /stores/:id answers 200 with the store, its counts and its owner', async () => {
    const r = await call(`/stores/${id}`, tok);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      data: { store: { id: string; _count: { orders: number }; owner: { id: string } | null } };
    };
    expect(j.data.store.id).toBe(id);
    expect(j.data.store._count.orders).toBe(0);
  });

  it('GET /stores/:id/domain answers 200', async () => {
    expect((await call(`/stores/${id}/domain`, tok)).status).toBe(200);
  });

  it('PUT /stores/:id saves a plain field and returns it', async () => {
    const r = await call(`/stores/${id}`, tok, {
      method: 'PUT',
      body: JSON.stringify({ name: 'SG Shop Renamed' }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { data: { store: { name: string } } };
    expect(j.data.store.name).toBe('SG Shop Renamed');
  });

  it('PUT /stores/:id with a timezone (reads the previous zone first) saves it', async () => {
    const r = await call(`/stores/${id}`, tok, {
      method: 'PUT',
      body: JSON.stringify({ timezone: 'Africa/Cairo' }),
    });
    expect(r.status).toBe(200);
    const g = (await (await call(`/stores/${id}`, tok)).json()) as {
      data: { store: { timezone: string } };
    };
    expect(g.data.store.timezone).toBe('Africa/Cairo');
  });

  it('PUT /stores/:id/look applies a built look', async () => {
    const r = await call(`/stores/${id}/look`, tok, {
      method: 'PUT',
      body: JSON.stringify({ lookId: LOOK, design: 'keep' }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { data: { look: string } };
    expect(j.data.look).toBe(LOOK);
  });

  it('PUT /stores/:id/domain claims a domain and GET reads it back', async () => {
    const r = await call(`/stores/${id}/domain`, tok, {
      method: 'PUT',
      body: JSON.stringify({ domain: 'sg-shop-test.example.com' }),
    });
    // the test env has no domain provider: a clean 503 DOMAIN_FEATURE_UNAVAILABLE is the answer, never a 500
    expect([200, 503], await r.clone().text()).toContain(r.status);
    expect((await call(`/stores/${id}/domain`, tok)).status).toBe(200);
  });
});
