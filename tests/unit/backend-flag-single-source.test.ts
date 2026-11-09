/**
 * Ruling CF-BACKEND-2: ONE source of truth for "which stores are on the Durable Object". The D1 column (`backendFor` /
 * `doStoreIdList`) decides wherever D1 is bound; the `STORE_DO_ENABLED_IDS` env list is only the local/test fallback and is
 * read in exactly one place (lib/store-backend.ts). A store flipped only in D1 must be seen by every consumer.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCfBindings } from '../../apps/api/src/cf/bindings';
import { doStoreIdList, doStoreIdSet } from '../../apps/api/src/lib/store-backend';
import { decideRunForStore, doStoreIds } from '../../apps/api/src/lib/jobs/do-guard';
import { runBackupSweep } from '../../apps/api/src/cf/ops/backup-sweep';

const ROOT = path.resolve(__dirname, '../..');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function d1(doStores: string[], opts: { throws?: boolean } = {}) {
  return {
    prepare: (_sql: string) => ({
      all: async () => {
        if (opts.throws) throw new Error('d1 down');
        return { results: doStores.map(id => ({ id })) };
      },
      bind: (id: string) => ({
        first: async () => (doStores.includes(id) ? { storage_backend: 'do' } : null),
      }),
    }),
  };
}

afterEach(() => {
  setCfBindings(undefined as never);
  vi.unstubAllEnvs();
});

describe('guard: no production read of STORE_DO_ENABLED_IDS outside the selector', () => {
  it('only lib/store-backend.ts reads it', () => {
    const files = execFileSync('git', ['ls-files', 'apps', 'packages'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(f => /\.(ts|tsx|mts|js|mjs)$/.test(f))
      .filter(
        f =>
          !/(^|\/)(tests?|__tests__)\//.test(f) &&
          !/\.test\./.test(f) &&
          !/vitest[^/]*\.config\./.test(f)
      );
    // ONE `git grep` over the tracked tree (was one `grep` per file: ~3.3k processes timed out under full-suite load).
    let hits: Set<string>;
    try {
      hits = new Set(
        execFileSync('git', ['grep', '-l', 'STORE_DO_ENABLED_IDS', '--', 'apps', 'packages'], {
          cwd: ROOT,
          encoding: 'utf8',
        })
          .split('\n')
          .filter(Boolean)
      );
    } catch {
      hits = new Set(); // git grep exits 1 on no match
    }
    const offenders = files.filter(f => f !== 'apps/api/src/lib/store-backend.ts' && hits.has(f));
    expect(offenders).toEqual([]);
  });

  it('the selector itself reads it (the guard is not vacuous)', () => {
    const out = execFileSync(
      'grep',
      ['-c', 'STORE_DO_ENABLED_IDS', 'apps/api/src/lib/store-backend.ts'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      }
    );
    expect(Number(out.trim())).toBeGreaterThan(0);
  });
});

describe('doStoreIdList: D1 is the source when bound', () => {
  it('lists the D1 do-stores and ignores the env list', async () => {
    vi.stubEnv('STORE_DO_ENABLED_IDS', B);
    setCfBindings({ PLATFORM_DB: d1([A]) } as never);
    expect(await doStoreIdList()).toEqual([A]);
  });
  it('falls back to the env list only where D1 is unbound (not production)', async () => {
    vi.stubEnv('STORE_DO_ENABLED_IDS', `${A}, ${B}`);
    expect((await doStoreIdSet()).size).toBe(2);
  });
  it('production with a listed store and no D1 is a 503, not a silent fallback', async () => {
    vi.stubEnv('STORE_DO_ENABLED_IDS', A);
    vi.stubEnv('NODE_ENV', 'production');
    await expect(doStoreIdList()).rejects.toMatchObject({ statusCode: 503 });
  });
  it('an unreadable directory fails closed (503), never "no DO stores"', async () => {
    setCfBindings({ PLATFORM_DB: d1([A], { throws: true }) } as never);
    await expect(doStoreIdList()).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('consumers see a store flipped only in D1', () => {
  it('jobs guard: the flipped store is a DO store and its unported job is refused', async () => {
    vi.stubEnv('JOBS_ON_DO', '1');
    setCfBindings({ PLATFORM_DB: d1([A]) } as never);
    expect((await doStoreIds()).has(A)).toBe(true);
    const def = { id: 'fixture-unported-job', options: { id: 'x' }, handler: async () => 1 };
    expect(await decideRunForStore(def, A)).toMatchObject({ run: false, storeId: A });
    expect(await decideRunForStore(def, B)).toEqual({ run: true });
  });

  it('backup sweep: the list it sweeps is the D1 one', async () => {
    setCfBindings({ PLATFORM_DB: d1([A]) } as never);
    const seen: string[] = [];
    const armed: string[] = [];
    const env = {
      STORE_BACKUPS: {
        put: async () => undefined,
        get: async () => null,
        list: async () => ({ objects: [] }),
      },
      STORE_DO: {
        idFromName: (n: string) => n,
        get: (n: string) => ({
          ensureBackupAlarm: async () => {
            armed.push(n);
            return 1;
          },
        }),
      },
    };
    await runBackupSweep(env as never, {
      listStoreIds: async () => {
        const ids = await doStoreIdList();
        seen.push(...ids);
        return ids;
      },
      alert: async () => undefined,
    }).catch(() => undefined);
    expect(seen).toEqual([A]);
  });
});
