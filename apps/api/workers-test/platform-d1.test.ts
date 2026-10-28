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

const health = async () =>
  (
    (await (await e.API.fetch('https://api.ebda.app/health')).json()) as {
      storage_backend?: Record<string, number> | null;
    }
  ).storage_backend;

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

  it('/health reports storage_backend counts straight from D1, and a flag write shows immediately', async () => {
    expect(await health()).toEqual({});
    await insert('s1', 'pg');
    await insert('s2', 'pg');
    expect(await health()).toEqual({ pg: 2 });
    await e.PLATFORM_DB.prepare("UPDATE stores SET storage_backend = 'do' WHERE id = ?1")
      .bind('s2')
      .run();
    expect(await health()).toEqual({ pg: 1, do: 1 });
  });

  it('the schema CHECK refuses a backend other than pg/do', async () => {
    await expect(insert('s3', 'maybe')).rejects.toThrow();
  });
});
