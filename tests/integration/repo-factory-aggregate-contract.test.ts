/**
 * INFRA-CF-1 PR D2b (Ruling CF-MONEY-1): `aggregate` and `groupBy` are answered by the StoreDO over the read RPC and give the
 * same result as Postgres. The same rows go into real Postgres (through Prisma) and into the DO schema on SQLite; each call
 * runs through the real wire codec and prisma-lite. Empty answers prove nothing, so every case asserts data came back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
import { createDoClient, runReads, createPrismaLite } from '@ebda-src/repo';
import { withRepo, storeDb, type StoreReads } from '../../apps/api/src/lib/repo-factory';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';

const sfx = Date.now().toString(36);
let STORE = '';
let OTHER = '';
let userId = '';
const db = openSqlite();

const doClient = (sqlite: ReturnType<typeof openSqlite>, storeId: string) => {
  const lite = createPrismaLite(META as never, nodeSqlRunner(sqlite), 'store-do', { storeId });
  return createDoClient(q => runReads(lite as never, q)) as unknown as StoreReads;
};
async function both<T>(call: (d: StoreReads) => Promise<T>) {
  const pg = await runInTenantContext(STORE, () =>
    withRepo({ storeId: STORE, backend: 'pg', db: prisma as never }, async () =>
      call(await storeDb(STORE))
    )
  );
  const dobj = await withRepo(
    { storeId: STORE, backend: 'do', db: doClient(db, STORE) },
    async () => call(await storeDb(STORE))
  );
  return { pg: canon(pg), dobj: canon(dobj) };
}
const same = async <T>(call: (d: StoreReads) => Promise<T>) => {
  const { pg, dobj } = await both(call);
  expect(JSON.stringify(pg).length).toBeGreaterThan(8);
  expect(dobj).toEqual(pg);
  return pg as any;
};

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `agg-${sfx}@example.test`,
      passwordHash: 'x',
      firstName: 'A',
      lastName: 'G',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  userId = user.id;
  const mk = async (slug: string) =>
    (
      await prisma.store.create({
        data: { name: slug, slug: `${slug}-${sfx}`, ownerId: userId, status: 'active' },
      })
    ).id;
  STORE = await mk('agg');
  OTHER = await mk('agg-other');
  const rows: Array<[string, string, number, number, string, boolean]> = [
    ['a', STORE, 1000, 5, 'active', true],
    ['b', STORE, 2500, 0, 'active', true],
    ['c', STORE, 4000, 12, 'draft', false],
    ['d', STORE, 4000, 3, 'draft', true],
    ['e', STORE, 750, 7, 'archived', true],
    ['x', OTHER, 99999, 99, 'active', true],
  ];
  for (const [slug, storeId, price, inventory, status, trackInventory] of rows) {
    const row = await runInTenantContext(storeId, () =>
      prisma.product.create({
        data: {
          storeId,
          name: `P ${slug}`,
          slug: `${slug}-${sfx}`,
          price,
          inventory,
          status: status as never,
          trackInventory,
        },
      })
    );
    if (storeId === STORE) insertSqlite(db, 'Product', [row as Record<string, unknown>]);
  }
});
afterAll(async () => {
  await prisma.product.deleteMany({ where: { storeId: { in: [STORE, OTHER] } } });
  await prisma.store.deleteMany({ where: { id: { in: [STORE, OTHER] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe('aggregate and groupBy over the DO read RPC equal Postgres', () => {
  it('aggregate: _count/_sum/_avg/_min/_max with a where', async () => {
    const r = await same(d =>
      d.product.aggregate({
        where: { storeId: STORE, status: { not: 'archived' } },
        _count: { _all: true, price: true },
        _sum: { price: true, inventory: true },
        _avg: { price: true },
        _min: { price: true },
        _max: { inventory: true },
      })
    );
    expect(r._sum.price).toBe(11500);
  });
  it('aggregate over no rows: sums are null, counts 0', async () => {
    const r = await same(d =>
      d.product.aggregate({
        where: { storeId: STORE, price: { gt: 1_000_000 } },
        _count: { _all: true },
        _sum: { price: true },
      })
    );
    expect(r._count._all).toBe(0);
  });
  it('groupBy status with _sum/_count and an orderBy on the key', async () => {
    const r = await same(d =>
      d.product.groupBy({
        by: ['status'],
        where: { storeId: STORE },
        _sum: { price: true },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      })
    );
    expect(r).toHaveLength(3);
  });
  it('groupBy two keys with having and orderBy an aggregate, take/skip', async () => {
    const r = await same(d =>
      d.product.groupBy({
        by: ['status', 'trackInventory'],
        where: { storeId: STORE },
        _count: { _all: true },
        _sum: { inventory: true },
        having: { inventory: { _sum: { gte: 3 } } },
        orderBy: [{ _sum: { inventory: 'desc' } }, { status: 'asc' }],
        take: 2,
      })
    );
    expect(r.length).toBeGreaterThan(0);
  });
  it("the DO is bound to one store: an unfiltered aggregate never sees another store's rows", async () => {
    const dobj = await withRepo(
      { storeId: STORE, backend: 'do', db: doClient(db, STORE) },
      async () => (await storeDb(STORE)).product.aggregate({ _sum: { price: true } })
    );
    expect(dobj._sum.price).toBe(12250);
  });
  it('groupBy orderBy a count and skip/take page the groups', async () => {
    const r = await same(d =>
      d.product.groupBy({
        by: ['price'],
        where: { storeId: STORE },
        _count: { _all: true },
        orderBy: [{ _count: { id: 'desc' } }, { price: 'asc' }],
        skip: 1,
        take: 2,
      })
    );
    expect(r).toHaveLength(2);
  });
  it('having on a group key and on an aggregate, with OR', async () => {
    await same(d =>
      d.product.groupBy({
        by: ['status'],
        where: { storeId: STORE },
        _count: { _all: true },
        having: { OR: [{ status: 'archived' }, { price: { _sum: { gt: 5000 } } }] },
        orderBy: { status: 'asc' },
      })
    );
  });
  it('an unsupported shape is refused loudly, never answered wrong', async () => {
    await expect(
      withRepo({ storeId: STORE, backend: 'do', db: doClient(db, STORE) }, async () =>
        (await storeDb(STORE)).product.groupBy({
          by: ['status'],
          _count: { _all: true },
          having: { price: { _sum: { weird: 1 } } },
        } as never)
      )
    ).rejects.toThrow(/unsupported having operator/);
  });
});

describe('enum columns sort in the Postgres enum order on the DO', () => {
  it('the engine order equals pg_enum.enumsortorder for every enum of the schema', async () => {
    const { PG_ENUM_ORDER } = await import('../../packages/repo/src/prisma-lite/enum-order');
    const rows = await prisma.$queryRaw<Array<{ name: string; labels: string[] }>>`
      SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`;
    const pg = new Map(rows.map(r => [r.name, r.labels]));
    let checked = 0;
    for (const [name, declared] of Object.entries(META.enums as Record<string, string[]>)) {
      const dbLabels = pg.get(name) ?? pg.get(name.toLowerCase());
      if (!dbLabels) continue;
      expect(PG_ENUM_ORDER[name] ?? declared, name).toEqual(dbLabels);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });
});
