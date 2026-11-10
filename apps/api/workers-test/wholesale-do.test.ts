/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * NEON-ZERO N-11 follow-up: wholesale approval on a store served by its Durable Object with Postgres DEAD. The shopper applies,
 * the owner approves into a wholesale group (customerSetGroup / customerCreateInGroup, batched with an audit row), then revokes.
 *
 *   EBDA_WORKERS_TEST_DB_URL=postgresql://u:p@127.0.0.1:1/x npx vitest run --config vitest.workers.config.mts workers-test/wholesale-do.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { accessToken, authState } from './helpers';

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: {
    idFromName(n: string): unknown;
    get(id: unknown): {
      authOp(s: string, op: string, a: string): Promise<{ ok: boolean; json?: string }>;
    };
  };
};
const BASE = 'https://api.ebda.app/api/v1';
const MARKER_KEYS = [
  'platform_cutover.billing',
  'platform_cutover.access',
  'platform_cutover.platform',
  'platform_cutover.inbox',
  'platform_cutover.ai-usage',
  'platform_cutover.analytics',
  'customer_auth_cutover.__all',
];
let ip = 0;
const freshIp = () => `10.9.${(ip >> 8) & 255}.${ip++ & 255}`;

describe.skipIf(e.E2E_DB === '1')('wholesale approve / revoke on a DO store, Postgres dead', () => {
  it('apply -> approve into a wholesale group -> revoke, no Postgres', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    for (const p of DEFAULT_PLAN_SEEDS)
      await e.PLATFORM_DB.prepare(
        'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      )
        .bind(`plan-${p.code}`, p.code, p.nameEn, p.nameAr, p.featureTier, JSON.stringify(p.limits))
        .run();
    for (const [i, k] of MARKER_KEYS.entries())
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
      )
        .bind(`wh-marker-${i}`, k)
        .run();
    const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: 'owner-wh',
        name: 'WH Shop',
        slug: 'wh-shop',
        operator: true,
      }),
    });
    expect(created.status).toBe(200);
    const storeId = ((await created.json()) as { id: string }).id;
    // the plan gate: the override row that super-admin's feature toggle writes (D1 store_features)
    await e.PLATFORM_DB.prepare(
      'INSERT INTO store_features (id, store_id, feature_key, enabled, enabled_at) VALUES (?1, ?2, ?3, 1, 1)'
    )
      .bind('wh-feat-1', storeId, 'b2b.wholesale')
      .run();
    await authState('user:tv:owner-wh', [['set', 'user:tv:owner-wh', '0', {}]]);
    const owner = await accessToken({
      userId: 'owner-wh',
      jti: 'j-wh',
      role: 'store_admin',
      storeId,
    });
    const adm = (extra: Record<string, string> = {}) => ({
      authorization: `Bearer ${owner}`,
      'x-store-id': storeId,
      'content-type': 'application/json',
      'cf-connecting-ip': freshIp(),
      ...extra,
    });

    const grp = await e.API.fetch(`${BASE}/stores/${storeId}/customer-groups`, {
      method: 'POST',
      headers: adm(),
      body: JSON.stringify({ name: 'Wholesale', isWholesale: true, requiresApproval: true }),
    });
    expect(grp.status).toBe(201);
    const gj = (await grp.json()) as { data: { id?: string; group?: { id: string } } };
    const groupId = gj.data.id ?? gj.data.group?.id;
    expect(groupId, JSON.stringify(gj)).toBeTruthy();

    // the shopper's account is created in the store's DO (the customer-auth op that /auth/register calls)
    const buyerId = crypto.randomUUID();
    const vtoken = `${storeId}~${'b'.repeat(64)}`;
    const vhash = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(vtoken))),
    ]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const ns = e.STORE_DO;
    const reg = await ns.get(ns.idFromName(storeId)).authOp(
      storeId,
      'register',
      JSON.stringify({
        id: buyerId,
        email: 'buyer@exit-test.invalid',
        passwordHash: 'x'.repeat(60),
        firstName: 'Whole',
        lastName: 'Saler',
        verification: { tokenHash: vhash, expiresAt: Date.now() + 3_600_000, rowId: 'v-wh' },
      })
    );
    expect(reg.ok, JSON.stringify(reg)).toBe(true);
    const verified = await e.API.fetch(`${BASE}/auth/verify-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() },
      body: JSON.stringify({ token: vtoken }),
    });
    expect(verified.status).toBe(200);
    await authState(`user:tv:${buyerId}`, [['set', `user:tv:${buyerId}`, '0', {}]]);
    const buyer = await accessToken({ userId: buyerId, jti: 'j-buyer', role: 'customer', storeId });

    const apply = await e.API.fetch(`${BASE}/public/wholesale/apply`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${buyer}`,
        'x-store-id': storeId,
        'content-type': 'application/json',
        'cf-connecting-ip': freshIp(),
      },
      body: JSON.stringify({ businessName: 'Acme Trading', phone: '+201000000001', consent: true }),
    });
    expect(apply.status, await apply.clone().text()).toBe(201);
    const appId = ((await apply.json()) as { data: { application: { id: string } } }).data
      .application.id;

    const approve = await e.API.fetch(
      `${BASE}/stores/${storeId}/wholesale-applications/${appId}/approve`,
      {
        method: 'POST',
        headers: adm(),
        body: JSON.stringify({ groupId }),
      }
    );
    expect(approve.status, await approve.clone().text()).toBe(200);

    const revoke = await e.API.fetch(
      `${BASE}/stores/${storeId}/wholesale-applications/${appId}/revoke`,
      {
        method: 'POST',
        headers: adm(),
        body: JSON.stringify({}),
      }
    );
    expect(revoke.status, await revoke.clone().text()).toBe(200);
  }, 120_000);
});
