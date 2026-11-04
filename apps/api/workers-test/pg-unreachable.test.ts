/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { FEATURE_KEYS_ARRAY } from '@ebda/shared';

// Ruling ROLE-GUARD-LAZY-1: with Postgres unreachable (Neon quota, 2026-10-31) the built Worker still serves
// everything D1 / a Durable Object answers. Run with EBDA_WORKERS_TEST_DB_URL pointing at a dead port.
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  KV_CACHE: { put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> };
};

describe.skipIf(e.E2E_DB === '1')('built Worker with Postgres unreachable', () => {
  it('/health is 200 with build identity (commit, deploymentId) and no Postgres', async () => {
    const res = await e.API.fetch('https://api.ebda.app/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.commit).toBe('test-sha');
    expect('deploymentId' in body).toBe(true);
  });

  it('an unknown store slug is a 404 from D1 (NEON-ZERO-1), a reserved label too, never a Postgres 500', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    const res = await e.API.fetch('https://api.ebda.app/api/v1/public/stores/no-such-store-zz9');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('STORE_NOT_FOUND');
  });

  it('a Durable Object store answers its reads (seed + counts) without Postgres', async () => {
    // The flipped state of production: the store is `do` in D1 `ebda-platform`.
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    await e.PLATFORM_DB.prepare(
      'INSERT OR REPLACE INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, ?2, ?3, ?4, ?5)'
    )
      .bind('spike-store-1', 's', 's', 'owner-1', 'do')
      .run();
    const base = 'https://api.ebda.app/api/v1/internal/store-do/spike-store-1';
    const headers = {
      authorization: 'Bearer workers-test-seed-token',
      'content-type': 'application/json',
    };
    const now = Date.now();
    const seed = await e.API.fetch(`${base}/seed`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        store: {
          id: 'spike-store-1',
          slug: 's',
          name: 'S',
          currency: 'EGP',
          createdAt: now,
          updatedAt: now,
        },
        products: [],
      }),
    });
    expect(seed.status).toBe(200);
    const counts = await e.API.fetch(`${base}/counts`, { headers });
    expect(counts.status).toBe(200);
  });
});

// NEON-ZERO-1 (Ruling NZ-TX-1): an authenticated admin request for a Durable Object store opens no Postgres transaction.
describe.skipIf(e.E2E_DB === '1')(
  'admin API for a Durable Object store with Postgres unreachable',
  () => {
    const STORE = '5d2c8e11-7b3a-4c6f-9a10-3e4f5a6b7c8d';
    // BLOCKED on the access marker (PR nz-access-auth): until `requireStoreAccess` reads D1, the access check itself still reads
    // Postgres (and the boot role guard 500s on the first Postgres use). Un-skip when that lands; the tenantContext half is
    // proved in tests/unit/tenant-context-do-no-pg.test.ts.
    it.skip('GET orders list answers 2xx', async () => {
      const { accessToken, authState } = await import('./helpers');
      await authState('user:tv:owner-9', [['set', 'user:tv:owner-9', '0', {}]]);
      const tok = await accessToken({ userId: 'owner-9', jti: 'j9', role: 'store_admin' });
      await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, ?2, ?3, ?4, ?5)'
      )
        .bind(STORE, 'adm', 'adm', 'owner-9', 'do')
        .run();
      const res = await e.API.fetch(`https://api.ebda.app/api/v1/stores/${STORE}/orders?limit=5`, {
        headers: { authorization: `Bearer ${tok}` },
      });
      expect(`${res.status} ${(await res.text()).slice(0, 200)}`).toMatch(/^2\d\d /);
    });
  }
);

// NEON-ZERO-1 N-2..N-5/N-14: the public storefront + cart for a Durable Object store with Postgres unreachable.
const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
describe.skipIf(e.E2E_DB === '1')('DO storefront + cart with Postgres unreachable', () => {
  const H = { 'x-store-id': SID, 'x-session-id': 'sess-neon-zero-1' };
  const api = (path: string, init?: RequestInit) =>
    e.API.fetch(`https://api.ebda.app/api/v1${path}`, init);
  const json = { 'content-type': 'application/json' };
  const probe: Array<[string, () => Promise<Response>]> = [
    ['store GET by slug', () => api('/public/stores/spike-shop')],
    [
      'store resolve by host',
      () => api('/public/store/resolve', { headers: { 'x-store-domain': 'spike-shop.ebda.app' } }),
    ],
    ['layout (home data)', () => api(`/public/stores/${SID}/layout`)],
    ['product list', () => api('/public/products', { headers: H })],
    ['PDP', () => api('/public/products/p', { headers: H })],
    ['category list', () => api('/public/categories', { headers: H })],
    ['search', () => api('/public/products', { headers: { ...H, 'x-search-query': 'P' } })],
    [
      'add to cart',
      () =>
        api('/public/cart/items', {
          method: 'POST',
          headers: { ...H, ...json },
          body: JSON.stringify({ productId: PID, quantity: 1 }),
        }),
    ],
    ['cart read', () => api('/public/cart', { headers: H })],
    [
      'checkout quote',
      () =>
        api('/public/orders/quote', {
          method: 'POST',
          headers: { ...H, ...json },
          body: JSON.stringify({
            paymentMethod: 'cod',
            shippingAddress: {
              firstName: 'A',
              lastName: 'B',
              address1: 'x',
              city: 'Cairo',
              state: 'Cairo',
              postalCode: '1',
              country: 'EG',
              phone: '01000000000',
            },
          }),
        }),
    ],
    // N-3: bundles (public list), the guest payment return (read of the order from the DO: an unknown order is a 404 from the
    // DO, never a Postgres 500) and the customer wishlist (the DO writer behind userContext).
    ['public bundle list', () => api(`/stores/public/${SID}/bundles`, { headers: H })],
    [
      'verify-payment (order read from the DO)',
      () =>
        api('/public/orders/33333333-3333-4333-8333-333333333333/verify-payment', {
          method: 'POST',
          headers: { ...H, ...json },
          body: '{}',
        }),
    ],
    [
      'wishlist read + add + remove (customer, DO writer)',
      async () => {
        const { accessToken, authState } = await import('./helpers');
        await authState('user:tv:cust-1', [['set', 'user:tv:cust-1', '0', {}]]);
        const tok = await accessToken({
          userId: 'cust-1',
          jti: 'jw1',
          role: 'customer',
          storeId: SID,
        });
        const h = { ...H, authorization: `Bearer ${tok}`, ...json };
        const add = await api('/wishlist', {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ productId: PID }),
        });
        if (add.status >= 300) return add;
        return api('/wishlist', { headers: h });
      },
    ],
  ];
  it('seed', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    await e.PLATFORM_DB.prepare(
      'INSERT OR REPLACE INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, ?2, ?3, ?4, ?5)'
    )
      .bind(SID, 'S', 'spike-shop', 'owner-1', 'do')
      .run();
    const now = Date.now();
    const r = await api(`/internal/store-do/${SID}/seed`, {
      method: 'POST',
      headers: { authorization: 'Bearer workers-test-seed-token', ...json },
      body: JSON.stringify({
        store: { id: SID, slug: 'spike-shop', name: 'S', currency: 'EGP' },
        products: [
          {
            id: PID,
            storeId: SID,
            name: 'P',
            slug: 'p',
            price: 1000,
            inventory: 5,
            status: 'active',
            hasVariants: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    });
    expect(r.status).toBe(200);
    // The steady state of production: the store's feature map is in the cache (5 min TTL, features:store:v3:<id>). Its COLD
    // read is the platform feature tables (N-10b), not this PR's reads, so the harness starts warm.
    const map = Object.fromEntries(FEATURE_KEYS_ARRAY.map(k => [k, k === 'bundles']));
    await e.KV_CACHE.put(`cache:features:store:v3:${SID}`, JSON.stringify(map), {
      expirationTtl: 600,
    });
  });
  // Every route answers 2xx from the DO + D1 + KV alone. The checkout quote still needs two platform reads that are not in
  // this PR: the plan entitlement (billing family, N-10a, served by D1 only after its cutover marker) and the per-store
  // `store_features` override (N-10b). `it.fails` is the tripwire: it goes red the day the quote works, so the flag is flipped.
  const blocked = new Set(['checkout quote']);
  const expect404 = new Set(['verify-payment (order read from the DO)']);
  for (const [name, call] of probe) {
    const run = async () => {
      const r = await call();
      const body = await r.text();
      if (r.status >= 300 && !blocked.has(name))
        console.log(`PROBE ${name}: ${r.status} ${body.slice(0, 300)}`);
      if (expect404.has(name)) expect(r.status).toBe(404);
      else expect(r.status).toBeLessThan(300);
    };
    if (blocked.has(name)) it.fails(`${name} (blocked on N-10a/N-10b)`, run);
    else it(name, run);
  }
});
