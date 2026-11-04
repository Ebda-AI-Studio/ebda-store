/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';

// Ruling ROLE-GUARD-LAZY-1: with Postgres unreachable (Neon quota, 2026-10-31) the built Worker still serves
// everything D1 / a Durable Object answers. Run with EBDA_WORKERS_TEST_DB_URL pointing at a dead port.
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
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
  it('N-18: a store is CREATED on D1 + its DO with Postgres dead, then served', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    // plans are platform data (imported in production); the subscription row's FK needs them
    for (const p of DEFAULT_PLAN_SEEDS)
      await e.PLATFORM_DB.prepare(
        'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      )
        .bind(`plan-${p.code}`, p.code, p.nameEn, p.nameAr, p.featureTier, JSON.stringify(p.limits))
        .run();
    const created = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: 'owner-n18',
        name: 'N18 Shop',
        slug: 'n18-shop',
        operator: true,
      }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    // D1 directory row + subscription, written with no Postgres
    const row = await (
      e.PLATFORM_DB as unknown as {
        prepare(s: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } };
      }
    )
      .prepare(
        'SELECT s.storage_backend AS b, s.status AS st, sub.status AS sub FROM stores s JOIN store_subscriptions sub ON sub.store_id = s.id WHERE s.id = ?1'
      )
      .bind(id)
      .first<{ b: string; st: string; sub: string }>();
    expect(row).toEqual({ b: 'do', st: 'active', sub: 'active' });

    const headers = {
      authorization: 'Bearer workers-test-seed-token',
      'content-type': 'application/json',
    };
    // the DO is bootstrapped: the new store answers a counts probe (profile and the inactive VAT rate exist)
    const counts = await e.API.fetch(`https://api.ebda.app/api/v1/internal/store-do/${id}/counts`, {
      headers,
    });
    expect(counts.status).toBe(200);
    const body = (await counts.json()) as { data?: Record<string, number> } & Record<
      string,
      number
    >;
    const c = body.data ?? body;
    expect(c.store_profile).toBe(1);
    expect(c.tax_rates).toBe(1);

    // The storefront / auth reads are N-2..N-4 / N-9 (other tracks): today they need Postgres for ANY store. What N-18 owes is that a
    // CREATED store behaves exactly like a store the platform already flagged `do`, so it is compared with the seeded spike store.
    const probeAll = async (storeId: string, slug: string) => {
      const h = { 'x-store-id': storeId };
      const get = async (u: string, init?: RequestInit) => (await e.API.fetch(u, init)).status;
      return {
        home: await get(`https://api.ebda.app/api/v1/public/stores/${slug}`),
        products: await get('https://api.ebda.app/api/v1/public/products', { headers: h }),
        pdp: await get('https://api.ebda.app/api/v1/public/products/no-such-product', {
          headers: h,
        }),
        cart: await get('https://api.ebda.app/api/v1/public/cart/items', {
          method: 'POST',
          headers: { ...h, 'content-type': 'application/json', 'x-session-id': 'sess-1' },
          body: JSON.stringify({
            productId: '33333333-3333-4333-8333-333333333333',
            quantity: 1,
          }),
        }),
      };
    };
    expect(await probeAll(id, 'n18-shop')).toEqual(await probeAll('spike-store-1', 's'));
  });

  // NEON-ZERO-1 N-12 (Rulings NZ-N12-1..3): a payment gateway callback for a Durable Object store resolves its store from the
  // D1 entity index and records/reads the inbox in D1; with Postgres dead nothing 5xx-es from a Postgres lookup.
  describe('payment webhooks for a Durable Object store', () => {
    const WH_STORE = '3c1f7a52-9d44-4e0b-8f6a-2b7d5c9e1a10';
    const hook = (txn: string) =>
      e.API.fetch('https://api.ebda.app/api/v1/webhooks/payment/paymob?hmac=deadbeef', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'TRANSACTION', obj: { id: 777, order: { id: txn } } }),
      });

    it('an unknown reference is a 503 retry (never a Postgres 500); a known one reaches the DO config read', async () => {
      await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, ?2, ?3, ?4, ?5)'
      )
        .bind(WH_STORE, 'wh', 'wh', 'owner-1', 'do')
        .run();
      const unknown = await hook('no-such-ref');
      expect(unknown.status).toBe(503);
      await e.PLATFORM_DB.prepare(
        "INSERT OR REPLACE INTO entity_index (kind, id, store_id) VALUES ('webhook', 'paymob:T-WH-1', ?1)"
      )
        .bind(WH_STORE)
        .run();
      // Resolved from the index to the DO store, whose DO holds no provider config here: the refusal is the DO-side
      // "provider not configured", i.e. the request got past the resolver and the config read WITHOUT Postgres.
      const known = await hook('T-WH-1');
      const body = (await known.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    });
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
