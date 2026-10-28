/**
 * INFRA-CF-1 task 2.4 (Ruling CF-REPO-1): lib/repo-factory.ts hands a service its store's backend. Postgres is the default
 * and changes nothing; a store flagged 'do' gets a Durable Object READ client bound to that store; an unresolved store is a
 * 404; an unbound DO is a 503 (never a silent Postgres fallback); the flag is read once per request and store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runReads } from '@ebda-src/repo';

const { PG, state } = vi.hoisted(() => ({
  PG: { marker: 'prisma-proxy' },
  state: {
    backend: 'pg' as 'pg' | 'do',
    backendCalls: [] as string[],
    queries: [] as Array<{ storeId: string; queries: unknown[] }>,
    doBound: true,
    result: { ok: true as const, json: '[[]]' } as unknown,
  },
}));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  prisma: PG,
}));
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: (storeId: string) => {
    state.backendCalls.push(storeId);
    return state.backend;
  },
  storeDo: (storeId: string) => {
    if (!state.doBound) {
      const e = new Error('Store Durable Object is not bound') as Error & { statusCode: number };
      e.statusCode = 503;
      throw e;
    }
    return {
      query: async (id: string, queries: unknown[]) => {
        state.queries.push({ storeId: id, queries });
        return state.result;
      },
      __for: storeId,
    };
  },
}));

import { repoScope, storeDb, storeRepo, withRepo } from '../../apps/api/src/lib/repo-factory';

beforeEach(() => {
  state.backend = 'pg';
  state.backendCalls = [];
  state.queries = [];
  state.doBound = true;
  state.result = { ok: true, json: '[[]]' };
});

const inScope = <T>(fn: () => Promise<T>): Promise<T> =>
  new Promise((resolve, reject) =>
    repoScope({ headers: {} } as never, {} as never, () => fn().then(resolve, reject))
  );

describe('repo factory', () => {
  it('Postgres is the default: a store on pg gets the very same prisma proxy services use today', async () => {
    const repo = await storeRepo('s1');
    expect(repo).toMatchObject({ storeId: 's1', backend: 'pg' });
    expect(repo.db).toBe(PG);
    expect(await storeDb('s1')).toBe(PG);
    expect(state.queries).toEqual([]); // no Durable Object was touched
  });

  it('an unresolved store id is a 404, never a default and never the first store', async () => {
    for (const bad of ['', '   ', undefined as unknown as string, null as unknown as string])
      await expect(storeRepo(bad)).rejects.toMatchObject({
        statusCode: 404,
        code: 'STORE_NOT_FOUND',
      });
    expect(state.backendCalls).toEqual([]); // not even the flag was consulted
  });

  it('a store flagged do gets a read client that talks to ITS Durable Object with ITS id', async () => {
    state.backend = 'do';
    const db = (await storeDb('store-a')) as unknown as {
      blogPost: { findMany(a: unknown): PromiseLike<unknown> };
    };
    await db.blogPost.findMany({ where: { isPublished: true } });
    expect(state.queries).toEqual([
      {
        storeId: 'store-a',
        queries: [{ model: 'BlogPost', op: 'findMany', args: { where: { isPublished: true } } }],
      },
    ]);
    // a client for store B never sends store A's id
    const dbB = (await storeDb('store-b')) as unknown as {
      tag: { count(): PromiseLike<unknown> };
    };
    await dbB.tag.count();
    expect(state.queries.map(q => q.storeId)).toEqual(['store-a', 'store-b']);
  });

  it('the do client cannot write: the operation does not exist, nothing leaves the Worker', async () => {
    state.backend = 'do';
    const db = (await storeDb('store-a')) as unknown as {
      product: { create?: unknown; findMany: unknown };
    };
    expect(db.product.create).toBeUndefined();
    expect(() => (db as unknown as { $queryRaw: unknown }).$queryRaw).toThrow(/not available/);
    expect(state.queries).toEqual([]);
  });

  it('a DO that is not bound is a 503, NOT a silent fall back to Postgres', async () => {
    state.backend = 'do';
    state.doBound = false;
    await expect(storeRepo('s1')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('a P-coded failure of the DO is re-raised as the Prisma error the API handler already understands', async () => {
    state.backend = 'do';
    state.result = { ok: false, code: 'P2025', message: 'No Product found' };
    const db = (await storeDb('s1')) as unknown as {
      product: { findFirstOrThrow(a?: unknown): PromiseLike<unknown> };
    };
    await expect(db.product.findFirstOrThrow({})).rejects.toMatchObject({
      code: 'P2025',
      name: 'PrismaClientKnownRequestError',
    });
  });

  it('inside a request the flag is read ONCE per store, however many services ask; outside a request every call reads it', async () => {
    await inScope(async () => {
      await Promise.all([storeDb('s1'), storeDb('s1'), storeRepo('s1')]);
      await storeDb('s1');
      await storeDb('s2');
    });
    expect(state.backendCalls).toEqual(['s1', 's2']);
    state.backendCalls = [];
    await storeDb('s1');
    await storeDb('s1');
    expect(state.backendCalls).toEqual(['s1', 's1']);
  });

  it('requests do not share a memo (a flip between two requests is seen by the second)', async () => {
    await inScope(() => storeRepo('s1'));
    state.backend = 'do';
    const second = await inScope(() => storeRepo('s1'));
    expect(second.backend).toBe('do');
  });

  it('a failed resolution is not remembered as the answer', async () => {
    state.backend = 'do';
    state.doBound = false;
    await inScope(async () => {
      await expect(storeRepo('s1')).rejects.toMatchObject({ statusCode: 503 });
      state.doBound = true;
      await expect(storeRepo('s1')).resolves.toMatchObject({ backend: 'do' });
    });
  });

  it('withRepo pre-resolves a store for a scope (contract tests, diagnostics)', async () => {
    const fake = { storeId: 's9', backend: 'do' as const, db: { x: 1 } as never };
    await withRepo(fake, async () => {
      expect(await storeRepo('s9')).toBe(fake);
    });
    expect(state.backendCalls).toEqual([]);
  });

  it('the request scope is mounted once in app.ts, before the routes', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync('apps/api/src/app.ts', 'utf8');
    const scope = app.indexOf('app.use(repoScope)');
    expect(scope).toBeGreaterThan(0);
    expect(app.indexOf("app.use('/api/v1', routes)")).toBeGreaterThan(scope);
    expect(app.match(/app\.use\(repoScope\)/g)).toHaveLength(1);
  });

  it('runReads is the one executor on the other side of the wire (sanity: unknown ops are refused)', async () => {
    const r = await runReads({}, [{ model: 'Product', op: 'delete' as never }]);
    expect(r).toMatchObject({ ok: false, code: 'OP_NOT_ALLOWED' });
  });
});
