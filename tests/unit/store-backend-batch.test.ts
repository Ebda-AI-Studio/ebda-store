// Sentry EBDA-API-Z: a sweep over N stores must read `storage_backend` in O(1) D1 queries, not 1+ per store per call.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  flags: new Map<string, string>(),
  single: { n: 0 },
  batch: { n: 0 },
  maxParams: { n: 0 },
}));
vi.mock('../../apps/api/src/cf/bindings', () => ({
  cfBindings: () => ({
    PLATFORM_DB: {
      prepare: (sql: string) => ({
        bind: (...v: string[]) => ({
          first: async () => {
            h.single.n++;
            return h.flags.has(v[0]) ? { storage_backend: h.flags.get(v[0]) } : null;
          },
          all: async () => {
            h.batch.n++;
            h.maxParams.n = Math.max(h.maxParams.n, v.length);
            expect(sql).toContain('IN (');
            return {
              results: v
                .filter(id => h.flags.has(id))
                .map(id => ({ id, storage_backend: h.flags.get(id) })),
            };
          },
        }),
      }),
    },
  }),
}));

import { backendFor, withBackendBatch } from '../../apps/api/src/lib/store-backend';

const ids = Array.from({ length: 20 }, (_, i) => `store-${i}`);
beforeEach(() => {
  h.flags.clear();
  for (const id of ids) h.flags.set(id, 'do');
  h.single.n = 0;
  h.batch.n = 0;
  h.maxParams.n = 0;
});

describe('withBackendBatch', () => {
  it('baseline: unbatched, 20 stores x 3 calls cost 60 reads (the N+1)', async () => {
    for (const id of ids) for (let k = 0; k < 3; k++) await backendFor(id);
    expect(h.single.n).toBe(60);
  });

  it('batched, 20 stores x 3 calls cost ONE read', async () => {
    await withBackendBatch(ids, async () => {
      for (const id of ids) for (let k = 0; k < 3; k++) expect(await backendFor(id)).toBe('do');
    });
    expect(h.single.n).toBe(0);
    expect(h.batch.n).toBe(1);
    expect(h.maxParams.n).toBeLessThanOrEqual(90);
  });

  it('chunks under the 100-parameter limit', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `m-${i}`);
    many.forEach(id => h.flags.set(id, 'do'));
    await withBackendBatch(many, async () => {
      await backendFor('m-199');
    });
    expect(h.batch.n).toBe(3);
    expect(h.maxParams.n).toBeLessThanOrEqual(90);
  });

  it('an id missing from the batch still gets the live read and the same 404 (never a guess)', async () => {
    await withBackendBatch(['store-0', 'ghost'], async () => {
      await expect(backendFor('ghost')).rejects.toMatchObject({ statusCode: 404 });
    });
    expect(h.single.n).toBe(1);
  });

  it('is scoped to the run: after it returns, backendFor reads live again (no cross-run cache)', async () => {
    await withBackendBatch(ids, async () => backendFor('store-0'));
    h.flags.set('store-0', 'pg');
    await expect(backendFor('store-0')).resolves.toBeDefined();
    expect(h.single.n).toBe(1);
  });

  it('no stores: runs fn with no batch read', async () => {
    await withBackendBatch([], async () => backendFor('store-1'));
    expect(h.batch.n).toBe(0);
    expect(h.single.n).toBe(1);
  });
});

describe('withBackendBatch isolation and cleanup', () => {
  it('a call OUTSIDE the batch while one is active does a live read (concurrent request isolation)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const run = withBackendBatch(ids, async () => {
      await gate;
      await backendFor('store-0'); // inside: from the batch
    });
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));
    h.flags.set('store-0', 'pg');
    const outside = await backendFor('store-0'); // not inside the ALS run: live
    expect(outside).toBe('pg');
    expect(h.single.n).toBe(1);
    release();
    await run;
    expect(h.single.n).toBe(1);
  });

  it('fn throwing propagates and the next call outside sees no batch', async () => {
    await expect(
      withBackendBatch(ids, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(h.batch.n).toBe(1); // fn was not re-run
    await backendFor('store-1');
    expect(h.single.n).toBe(1);
  });
});
