// Prisma-lite WRITE fidelity: every operation runs through real Prisma/Postgres AND prisma-lite/SQLite over twin data;
// results, thrown error codes and the resulting table state must match. Needs PRISMALITE_PG_URL; skipped without it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canon, insertSqlite, makePair, PG_URL } from './diff-harness';

const run = PG_URL ? describe : describe.skip;
const TS = /^(createdAt|updatedAt)$/;
const strip = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object' && !(v instanceof Date) && !('d' in (v as object)))
    return Object.fromEntries(
      Object.entries(v as object)
        .filter(([k]) => !TS.test(k))
        .map(([k, x]) => [k, strip(x)])
    );
  return v;
};

run('prisma-lite writes == Prisma writes', () => {
  let pair: Awaited<ReturnType<typeof makePair>>;
  let storeId = '';
  const sfx = Math.random().toString(36).slice(2, 8);
  const id = (n: string) => `${n}-${sfx}`;

  /** Seed one row into both databases (PG generates defaults; SQLite gets the same row). */
  async function both(model: string, data: Record<string, unknown>) {
    const delegate = model[0].toLowerCase() + model.slice(1);
    const row = await (pair.prisma as any)[delegate].create({ data });
    insertSqlite(pair.db, model, [row]);
    return row;
  }
  /** Run the same call on both; return [pgResult|error, liteResult|error]. */
  async function twin(model: string, op: string, args: any) {
    const d = model[0].toLowerCase() + model.slice(1);
    const go = async (c: any) => {
      try {
        return { ok: await c[d][op](args) };
      } catch (e: any) {
        return { err: { code: e.code, target: e.meta?.target ?? undefined } };
      }
    };
    return [await go(pair.prisma), await go(pair.lite)] as const;
  }
  async function same(model: string, op: string, args: any) {
    const [a, b] = await twin(model, op, args);
    if ('err' in a || 'err' in b) {
      expect(
        'err' in b,
        `lite should ${'err' in a ? 'throw' : 'not throw'}: ${JSON.stringify([a, b])}`
      ).toBe('err' in a);
      expect((b as any).err.code).toBe((a as any).err.code);
      return [a, b] as const;
    }
    expect(canon(strip(b.ok))).toEqual(canon(strip(a.ok)));
    return [a, b] as const;
  }
  const table = async (model: string, where: any, orderBy: any = { id: 'asc' }) => {
    const d = model[0].toLowerCase() + model.slice(1);
    return [
      canon(strip(await (pair.prisma as any)[d].findMany({ where, orderBy }))),
      canon(strip(await (pair.lite as any)[d].findMany({ where, orderBy }))),
    ] as const;
  };

  beforeAll(async () => {
    pair = await makePair();
    const user = await pair.prisma.user.create({
      data: {
        email: `w-${sfx}@example.com`,
        passwordHash: 'x',
        firstName: 'D',
        lastName: 'T',
      } as never,
    });
    storeId = (
      await pair.prisma.store.create({
        data: {
          name: 'W',
          slug: `w-${sfx}`,
          ownerId: user.id,
          emailSenderLocalPart: `w-${sfx}`,
        } as never,
      })
    ).id;
    await both('Category', { id: id('cat'), storeId, name: 'C', slug: 'c' });
    await both('Product', {
      id: id('seed'),
      storeId,
      name: 'Seed',
      slug: 'seed',
      price: 1000,
      inventory: 10,
    });
  });
  afterAll(async () => {
    if (!pair) return;
    await pair.prisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
    await pair.close();
  });

  it('create with defaults and select', async () => {
    await same('Product', 'create', {
      data: { id: id('p1'), storeId, name: 'P1', slug: 'p1', price: 500 },
    });
    const [a, b] = await table('Product', { storeId });
    expect(b).toEqual(a);
  });

  it('nested create: images create[], connect to an existing category through the join row', async () => {
    await same('Product', 'create', {
      data: {
        id: id('p2'),
        storeId,
        name: 'P2',
        slug: 'p2',
        price: 700,
        images: {
          create: [
            { id: id('i1'), url: 'a', position: 1 },
            { id: id('i2'), url: 'b', position: 0 },
          ],
        },
      },
      include: { images: { orderBy: { position: 'asc' } } },
    });
    const [a, b] = await table('ProductImage', { productId: id('p2') });
    expect(b).toEqual(a);
  });

  it('unique violation: both raise P2002 with the same columns', async () => {
    const [a, b] = await twin('Product', 'create', {
      data: { id: id('dup'), storeId, name: 'D', slug: 'p1', price: 1 },
    });
    expect((a as any).err.code).toBe('P2002');
    expect((b as any).err.code).toBe('P2002');
    const cols = (t: any) =>
      [...t]
        .map(String)
        .map(s => s.replace(/^.*\./, ''))
        .sort();
    expect(cols((b as any).err.target)).toEqual(
      cols((a as any).err.target ?? ['store_id', 'slug'])
    );
  });

  it('update: set, increment, decrement; missing row -> P2025 on both', async () => {
    await same('Product', 'update', {
      where: { id: id('p1') },
      data: { name: 'P1b', inventory: { increment: 5 }, price: { decrement: 100 } },
    });
    await same('Product', 'update', { where: { id: id('nope') }, data: { name: 'x' } });
    await same('Product', 'update', {
      where: { id: id('p1'), storeId },
      data: { featured: true },
      select: { id: true, featured: true, inventory: true, price: true },
    });
    const [a, b] = await table('Product', { storeId });
    expect(b).toEqual(a);
  });

  it('updateMany / deleteMany counts and state', async () => {
    await same('Product', 'updateMany', {
      where: { storeId, price: { gte: 500 } },
      data: { status: 'draft' },
    });
    await same('Product', 'deleteMany', { where: { storeId, slug: { in: ['p2'] } } });
    const [a, b] = await table('Product', { storeId });
    expect(b).toEqual(a);
  });

  it('delete returns the row and cascades children (FK ON DELETE CASCADE)', async () => {
    await same('Product', 'create', {
      data: {
        id: id('p3'),
        storeId,
        name: 'P3',
        slug: 'p3',
        price: 10,
        images: { create: [{ id: id('i3'), url: 'z' }] },
      },
    });
    await same('Product', 'delete', { where: { id: id('p3') } });
    const [a, b] = await table('ProductImage', { productId: id('p3') });
    expect(a).toEqual([]);
    expect(b).toEqual(a);
    await same('Product', 'delete', { where: { id: id('p3') } }); // now missing: P2025 on both
  });

  it('upsert: create path then update path', async () => {
    const args = (n: string) => ({
      where: { storeId_slug: { storeId, slug: 'ups' } },
      create: { id: id('ups'), storeId, name: 'U', slug: 'ups', price: 5 },
      update: { name: n },
    });
    await same('Product', 'upsert', args('first'));
    await same('Product', 'upsert', args('second'));
    const [a, b] = await table('Product', { storeId, slug: 'ups' });
    expect(b).toEqual(a);
  });

  it('createMany with skipDuplicates', async () => {
    const data = [
      { id: id('m1'), storeId, name: 'M1', slug: 'm1', price: 1 },
      { id: id('m2'), storeId, name: 'M2', slug: 'p1', price: 1 },
      { id: id('m3'), storeId, name: 'M3', slug: 'm3', price: 1 },
    ];
    await same('Product', 'createMany', { data, skipDuplicates: true });
    const [a, b] = await table('Product', { storeId });
    expect(b).toEqual(a);
  });

  it('update nested: images deleteMany + create[] replaces the set', async () => {
    await same('Product', 'update', {
      where: { id: id('p1') },
      data: {
        images: {
          deleteMany: {},
          create: [
            { id: id('ni1'), url: 'n1' },
            { id: id('ni2'), url: 'n2' },
          ],
        },
      },
    });
    const [a, b] = await table('ProductImage', { productId: id('p1') });
    expect(b).toEqual(a);
  });

  it('aggregate and groupBy', async () => {
    await same('Product', 'aggregate', {
      where: { storeId },
      _count: { _all: true },
      _sum: { price: true, inventory: true },
      _avg: { price: true },
      _min: { price: true },
      _max: { price: true },
    });
    await same('Product', 'groupBy', {
      by: ['status'],
      where: { storeId },
      _count: { _all: true },
      _sum: { price: true },
      orderBy: { status: 'asc' },
    });
    // `_count: true` is a NUMBER in Prisma (aggregate and per group), not `{ _all }`
    await same('Product', 'aggregate', { where: { storeId }, _count: true });
    await same('Product', 'groupBy', {
      by: ['status'],
      where: { storeId },
      _count: true,
      orderBy: { status: 'asc' },
    });
  });

  it('$transaction: interactive commit, interactive rollback on throw, array form', async () => {
    const both$ = async (fn: (c: any) => Promise<unknown>) => {
      const r = [] as unknown[];
      for (const c of [pair.prisma as any, pair.lite as any])
        r.push(
          await c.$transaction(fn).then(
            () => 'ok',
            (e: Error) => `err:${e.message}`
          )
        );
      return r;
    };
    const ok = await both$(async c => {
      await c.product.update({ where: { id: id('seed') }, data: { inventory: { decrement: 3 } } });
      await c.product.update({ where: { id: id('seed') }, data: { inventory: { decrement: 2 } } });
    });
    expect(ok).toEqual(['ok', 'ok']);
    const rolled = await both$(async c => {
      await c.product.update({
        where: { id: id('seed') },
        data: { inventory: { decrement: 100 } },
      });
      throw new Error('boom');
    });
    expect(rolled).toEqual(['err:boom', 'err:boom']);
    for (const c of [pair.prisma as any, pair.lite as any]) {
      await c.$transaction([
        c.product.update({ where: { id: id('seed') }, data: { price: 1234 } }),
        c.product.update({ where: { id: id('seed') }, data: { inventory: { increment: 1 } } }),
      ]);
    }
    const [a, b] = await table('Product', { id: id('seed') });
    expect(b).toEqual(a);
    expect((a as any)[0].inventory).toBe(6);
  });

  it('a unique violation inside a transaction rolls the whole transaction back on both', async () => {
    const attempt = async (c: any) =>
      c
        .$transaction(async (t: any) => {
          await t.product.create({
            data: { id: id('tx1'), storeId, name: 'T', slug: 'tx1', price: 1 },
          });
          await t.product.create({
            data: { id: id('tx2'), storeId, name: 'T', slug: 'tx1', price: 1 },
          });
        })
        .then(
          () => 'ok',
          (e: any) => e.code
        );
    expect([await attempt(pair.prisma), await attempt(pair.lite)]).toEqual(['P2002', 'P2002']);
    const [a, b] = await table('Product', { storeId, slug: 'tx1' });
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });
});
