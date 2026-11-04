/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

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
