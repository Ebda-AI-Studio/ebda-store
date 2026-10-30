/**
 * Store backend flag (Rulings INFRA-CF-1, CF-BACKEND-1): server-side state only (D1 stores.storage_backend, env list when D1
 * is unbound outside production). No request header chooses the backend; an unreadable flag is a 503.
 */
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';
import { backendFor, enabledStoreIds } from '../../apps/api/src/lib/store-backend';

const DEMO = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';

describe('store backend flag', () => {
  it('is empty (nobody) by default', () => {
    expect(enabledStoreIds(undefined).size).toBe(0);
    expect(enabledStoreIds('').size).toBe(0);
    expect(enabledStoreIds(' , ,').size).toBe(0);
  });

  const d1 = (row: unknown | Error) => ({
    prepare: () => ({
      bind: () => ({
        first: async () => {
          if (row instanceof Error) throw row;
          return row;
        },
      }),
    }),
  });
  const withD1 = async <T>(db: unknown, fn: () => Promise<T>) => {
    setCfBindings({ PLATFORM_DB: db } as never);
    try {
      return await fn();
    } finally {
      clearCfBindings();
    }
  };

  describe('D1 bound: the stores.storage_backend column decides, the request never does (Ruling CF-BACKEND-1)', () => {
    it('a do store stays do without any header, and a pg store stays pg', async () => {
      expect(await withD1(d1({ storage_backend: 'do' }), () => backendFor(DEMO))).toBe('do');
      expect(await withD1(d1({ storage_backend: 'pg' }), () => backendFor(DEMO))).toBe('pg');
    });
    it('the env list is ignored once D1 is bound (a listed pg store is pg)', async () => {
      process.env.STORE_DO_ENABLED_IDS = DEMO;
      try {
        expect(await withD1(d1({ storage_backend: 'pg' }), () => backendFor(DEMO))).toBe('pg');
      } finally {
        delete process.env.STORE_DO_ENABLED_IDS;
      }
    });
    it('backendFor takes no request: the retired x-ebda-backend header has no way in', () => {
      expect(backendFor.length).toBe(1);
    });
    it('a store without a directory row is not flagged', async () => {
      expect(await withD1(d1(null), () => backendFor(DEMO))).toBe('pg');
    });
    it('an unreadable or malformed flag is a 503, never a default to pg', async () => {
      await expect(withD1(d1(new Error('d1 down')), () => backendFor(DEMO))).rejects.toMatchObject({
        statusCode: 503,
        code: 'STORE_BACKEND_UNAVAILABLE',
      });
      await expect(
        withD1(d1({ storage_backend: 'x' }), () => backendFor(DEMO))
      ).rejects.toMatchObject({
        statusCode: 503,
      });
    });
  });

  describe('D1 unbound (Node, tests, local)', () => {
    it('falls back to the env list outside production', async () => {
      process.env.STORE_DO_ENABLED_IDS = ` ${DEMO} , other `;
      try {
        expect(await backendFor(DEMO)).toBe('do');
        expect(await backendFor('not-listed')).toBe('pg');
      } finally {
        delete process.env.STORE_DO_ENABLED_IDS;
      }
    });
    it('unset list keeps every store on Postgres', async () => {
      delete process.env.STORE_DO_ENABLED_IDS;
      expect(await backendFor(DEMO)).toBe('pg');
    });
    it('in production a listed store with no D1 is a 503, an unlisted one is pg', async () => {
      process.env.STORE_DO_ENABLED_IDS = DEMO;
      vi.stubEnv('NODE_ENV', 'production');
      try {
        await expect(backendFor(DEMO)).rejects.toMatchObject({ statusCode: 503 });
        expect(await backendFor('not-listed')).toBe('pg');
      } finally {
        vi.unstubAllEnvs();
        delete process.env.STORE_DO_ENABLED_IDS;
      }
    });
  });

  it('no handler reads the client header: only the edge strippers mention x-ebda-backend', () => {
    const hits = execFileSync('git', ['grep', '-n', 'x-ebda-backend', '--', 'apps/api/src'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(l => l && !/^\S+:\d+:\s*(\/\/|\*|\/\*)/.test(l));
    const files = new Set(hits.map(l => l.split(':')[0]));
    expect([...files].sort()).toEqual([
      'apps/api/src/app.ts',
      'apps/api/src/cf/public-edge-cache.ts',
      'apps/api/src/worker.ts',
    ]);
  });

  it('the committed wrangler config does not define the env flag: D1 is the one source (Ruling CF-R6B-1)', async () => {
    const { readFileSync } = await import('node:fs');
    const w = readFileSync('apps/api/wrangler.jsonc', 'utf8');
    expect(w).not.toMatch(/"STORE_DO_ENABLED_IDS"\s*:/);
  });
});
