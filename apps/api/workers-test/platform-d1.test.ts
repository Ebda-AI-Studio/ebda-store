/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

// Task 2.4: the BUILT Worker reads D1 `ebda-platform` (real cf-schema platform migrations, local D1 shared by id with
// the test worker). /health reports per-backend store counts and a flag write shows on the very next read.
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  PLATFORM_DB: {
    exec(sql: string): Promise<unknown>;
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
};

// Public /health: reachability only. Per-backend counts disclose the store count and live on the super_admin
// /api/v1/health (counts logic proven in tests/unit/store-backend-flag.test.ts).
const health = async () =>
  (await (await e.API.fetch('https://api.ebda.app/health')).json()) as Record<string, unknown>;

const insert = (id: string, backend: string) =>
  e.PLATFORM_DB.prepare(
    'INSERT INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, ?2, ?3, ?4, ?5)'
  )
    .bind(id, id, id, 'owner-1', backend)
    .run();

describe('platform D1 in the built Worker', () => {
  beforeAll(async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
  });

  it('public /health reports platform_db ok and never the per-backend counts', async () => {
    await insert('s1', 'pg');
    await insert('s2', 'do');
    const body = await health();
    expect(body.platform_db).toBe('ok');
    expect('storage_backend' in body).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/"(pg|do)":/);
  });

  it('the schema CHECK refuses a backend other than pg/do', async () => {
    await expect(insert('s3', 'maybe')).rejects.toThrow();
  });
});
