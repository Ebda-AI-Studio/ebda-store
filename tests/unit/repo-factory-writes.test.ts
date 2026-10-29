/**
 * INFRA-CF-1 PR D1 (Ruling CF-WRITES-1): lib/repo-factory.ts `storeWriter`. Postgres stays the default and the writer IS the
 * prisma proxy; a store flagged 'do' sends each write to ITS Durable Object as one atomic `mutate` batch; the read client
 * `storeDb` still has no write delegates; the type-level list of writable models equals the DO's runtime allow-list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DO_WRITABLE_MODELS } from '@ebda-src/repo';

const { PG, state } = vi.hoisted(() => ({
  PG: {
    blogPost: { create: vi.fn(async (a: unknown) => ({ pg: true, a })) },
    $transaction: vi.fn(async (ops: unknown[], ...rest: unknown[]) => ({ ops, rest })),
  },
  state: {
    backend: 'pg' as 'pg' | 'do',
    mutations: [] as Array<{ storeId: string; m: any }>,
    doBound: true,
  },
}));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  prisma: PG,
}));
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: () => state.backend,
  storeDo: () => {
    if (!state.doBound) {
      const e = new Error('Store Durable Object is not bound') as Error & { statusCode: number };
      e.statusCode = 503;
      throw e;
    }
    return {
      query: async () => ({ ok: true, json: '[[]]' }),
      mutate: async (storeId: string, m: any) => {
        state.mutations.push({ storeId, m });
        return { ok: true, json: JSON.stringify(m.ops.map(() => ({ id: 'r' }))) };
      },
    };
  },
}));

import { storeDb, storeWriter } from '../../apps/api/src/lib/repo-factory';

beforeEach(() => {
  state.backend = 'pg';
  state.mutations = [];
  state.doBound = true;
  PG.blogPost.create.mockClear();
  PG.$transaction.mockClear();
});

describe('storeWriter', () => {
  it('Postgres is the default: writes reach the prisma proxy and nothing is sent to a Durable Object', async () => {
    const w = (await storeWriter('s1')) as any;
    expect(await w.blogPost.create({ data: { x: 1 } })).toEqual({
      pg: true,
      a: { data: { x: 1 } },
    });
    expect(state.mutations).toEqual([]);
  });

  it('on pg, $transaction drops the DO-only options argument and passes the array through', async () => {
    const w = (await storeWriter('s1')) as any;
    await w.$transaction([1, 2], { idempotencyKey: 'abcdefgh1' });
    expect(PG.$transaction).toHaveBeenCalledWith([1, 2]);
  });

  it('an unresolved store is a 404 for writes too', async () => {
    await expect(storeWriter('')).rejects.toMatchObject({
      statusCode: 404,
      code: 'STORE_NOT_FOUND',
    });
  });

  it('a store flagged do writes to ITS Durable Object with its own id, one atomic batch per $transaction, key included', async () => {
    state.backend = 'do';
    const w = (await storeWriter('store-a')) as any;
    await w.blogPost.create({ data: { slug: 'x' } });
    await w.$transaction(
      [
        w.category.updateMany({ where: {}, data: { position: 0 } }),
        w.category.updateMany({ where: {}, data: { position: 1 } }),
      ],
      { idempotencyKey: 'reorder-key-1' }
    );
    expect(state.mutations.map(m => m.storeId)).toEqual(['store-a', 'store-a']);
    expect(state.mutations[0].m).toEqual({
      key: undefined,
      ops: [{ model: 'BlogPost', op: 'create', args: { data: { slug: 'x' } } }],
    });
    expect(state.mutations[1].m.key).toBe('reorder-key-1');
    expect(state.mutations[1].m.ops.map((o: any) => o.op)).toEqual(['updateMany', 'updateMany']);
    expect(PG.blogPost.create).not.toHaveBeenCalled(); // never a silent Postgres write for a 'do' store
  });

  it('the READ client of a do store still has no write delegates', async () => {
    state.backend = 'do';
    const db = (await storeDb('store-a')) as any;
    expect(db.blogPost.create).toBeUndefined();
    expect(state.mutations).toEqual([]);
  });

  it('an unbound DO is a 503 for writes, not a Postgres write', async () => {
    state.backend = 'do';
    state.doBound = false;
    await expect(storeWriter('s1')).rejects.toMatchObject({ statusCode: 503 });
    expect(PG.blogPost.create).not.toHaveBeenCalled();
  });
});

describe('WritableModel type == the DO allow-list', () => {
  it('names the same models (lower-camel vs Pascal)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../apps/api/src/lib/repo-factory.ts'),
      'utf8'
    );
    const block = src.slice(
      src.indexOf('export type WritableModel'),
      src.indexOf('/** `inventory` is never')
    );
    const typed = [...block.matchAll(/'([a-zA-Z]+)'/g)].map(
      m => m[1][0].toUpperCase() + m[1].slice(1)
    );
    expect([...typed].sort()).toEqual([...DO_WRITABLE_MODELS].sort());
  });
});
