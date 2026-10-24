// Security: no identifier or keyword reaches SQL from caller args. Hostile strings go into EVERY arg position
// and must either throw before SQL is built or be bound as data; the schema is never altered or leaked.
import { describe, expect, it } from 'vitest';
import { META, openSqlite } from './diff-harness';
import { createPrismaLite } from '../src/prisma-lite/client';
import { Engine } from '../src/prisma-lite/engine';
import { nodeSqlRunner } from '../src/prisma-lite/node-sql';

const HOSTILE = [
  `"; DROP TABLE products; --`,
  `x" OR 1=1 --`,
  `1; DELETE FROM products`,
  `asc; DROP TABLE products`,
  `desc, (SELECT sql FROM sqlite_master)`,
  `__proto__`,
  `constructor`,
  `toString`,
  `t0.id) OR (1`,
  `' OR '1'='1`,
];

function setup() {
  const db = openSqlite();
  db.exec(
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('p1','s1','n','a',1),('p2','s2','n','b',2)`
  );
  const seen: string[] = [];
  const base = nodeSqlRunner(db);
  const runner = {
    ...base,
    all: (sql: string, p: unknown[]) => (seen.push(sql), base.all(sql, p)),
    run: base.run,
  };
  const lite = createPrismaLite(META, runner) as any;
  return { db, lite, seen };
}
const tablesIntact = (db: ReturnType<typeof openSqlite>) =>
  expect((db.prepare('SELECT count(*) c FROM products').get() as { c: number }).c).toBe(2);
const attempt = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch {
    /* throwing is the expected outcome */
  }
};

describe('prisma-lite injection fuzz', () => {
  it('orderBy direction, nulls, _count direction and to-one relation direction accept only asc/desc/first/last', async () => {
    const { db, lite, seen } = setup();
    for (const h of HOSTILE) {
      await expect(lite.product.findMany({ orderBy: { price: h } })).rejects.toThrow(/direction/);
      await expect(
        lite.product.findMany({ orderBy: { price: { sort: 'asc', nulls: h } } })
      ).rejects.toThrow(/nulls/);
      await expect(lite.product.findMany({ orderBy: { _count: { images: h } } })).rejects.toThrow(
        /direction/
      );
      await expect(
        lite.productCategory.findMany({ orderBy: { product: { createdAt: h } } })
      ).rejects.toThrow(/direction/);
    }
    // legal values still work, any case
    await lite.product.findMany({
      orderBy: [{ price: 'DESC' }, { name: { sort: 'Asc', nulls: 'LAST' } }],
    });
    expect(seen.some(s => /ORDER BY .*DESC/.test(s))).toBe(true);
    tablesIntact(db);
  });

  it('take/skip must be integers and are bound, never interpolated (findMany and count)', async () => {
    const { db, lite, seen } = setup();
    for (const h of [...HOSTILE, 1.5, -1, NaN, '5', Infinity]) {
      await expect(lite.product.findMany({ take: h })).rejects.toThrow(/take/);
      await expect(lite.product.findMany({ skip: h, take: 1 })).rejects.toThrow(/skip/);
      await expect(lite.product.count({ take: h })).rejects.toThrow(/take/);
      await expect(lite.product.count({ skip: h })).rejects.toThrow(/skip/);
    }
    await lite.product.count({ take: 5, skip: 1 });
    await lite.product.findMany({ take: 1, skip: 1 });
    for (const s of seen) expect(s).not.toMatch(/LIMIT \d|OFFSET \d/);
    tablesIntact(db);
  });

  it('findUnique requires every field of a unique tuple, non-null (no silent first-row match)', async () => {
    const { lite } = setup();
    await expect(lite.product.findUnique({ where: {} })).rejects.toThrow(/unique key/);
    await expect(lite.product.findUnique({ where: { id: undefined } })).rejects.toThrow(
      /unique key/
    );
    await expect(lite.product.findUnique({ where: { id: null } })).rejects.toThrow(/unique key/);
    await expect(lite.product.findUnique({ where: { storeId: 's1' } })).rejects.toThrow(
      /unique key/
    );
    await expect(
      lite.product.findUnique({ where: { storeId_slug: { storeId: 's1' } } })
    ).rejects.toThrow(/unique key/);
    await expect(
      lite.product.findUnique({ where: { storeId_slug: { storeId: 's1', slug: undefined } } })
    ).rejects.toThrow(/unique key/);
    expect((await lite.product.findUnique({ where: { id: 'p2' } })).slug).toBe('b');
    expect(
      (await lite.product.findUnique({ where: { storeId_slug: { storeId: 's1', slug: 'a' } } })).id
    ).toBe('p1');
  });

  it('hostile strings in every other arg position throw or are bound; no statement carries them', async () => {
    const { db, lite, seen } = setup();
    for (const h of HOSTILE) {
      const cases: Array<() => Promise<unknown>> = [
        () => lite.product.findMany({ where: { [h]: 1 } }),
        () => lite.product.findMany({ where: { name: { [h]: 'x' } } }),
        () => lite.product.findMany({ where: { name: h } }),
        () => lite.product.findMany({ where: { name: { contains: h, mode: h } } }),
        () => lite.product.findMany({ where: { AND: [{ [h]: 1 }] } }),
        () => lite.product.findMany({ where: { categories: { [h]: {} } } }),
        () => lite.product.findMany({ where: { [h]: { some: {} } } }),
        () => lite.product.findMany({ orderBy: { [h]: 'asc' } }),
        () => lite.product.findMany({ orderBy: { _count: { [h]: 'asc' } } }),
        () => lite.product.findMany({ orderBy: { store: { [h]: 'asc' } } }),
        () => lite.productCategory.findMany({ orderBy: { product: { [h]: 'asc' } } }),
        () => lite.product.findMany({ select: { [h]: true, id: true } }),
        () => lite.product.findMany({ include: { [h]: true } }),
        () => lite.product.findMany({ select: { images: { select: { [h]: true } } } }),
        () => lite.product.findMany({ include: { images: { orderBy: { [h]: 'asc' } } } }),
        () => lite.product.findMany({ include: { _count: { select: { [h]: true } } } }),
        () => lite.product.findMany({ cursor: { [h]: 'x' }, take: 1 }),
        () => lite.product.findMany({ distinct: [h] }),
        () => lite.product.findMany({ distinct: ['name'] }),
        () => lite.product.count({ where: { [h]: 1 } }),
        () => lite[h]?.findMany?.({}),
        () => lite.product.findUnique({ where: { [h]: 'x' } }),
      ];
      for (const c of cases) await attempt(c);
    }
    tablesIntact(db);
    // no statement text ever contains a hostile fragment (it is bound or rejected)
    for (const s of seen) {
      expect(s).not.toMatch(/DROP TABLE|DELETE FROM|sqlite_master|OR 1=1|'1'='1/);
    }
    // schema untouched
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map(r => r.name);
    expect(names).toContain('products');
  });

  it('every quoted identifier in every statement the engine emits comes from the registry', async () => {
    const { lite, seen } = setup();
    await lite.product.findMany({
      where: {
        storeId: 's1',
        categories: { some: { category: { slug: 'x' } } },
        OR: [{ name: { contains: 'a', mode: 'insensitive' } }],
      },
      orderBy: [{ price: 'asc' }, { _count: { images: 'desc' } }],
      take: 2,
      skip: 1,
      include: {
        images: { orderBy: { position: 'asc' }, take: 1 },
        variants: true,
        _count: { select: { images: true } },
      },
    });
    const idents = new Set<string>();
    for (const m of Object.values(META.models)) {
      idents.add(m.table);
      for (const f of Object.values(m.fields)) if (f.kind !== 'relation') idents.add(f.column);
    }
    for (const s of seen)
      for (const m of s.matchAll(/"([^"]+)"/g))
        expect(idents.has(m[1]), `${m[1]} in ${s}`).toBe(true);
  });

  it('the engine refuses a non-identifier even if metadata were poisoned', () => {
    const bad = JSON.parse(JSON.stringify(META));
    bad.models.Product.fields.name.column = `name" ; DROP TABLE products; --`;
    const e = new Engine(bad, nodeSqlRunner(openSqlite()));
    expect(() => e.findMany('Product', { where: { name: 'x' } })).toThrow(/refusing identifier/);
  });
});
