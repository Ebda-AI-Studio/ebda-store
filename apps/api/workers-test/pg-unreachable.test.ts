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
