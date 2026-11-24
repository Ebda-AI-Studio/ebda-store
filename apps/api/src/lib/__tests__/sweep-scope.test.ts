/**
 * Sentry N+1 class: a store-looping run must cost 1 + constant D1 reads, never one per store.
 * Counts the `stores.storage_backend` reads for N stores inside and outside a sweep scope, and the memoised `system_settings` read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql: string[] = [];
const directory = new Map<string, string>();

vi.mock('../../cf/bindings', () => ({
  cfBindings: () => ({
    PLATFORM_DB: {
      prepare: (q: string) => {
        sql.push(q);
        const run = (args: unknown[]) => {
          if (q.includes('WHERE id = ?'))
            return {
              results: [],
              row: directory.has(String(args[0]))
                ? { storage_backend: directory.get(String(args[0])) }
                : null,
            };
          const after = String(args[0] ?? '');
          const ids = [...directory.keys()].sort().filter(id => id > after);
          return {
            results: ids.map(id => ({ id, storage_backend: directory.get(id) })),
            row: null,
          };
        };
        return {
          bind: (...args: unknown[]) => ({
            first: async () => run(args).row,
            all: async () => ({ results: run(args).results }),
          }),
        };
      },
    },
  }),
}));

import { backendFor } from '../store-backend';
import { withSweepScope, sweepMemo } from '../sweep-scope';
import { AppError } from '../../middleware/error-handler';

const readsOfStores = () => sql.filter(q => /FROM stores/.test(q)).length;

describe('store-looping runs read the backend flag in 1 + constant queries', () => {
  beforeEach(() => {
    sql.length = 0;
    directory.clear();
  });

  for (const n of [3, 25, 120]) {
    it(`${n} stores in a sweep scope: constant reads (not ${n})`, async () => {
      const ids = Array.from({ length: n }, (_, i) => `store-${String(i).padStart(4, '0')}`);
      ids.forEach(id => directory.set(id, 'do'));
      const out = await withSweepScope(() => Promise.all(ids.map(id => backendFor(id))));
      expect(out.every(b => b === 'do')).toBe(true);
      // 1 single-row read for the first store + ceil(n/1000) directory pages
      expect(readsOfStores()).toBeLessThanOrEqual(2);
    });
  }

  it('without a scope it is one read per store (the shape the scope removes)', async () => {
    ['a', 'b', 'c'].forEach(id => directory.set(id, 'do'));
    for (const id of ['a', 'b', 'c']) await backendFor(id);
    expect(readsOfStores()).toBe(3);
  });

  it('a single-store run keeps its one indexed read', async () => {
    directory.set('only', 'do');
    await withSweepScope(async () => {
      await backendFor('only');
      await backendFor('only');
    });
    expect(readsOfStores()).toBe(1);
  });

  it('a gone store inside a sweep still 404s and the sweep goes on (skip-and-continue)', async () => {
    ['s1', 's2'].forEach(id => directory.set(id, 'do'));
    const results = await withSweepScope(() =>
      Promise.all(
        ['s1', 'gone', 's2'].map(id =>
          backendFor(id).catch(err => (err instanceof AppError ? err.statusCode : 'x'))
        )
      )
    );
    expect(results).toEqual(['do', 404, 'do']);
  });

  it('each scope re-reads: a flip lands on the next run', async () => {
    ['x', 'y'].forEach(id => directory.set(id, 'do'));
    const run = () => withSweepScope(() => Promise.all(['x', 'y'].map(id => backendFor(id))));
    await run();
    const first = readsOfStores();
    await run();
    expect(readsOfStores()).toBe(first * 2);
  });

  it('sweepMemo loads once per scope and never outside one', async () => {
    const load = vi.fn(async () => 1);
    await withSweepScope(async () => {
      await sweepMemo('k', load);
      await sweepMemo('k', load);
      await sweepMemo('k', load);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await sweepMemo('k', load);
    await sweepMemo('k', load);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
