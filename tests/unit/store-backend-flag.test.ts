/**
 * Backend selector (Ruling INFRA-CF-1, task 2.4; Ruling CF-PLATFORM-1).
 *
 * With the D1 `ebda-platform` binding present, `stores.storage_backend` is the ONE switch and is read on every
 * call (NEVER-stale: no cache layer exists to invalidate). Without the binding in Node/tests the Phase 0 spike gate
 * applies (id in STORE_DO_ENABLED_IDS AND `x-ebda-backend: do`). An unresolved id or an unreadable flag fails closed.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  backendFor,
  enabledStoreIds,
  storageBackendCounts,
  type PlatformD1Like,
} from '../../apps/api/src/lib/store-backend';
import * as bindings from '../../apps/api/src/cf/bindings';

const req = (h: Record<string, string> = {}) => ({ headers: h });
const DEMO = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';

/** A tiny in-memory D1: `stores` rows plus a query log. */
function fakeD1(rows: Record<string, string>) {
  const log: string[] = [];
  const db: PlatformD1Like & { rows: Record<string, string>; fail?: boolean } = {
    rows,
    prepare(sql: string) {
      log.push(sql);
      const run = (args: unknown[]) => ({
        async first() {
          if (db.fail) throw new Error('D1_ERROR: boom');
          const id = String(args[0]);
          return id in db.rows ? { storage_backend: db.rows[id] } : null;
        },
        async all() {
          if (db.fail) throw new Error('D1_ERROR: boom');
          const counts: Record<string, number> = {};
          for (const v of Object.values(db.rows)) counts[v] = (counts[v] ?? 0) + 1;
          return {
            results: Object.entries(counts).map(([storage_backend, n]) => ({ storage_backend, n })),
          };
        },
      });
      return { ...run([]), bind: (...a: unknown[]) => run(a) };
    },
  };
  return Object.assign(db, { log });
}

const bind = (db: PlatformD1Like | undefined) =>
  vi.spyOn(bindings, 'cfBindings').mockReturnValue({ PLATFORM_DB: db } as never);

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.STORE_DO_ENABLED_IDS;
  vi.unstubAllEnvs();
});

describe('store backend flag, D1 unbound (Node / local / tests)', () => {
  it('is empty (nobody) by default', () => {
    expect(enabledStoreIds(undefined).size).toBe(0);
    expect(enabledStoreIds('').size).toBe(0);
    expect(enabledStoreIds(' , ,').size).toBe(0);
  });

  it('serves from the DO only when the id is listed AND the request opts in', async () => {
    process.env.STORE_DO_ENABLED_IDS = ` ${DEMO} , other `;
    expect(await backendFor(DEMO, req({ 'x-ebda-backend': 'do' }))).toBe('do');
    expect(await backendFor(DEMO, req())).toBe('pg'); // listed but no opt-in
    expect(await backendFor(DEMO, req({ 'x-ebda-backend': 'pg' }))).toBe('pg');
    expect(await backendFor('not-listed', req({ 'x-ebda-backend': 'do' }))).toBe('pg');
  });

  it('unset flag keeps even an opted-in request on Postgres', async () => {
    expect(await backendFor(DEMO, req({ 'x-ebda-backend': 'do' }))).toBe('pg');
  });

  it('a Worker in production with the binding missing fails closed instead of falling back', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.STORE_DO_ENABLED_IDS = DEMO;
    bind(undefined);
    await expect(backendFor(DEMO, req({ 'x-ebda-backend': 'do' }))).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLATFORM_DB_UNBOUND',
    });
  });
});

describe('store backend flag, D1 bound', () => {
  it('reads stores.storage_backend and ignores the env list and the header', async () => {
    process.env.STORE_DO_ENABLED_IDS = DEMO;
    bind(fakeD1({ [DEMO]: 'pg', other: 'do' }));
    expect(await backendFor(DEMO, req({ 'x-ebda-backend': 'do' }))).toBe('pg');
    expect(await backendFor('other', req())).toBe('do');
  });

  it('NEVER-stale: a flag write is seen by the very next call (no cache layer between)', async () => {
    const db = fakeD1({ s1: 'pg' });
    bind(db);
    expect(await backendFor('s1', req())).toBe('pg');
    db.rows.s1 = 'do';
    expect(await backendFor('s1', req())).toBe('do');
    db.rows.s1 = 'pg';
    expect(await backendFor('s1', req())).toBe('pg');
    expect(db.log.length).toBe(3);
  });

  it('a store with no row yet (platform not migrated into D1) is on Postgres, never flipped by guess', async () => {
    bind(fakeD1({ other: 'do' }));
    expect(await backendFor('s-unmigrated', req({ 'x-ebda-backend': 'do' }))).toBe('pg');
  });

  it('fails closed (503) when D1 cannot be read; it never guesses a backend', async () => {
    const db = fakeD1({ s1: 'do' });
    db.fail = true;
    bind(db);
    await expect(backendFor('s1', req())).rejects.toMatchObject({
      statusCode: 503,
      code: 'STORE_BACKEND_UNAVAILABLE',
    });
  });

  it('fails closed on an unknown flag value', async () => {
    bind(fakeD1({ s1: 'maybe' }));
    await expect(backendFor('s1', req())).rejects.toMatchObject({
      statusCode: 503,
      code: 'STORE_BACKEND_UNAVAILABLE',
    });
  });

  it.each(['', '   ', undefined, null])(
    'an unresolved store id (%j) is a 404, never "first store"',
    async id => {
      const db = fakeD1({ s1: 'do' });
      bind(db);
      await expect(backendFor(id as never, req())).rejects.toMatchObject({
        statusCode: 404,
        code: 'STORE_NOT_FOUND',
      });
      expect(db.log).toHaveLength(0);
    }
  );
});

describe('storageBackendCounts (/health)', () => {
  it('returns the GROUP BY of stores.storage_backend', async () => {
    expect(await storageBackendCounts(fakeD1({ a: 'pg', b: 'pg', c: 'do' }))).toEqual({
      pg: 2,
      do: 1,
    });
  });
  it('is undefined with no binding (local) and null when D1 cannot be read', async () => {
    expect(await storageBackendCounts(undefined)).toBeUndefined();
    const db = fakeD1({ a: 'pg' });
    db.fail = true;
    expect(await storageBackendCounts(db)).toBeNull();
  });
});

describe('wrangler config', () => {
  it('the committed spike flag is at most the one Phase 0 demo store, never the QA walk store', async () => {
    const { readFileSync } = await import('node:fs');
    const w = readFileSync('apps/api/wrangler.jsonc', 'utf8');
    const m = w.match(/"STORE_DO_ENABLED_IDS":\s*"([^"]*)"/);
    expect(m).not.toBeNull();
    const ids = m![1].split(',').filter(Boolean);
    expect(ids.length).toBeLessThanOrEqual(1);
    for (const id of ids) expect(id).toBe(DEMO);
  });

  it('binds D1 ebda-platform as PLATFORM_DB with the cf-schema platform migrations', async () => {
    const { readFileSync } = await import('node:fs');
    const w = readFileSync('apps/api/wrangler.jsonc', 'utf8');
    expect(w).toMatch(/"binding":\s*"PLATFORM_DB"/);
    expect(w).toMatch(/"database_name":\s*"ebda-platform"/);
    expect(w).toContain('"migrations_dir": "../../packages/cf-schema/migrations/platform"');
  });
});

describe('/health payload', () => {
  it('carries storage_backend counts when D1 is bound, null when unreadable, omitted when unbound', async () => {
    const { healthPayload } = await import('../../apps/api/src/lib/health-payload');
    bind(fakeD1({ a: 'pg', b: 'do', c: 'do' }));
    expect((await healthPayload({} as never)).storage_backend).toEqual({ pg: 1, do: 2 });
    const bad = fakeD1({ a: 'pg' });
    bad.fail = true;
    bind(bad);
    expect((await healthPayload({} as never)).storage_backend).toBeNull();
    bind(undefined);
    expect('storage_backend' in (await healthPayload({} as never))).toBe(false);
  });
});
