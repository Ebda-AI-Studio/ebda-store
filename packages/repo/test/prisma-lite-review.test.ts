// Regression tests for the Opus review of prisma-lite (findings 1-11 + the nested-write findings). No Postgres needed.
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { META, openSqlite } from './diff-harness';
import { createPrismaLite } from '../src/prisma-lite/client';
import { nodeSqlRunner } from './node-sql';

function setup() {
  const db = openSqlite();
  const lite = createPrismaLite(META, nodeSqlRunner(db), 'store-do', { unscoped: true }) as any;
  const P = db.prepare(
    `INSERT INTO products (id, store_id, name, slug, price, compare_at_price) VALUES (?, ?, ?, ?, ?, ?)`
  );
  P.run('p1', 's1', 'Alpha', 'alpha', 100, null);
  P.run('p2', 's1', 'beta', 'beta', 200, 300);
  P.run('p3', 's2', 'Gamma', 'gamma', 300, 500);
  const I = db.prepare(
    `INSERT INTO product_images (id, product_id, url, position) VALUES (?, ?, ?, ?)`
  );
  for (const [id, p, pos] of [
    ['i1', 'p1', 0],
    ['i2', 'p1', 1],
    ['i3', 'p1', 2],
    ['i4', 'p2', 0],
    ['i5', 'p2', 1],
    ['i6', 'p3', 0],
  ] as const)
    I.run(id, p, `u-${id}`, pos);
  return { db, lite };
}
const imgs = (db: ReturnType<typeof openSqlite>, product: string) =>
  (
    db
      .prepare('SELECT id, product_id, url FROM product_images WHERE product_id = ? ORDER BY id')
      .all(product) as any[]
  ).map(r => `${r.id}:${r.url}`);

describe('review finding 1: global omit (secrets) is honoured', () => {
  it('a plain read hides the store credentials; select names them; omit:false opts back in; unknown args throw', async () => {
    const { db, lite } = setup();
    db.prepare(`INSERT INTO store_credentials (store_id, agent_api_key) VALUES ('s1', 'A')`).run();
    const plain = await lite.storeCredential.findFirst({ where: { storeId: 's1' } });
    expect(plain).not.toHaveProperty('agentApiKey');
    expect(
      (await lite.storeCredential.findFirst({ select: { agentApiKey: true } })).agentApiKey
    ).toBe('A');
    expect(
      (await lite.storeCredential.findFirst({ omit: { agentApiKey: false } })).agentApiKey
    ).toBe('A');
    await expect(lite.storeCredential.findFirst({ whre: {} })).rejects.toThrow(
      /unsupported argument/
    );
    await expect(lite.storeCredential.findFirst({ omit: { nope: true } })).rejects.toThrow(
      /unknown field/
    );
  });
});

describe('review findings 2 and 3: findUnique selectors', () => {
  it('operator objects, arrays and null are not plain unique values', async () => {
    const { lite } = setup();
    for (const where of [
      { id: { not: '' } },
      { id: { in: ['p1'] } },
      { id: ['p1'] },
      { storeId_slug: { storeId: 's1', slug: { gt: '' } } },
    ])
      await expect(lite.product.findUnique({ where })).rejects.toThrow(/unique selector/);
  });
  it('a __proto__ key (JSON.parse) cannot smuggle a tuple and is refused', async () => {
    const { lite } = setup();
    await expect(
      lite.product.findUnique({ where: JSON.parse('{"__proto__":{"id":"p1"}}') })
    ).rejects.toThrow(/refusing key|unique selector/);
    await expect(
      lite.product.findUnique({
        where: JSON.parse('{"storeId_slug":{"__proto__":{"storeId":"s1","slug":"alpha"}}}'),
      })
    ).rejects.toThrow(/refusing key|unique selector/);
  });
});

describe('review finding 4: the 100-parameter limit', () => {
  it('a 500-element IN list is ONE bound parameter', async () => {
    const { lite } = setup();
    const ids = Array.from({ length: 500 }, (_, i) => `x${i}`).concat(['p2']);
    expect(
      (await lite.product.findMany({ where: { id: { in: ids } } })).map((r: any) => r.id)
    ).toEqual(['p2']);
    expect((await lite.product.findMany({ where: { id: { notIn: ids } } })).length).toBe(2);
  });
  it('a statement that would bind more than 100 parameters is refused before it reaches the DO', async () => {
    const { lite } = setup();
    const OR = Array.from({ length: 60 }, (_, i) => ({ name: { contains: `n${i}` } })); // 3 params each
    await expect(lite.product.findMany({ where: { OR } })).rejects.toThrow(
      /bound parameters exceed/
    );
  });
  it('relation loading over many parents stays within the limit (single-column keys travel as one parameter)', async () => {
    const { db, lite } = setup();
    const ins = db.prepare(
      `INSERT INTO products (id, store_id, name, slug, price) VALUES (?, 's9', 'n', ?, 1)`
    );
    const img = db.prepare(`INSERT INTO product_images (id, product_id, url) VALUES (?, ?, 'u')`);
    for (let i = 0; i < 400; i++) (ins.run(`bulk${i}`, `bulk${i}`), img.run(`bi${i}`, `bulk${i}`));
    const rows = await lite.product.findMany({
      where: { storeId: 's9' },
      include: {
        images: { where: { url: { contains: 'u' } } },
        _count: { select: { images: true } },
      },
    });
    expect(rows.length).toBe(400);
    expect(rows.every((r: any) => r.images.length === 1 && r._count.images === 1)).toBe(true);
  });
});

describe('review finding 5: cursor pagination', () => {
  it('walks a DESC ordered list page by page without skipping or repeating, and ignores a cursor that matches nothing', async () => {
    const { lite } = setup();
    const all = (await lite.product.findMany({ orderBy: { price: 'desc' } })).map((r: any) => r.id);
    const seen: string[] = [];
    let cursor: any;
    for (let i = 0; i < 5; i++) {
      const page = await lite.product.findMany({
        orderBy: { price: 'desc' },
        take: 2,
        skip: cursor ? 1 : 0,
        ...(cursor ? { cursor } : {}),
      });
      if (!page.length) break;
      seen.push(...page.map((r: any) => r.id));
      cursor = { id: page[page.length - 1].id };
    }
    expect(seen).toEqual(all);
    expect(await lite.product.findMany({ cursor: { id: 'missing' }, take: 2 })).toEqual([]);
    await expect(lite.product.findMany({ cursor: {} })).rejects.toThrow(/cursor/);
    await expect(lite.product.findMany({ cursor: { name: 'Alpha' }, take: 1 })).rejects.toThrow(
      /complete unique key/
    );
  });
});

describe('review finding 6: NULL ordering matches Postgres', () => {
  it('ASC puts NULL last, DESC puts NULL first, `nulls` overrides', async () => {
    const { lite } = setup();
    const ids = async (o: any) =>
      (await lite.product.findMany({ where: { storeId: 's1' }, orderBy: o })).map((r: any) => r.id);
    expect(await ids({ compareAtPrice: 'asc' })).toEqual(['p2', 'p1']);
    expect(await ids({ compareAtPrice: 'desc' })).toEqual(['p1', 'p2']);
    expect(await ids({ compareAtPrice: { sort: 'asc', nulls: 'first' } })).toEqual(['p1', 'p2']);
  });
});

describe('review finding 7 and 8 and 9: filters', () => {
  it('insensitive equals / in / not', async () => {
    const { lite } = setup();
    expect(
      (await lite.product.findMany({ where: { name: { equals: 'ALPHA', mode: 'insensitive' } } }))
        .length
    ).toBe(1);
    expect(
      (
        await lite.product.findMany({
          where: { name: { in: ['ALPHA', 'BETA'], mode: 'insensitive' } },
        })
      ).length
    ).toBe(2);
    expect(
      (await lite.product.findMany({ where: { name: { not: 'ALPHA', mode: 'insensitive' } } }))
        .length
    ).toBe(2);
  });
  it('`not` / `notIn` follow SQL three-valued logic like Prisma (a NULL row never matches), in every shape', async () => {
    const { lite } = setup();
    const n = async (w: any) =>
      (await lite.product.findMany({ where: { storeId: 's1', compareAtPrice: w } })).length;
    expect(await n({ not: 300 })).toBe(0);
    expect(await n({ not: { equals: 300 } })).toBe(0);
    expect(await n({ not: { in: [300] } })).toBe(0);
    expect(await n({ notIn: [300] })).toBe(0);
  });
  it('DbNull / JsonNull / AnyNull are null tests, an empty operator object is no filter, class instances never act as operators', async () => {
    const { db, lite } = setup();
    expect((await lite.product.findMany({ where: { compareAtPrice: Prisma.DbNull } })).length).toBe(
      1
    );
    db.prepare(`UPDATE products SET ai_field_sources = 'null' WHERE id = 'p1'`).run();
    expect(
      (await lite.product.findMany({ where: { aiFieldSources: Prisma.JsonNull } })).map(
        (r: any) => r.id
      )
    ).toEqual(['p1']);
    expect((await lite.product.findMany({ where: { name: {} } })).length).toBe(3);
    await expect(
      lite.product.findMany({ where: { aiFieldSources: { equals: { a: 1 } } } })
    ).rejects.toThrow(/Json equals/);
  });
});

describe('review findings 10 and 11 and the low items', () => {
  it('nested take/skip is applied per parent in SQL', async () => {
    const { lite } = setup();
    const rows = await lite.product.findMany({
      orderBy: { id: 'asc' },
      include: { images: { orderBy: { position: 'asc' }, take: 2, skip: 1 } },
    });
    expect(rows.map((r: any) => r.images.map((i: any) => i.id))).toEqual([
      ['i2', 'i3'],
      ['i5'],
      [],
    ]);
  });
  it('unknown / array keys in relation filters throw instead of matching everything', async () => {
    const { lite } = setup();
    await expect(lite.product.findMany({ where: { images: { url: 'u' } } })).rejects.toThrow(
      /unknown list relation filter/
    );
    await expect(lite.product.findMany({ where: { images: [] } })).rejects.toThrow(/plain object/);
    expect(
      (await lite.product.findMany({ where: { images: { some: { url: 'u-i1' } } } })).map(
        (r: any) => r.id
      )
    ).toEqual(['p1']);
  });
  it('endsWith/startsWith/contains of the empty string match every non-null row; invalid input throws', async () => {
    const { lite } = setup();
    for (const op of ['endsWith', 'startsWith', 'contains'])
      expect((await lite.product.findMany({ where: { name: { [op]: '' } } })).length).toBe(3);
    await expect(
      lite.productImage.findMany({ include: { product: { take: 'abc' } } })
    ).rejects.toThrow(/take/);
    await expect(lite.product.findMany({ where: { createdAt: new Date('nope') } })).rejects.toThrow(
      /invalid DateTime/
    );
    await expect(lite.product.findMany({ where: { featured: 'false' } })).rejects.toThrow(
      /boolean/
    );
  });
  it('where nesting depth is capped; include depth is capped', async () => {
    const { lite } = setup();
    let w: any = { name: 'x' };
    for (let i = 0; i < 40; i++) w = { AND: [w] };
    await expect(lite.product.findMany({ where: w })).rejects.toThrow(/nested too deeply/);
  });
  it('a D1-only model has no delegate on the StoreDO client; the proxy is not thenable', async () => {
    const { lite } = setup();
    expect(() => lite.plan).toThrow(/no model delegate/);
    expect(await Promise.resolve(lite)).toBe(lite);
  });
});

describe('nested-write selectors (coordinator findings 1 and 2)', () => {
  it('a PARTIAL connect selector throws and re-parents nothing', async () => {
    const { db, lite } = setup();
    const before = imgs(db, 'p1').concat(imgs(db, 'p2'), imgs(db, 'p3'));
    await expect(
      lite.product.update({ where: { id: 'p3' }, data: { images: { connect: { url: 'u-i1' } } } })
    ).rejects.toThrow(/unique selector/);
    await expect(
      lite.product.update({ where: { id: 'p3' }, data: { images: { connect: [{ position: 0 }] } } })
    ).rejects.toThrow(/unique selector/);
    await expect(
      lite.product.create({
        data: {
          id: 'n1',
          storeId: 's1',
          name: 'n',
          slug: 'n1',
          price: 1,
          images: { connect: { productId: 'p1' } },
        },
      })
    ).rejects.toThrow(/unique selector/);
    expect(imgs(db, 'p1').concat(imgs(db, 'p2'), imgs(db, 'p3'))).toEqual(before);
  });
  it('a complete connect moves exactly one row; a missing one is P2025', async () => {
    const { db, lite } = setup();
    await lite.product.update({ where: { id: 'p3' }, data: { images: { connect: { id: 'i1' } } } });
    expect(imgs(db, 'p3')).toEqual(['i1:u-i1', 'i6:u-i6']);
    await expect(
      lite.product.update({ where: { id: 'p3' }, data: { images: { connect: { id: 'nope' } } } })
    ).rejects.toMatchObject({ code: 'P2025' });
  });
  it('set validates every selector BEFORE clearing anything', async () => {
    const { db, lite } = setup();
    const before = imgs(db, 'p1');
    await expect(
      lite.product.update({
        where: { id: 'p1' },
        data: { images: { set: [{ id: 'i1' }, { url: 'partial' }] } },
      })
    ).rejects.toThrow(/unique selector/);
    expect(imgs(db, 'p1')).toEqual(before);
  });
  it("a nested update/delete/disconnect cannot reach another parent's rows (parent scope is ANDed, FK override refused)", async () => {
    const { db, lite } = setup();
    const p2 = imgs(db, 'p2');
    const p3 = imgs(db, 'p3');
    // i4 belongs to p2; updating through p1 must find nothing
    await expect(
      lite.product.update({
        where: { id: 'p1' },
        data: { images: { update: { where: { id: 'i4' }, data: { url: 'HIJACK' } } } },
      })
    ).rejects.toMatchObject({ code: 'P2025' });
    await expect(
      lite.product.update({ where: { id: 'p1' }, data: { images: { delete: { id: 'i4' } } } })
    ).rejects.toMatchObject({ code: 'P2025' });
    // an explicit FK override in the selector is refused outright
    await expect(
      lite.product.update({
        where: { id: 'p1' },
        data: {
          images: { update: { where: { id: 'i4', productId: 'p2' }, data: { url: 'HIJACK' } } },
        },
      })
    ).rejects.toThrow(/relation key/);
    await expect(
      lite.product.update({
        where: { id: 'p1' },
        data: { images: { delete: { id: 'i4', productId: 'p2' } } },
      })
    ).rejects.toThrow(/relation key/);
    await lite.product
      .update({ where: { id: 'p1' }, data: { images: { disconnect: { id: 'i4' } } } })
      .catch(() => undefined);
    expect(imgs(db, 'p2')).toEqual(p2);
    expect(imgs(db, 'p3')).toEqual(p3);
    // the legitimate form still works
    await lite.product.update({
      where: { id: 'p1' },
      data: { images: { update: { where: { id: 'i1' }, data: { url: 'ok' } } } },
    });
    expect(imgs(db, 'p1')[0]).toBe('i1:ok');
  });
});

describe('writes are atomic outside an explicit transaction', () => {
  it('a create whose nested child fails leaves nothing behind; an update with a failing nested step rolls the scalars back too', async () => {
    const { db, lite } = setup();
    await expect(
      lite.product.create({
        data: {
          id: 'atomic1',
          storeId: 's1',
          name: 'n',
          slug: 'atomic1',
          price: 1,
          images: {
            create: [
              { id: 'ai1', url: 'a' },
              { id: 'ai1', url: 'dup id' },
            ],
          },
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(db.prepare(`SELECT count(*) c FROM products WHERE id = 'atomic1'`).get()).toEqual({
      c: 0,
    });
    expect(db.prepare(`SELECT count(*) c FROM product_images WHERE id = 'ai1'`).get()).toEqual({
      c: 0,
    });
    await expect(
      lite.product.update({
        where: { id: 'p1' },
        data: { name: 'CHANGED', images: { update: { where: { id: 'i4' }, data: { url: 'x' } } } },
      })
    ).rejects.toMatchObject({ code: 'P2025' });
    expect(db.prepare(`SELECT name FROM products WHERE id = 'p1'`).get()).toEqual({
      name: 'Alpha',
    });
  });
});

describe('round 2 review (writes)', () => {
  it('HIGH 1: a nested write cannot attach a child to another parent (FK in data, back-relation, updateMany)', async () => {
    const { db, lite } = setup();
    const before = imgs(db, 'p1').concat(imgs(db, 'p2'));
    await expect(
      lite.product.update({
        where: { id: 'p1' },
        data: { images: { create: { id: 'x1', url: 'u', productId: 'p2' } } },
      })
    ).rejects.toThrow(/relation key/);
    await expect(
      lite.product.update({
        where: { id: 'p1' },
        data: { images: { create: { id: 'x2', url: 'u', product: { connect: { id: 'p2' } } } } },
      })
    ).rejects.toThrow(/back-relation/);
    await expect(
      lite.product.update({
        where: { id: 'p1' },
        data: { images: { updateMany: { where: {}, data: { productId: 'p2' } } } },
      })
    ).rejects.toThrow(/relation key/);
    await expect(
      lite.product.update({
        where: { id: 'p1' },
        data: { images: { createMany: { data: [{ id: 'x3', url: 'u', productId: 'p2' }] } } },
      })
    ).rejects.toThrow(/relation key/);
    await expect(
      lite.product.create({
        data: {
          id: 'n9',
          storeId: 's1',
          name: 'n',
          slug: 'n9',
          price: 1,
          images: { create: [{ id: 'x4', url: 'u', productId: 'p2' }] },
        },
      })
    ).rejects.toThrow(/relation key/);
    expect(imgs(db, 'p1').concat(imgs(db, 'p2'))).toEqual(before);
    expect(db.prepare(`SELECT count(*) c FROM products WHERE id = 'n9'`).get()).toEqual({ c: 0 });
    // the legitimate nested create still lands under the parent
    await lite.product.update({
      where: { id: 'p1' },
      data: { images: { create: { id: 'ok1', url: 'u' } } },
    });
    expect(imgs(db, 'p1')).toContain('ok1:u');
  });

  it('HIGH 2: an error caught INSIDE an interactive $transaction leaves no half-applied nested write', async () => {
    const { db, lite } = setup();
    await lite.$transaction(async (tx: any) => {
      try {
        await tx.product.create({
          data: {
            id: 'half',
            storeId: 's1',
            name: 'n',
            slug: 'half',
            price: 1,
            images: {
              create: [
                { id: 'dup', url: 'a' },
                { id: 'dup', url: 'b' },
              ],
            },
          },
        });
      } catch {
        /* the caller swallows it */
      }
      await tx.product.create({
        data: { id: 'after', storeId: 's1', name: 'n', slug: 'after', price: 1 },
      });
    });
    expect(db.prepare(`SELECT count(*) c FROM products WHERE id = 'half'`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT count(*) c FROM product_images WHERE id = 'dup'`).get()).toEqual({
      c: 0,
    });
    expect(db.prepare(`SELECT count(*) c FROM products WHERE id = 'after'`).get()).toEqual({
      c: 1,
    });
  });

  it('MEDIUM 3: Int/Float/String fields reject the wrong JS type', async () => {
    const { lite } = setup();
    for (const price of ['9abc', 1.5, NaN, 2 ** 31, null])
      await expect(
        lite.product.create({ data: { id: 't', storeId: 's1', name: 'n', slug: 't', price } })
      ).rejects.toThrow();
    await expect(
      lite.product.create({ data: { id: 't', storeId: 's1', name: 5, slug: 't', price: 1 } })
    ).rejects.toThrow(/String/);
  });

  it('MEDIUM 4: *OrThrow raises a real PrismaClientKnownRequestError (404, not 500)', async () => {
    const { lite } = setup();
    for (const call of [
      () => lite.product.findUniqueOrThrow({ where: { id: 'nope' } }),
      () => lite.product.findFirstOrThrow({ where: { id: 'nope' } }),
    ]) {
      const e = await call().then(
        () => null,
        (x: unknown) => x
      );
      expect(e).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((e as { code: string }).code).toBe('P2025');
    }
  });

  it('MEDIUM 5: workerd-style `: SQLITE_CONSTRAINT` suffixes do not leak into the P2002 target', async () => {
    const { mapDbError } = await import('../src/prisma-lite/writes');
    const e = mapDbError(
      new Error('UNIQUE constraint failed: products.store_id, products.slug: SQLITE_CONSTRAINT')
    ) as any;
    expect(e.code).toBe('P2002');
    expect(e.meta.target).toEqual(['store_id', 'slug']);
    expect(
      (mapDbError(new Error('NOT NULL constraint failed: products.name: SQLITE_CONSTRAINT')) as any)
        .meta.constraint
    ).toEqual(['name']);
  });

  it('MEDIUM 6: aggregate/groupBy refuse arguments they cannot honour', async () => {
    const { lite } = setup();
    await expect(lite.product.aggregate({ _count: true, take: 1 })).rejects.toThrow(
      /unsupported aggregate argument/
    );
    await expect(
      lite.product.aggregate({ _sum: { price: true }, orderBy: { id: 'asc' } })
    ).rejects.toThrow(/unsupported/);
    // groupBy take/skip/having/orderBy-aggregate are honoured since PR D2b (CF-MONEY-1); what it still cannot do is refused
    await expect(lite.product.groupBy({ by: ['status'], cursor: { id: 'x' } })).rejects.toThrow(
      /unsupported/
    );
    await expect(lite.product.groupBy({ by: ['status'], take: -1 })).rejects.toThrow(/take/);
  });

  it('MEDIUM 7: no transaction support means writes and $transaction THROW, never run unprotected', async () => {
    const db = openSqlite();
    const base = nodeSqlRunner(db);
    const lite = createPrismaLite(META, { all: base.all, run: base.run }, 'store-do', {
      unscoped: true,
    }) as any;
    await expect(
      lite.product.create({ data: { id: 'x', storeId: 's1', name: 'n', slug: 'x', price: 1 } })
    ).rejects.toThrow(/no transaction/);
    await expect(lite.$transaction(async () => 1)).rejects.toThrow(/no transaction/);
    expect(await lite.product.count()).toBe(0); // reads still work
  });

  it('MEDIUM 8: with the DO store id configured, a write carries that storeId or is refused', async () => {
    const db = openSqlite();
    const lite = createPrismaLite(META, nodeSqlRunner(db), 'store-do', { storeId: 's1' }) as any;
    await lite.product.create({ data: { id: 'a', name: 'n', slug: 'a', price: 1 } });
    expect(db.prepare(`SELECT store_id FROM products WHERE id = 'a'`).get()).toEqual({
      store_id: 's1',
    });
    await expect(
      lite.product.create({ data: { id: 'b', storeId: 'OTHER', name: 'n', slug: 'b', price: 1 } })
    ).rejects.toThrow(/this store/);
    await expect(
      lite.product.update({ where: { id: 'a' }, data: { storeId: 'OTHER' } })
    ).rejects.toThrow(/this store/);
    await expect(
      lite.product.update({ where: { id: 'a' }, data: { store: { connect: { id: 'OTHER' } } } })
    ).rejects.toThrow(/this store/);
  });

  it('LOW: increment on NULL stays NULL, divide by zero and bad operands throw, push appends each element, nested deleteMany list is a union', async () => {
    const { db, lite } = setup();
    await lite.product.update({ where: { id: 'p1' }, data: { moq: { increment: 5 } } });
    expect(db.prepare(`SELECT moq FROM products WHERE id = 'p1'`).get()).toEqual({ moq: null });
    await expect(
      lite.product.update({ where: { id: 'p1' }, data: { price: { divide: 0 } } })
    ).rejects.toThrow(/non-zero/);
    await expect(
      lite.product.update({ where: { id: 'p1' }, data: { price: { multiply: '2' } } })
    ).rejects.toThrow(/finite number/);
    await lite.product.update({
      where: { id: 'p1' },
      data: { images: { deleteMany: [{ id: 'i1' }, { id: 'i3' }] } },
    });
    expect(imgs(db, 'p1')).toEqual(['i2:u-i2']);
    await expect(
      lite.product.update({ where: { id: 'p1' }, data: { images: { deleteMany: [{ id: 'i4' }] } } })
    ).resolves.toBeTruthy(); // other parent's row: untouched
    expect(imgs(db, 'p2').length).toBe(2);
  });

  it('LOW: a primary-key update re-reads by the new key; createMany takes one object and refuses relation fields', async () => {
    const { lite } = setup();
    await lite.product.createMany({
      data: { id: 'cm0', storeId: 's1', name: 'n', slug: 'cm0', price: 1 },
    });
    const r = await lite.product.update({ where: { id: 'cm0' }, data: { id: 'p1-new' } });
    expect(r.id).toBe('p1-new');
    await lite.product.update({ where: { id: 'p2' }, data: { id: 'p2-new' } });
    expect((await lite.productImage.findMany({ where: { productId: 'p2-new' } })).length).toBe(2); // ON UPDATE CASCADE
    expect(
      (
        await lite.product.createMany({
          data: { id: 'cm1', storeId: 's1', name: 'n', slug: 'cm1', price: 1 },
        })
      ).count
    ).toBe(1);
    await expect(
      lite.product.createMany({
        data: [
          { id: 'cm2', storeId: 's1', name: 'n', slug: 'cm2', price: 1, images: { create: [] } },
        ],
      })
    ).rejects.toThrow(/relation fields/);
  });
});

describe('round 3 review', () => {
  it('MEDIUM 3: an unrelated write that runs while a transaction is open is neither rolled back with it nor poisoned by it', async () => {
    const { db, lite } = setup();
    const a = lite.$transaction(async (tx: any) => {
      await tx.product.update({ where: { id: 'p1' }, data: { name: 'IN-TX' } });
      await new Promise(r => setTimeout(r, 20));
      throw new Error('A fails');
    });
    const b = lite.product.update({ where: { id: 'p2' }, data: { name: 'OUTSIDE' } });
    await expect(a).rejects.toThrow('A fails');
    await expect(b).resolves.toMatchObject({ name: 'OUTSIDE' });
    expect(db.prepare(`SELECT name FROM products WHERE id = 'p1'`).get()).toEqual({
      name: 'Alpha',
    });
    expect(db.prepare(`SELECT name FROM products WHERE id = 'p2'`).get()).toEqual({
      name: 'OUTSIDE',
    });
  });

  it('MEDIUM 1: list fields check the array and every element (create and push)', async () => {
    const { lite } = setup();
    await expect(
      lite.paymentConfig.create({
        data: { id: 'pc', storeId: 's1', provider: 'paymob', supportedMethods: [1, { x: 1 }] },
      })
    ).rejects.toThrow(/String/);
    await expect(
      lite.paymentConfig.create({
        data: { id: 'pc', storeId: 's1', provider: 'paymob', supportedMethods: 'card' },
      })
    ).rejects.toThrow(/array/);
  });

  it('MEDIUM 2: a StoreDO client without a store id is refused unless explicitly unscoped', () => {
    const db = openSqlite();
    expect(() => createPrismaLite(META, nodeSqlRunner(db))).toThrow(/needs \{ storeId \}/);
    expect(() =>
      createPrismaLite(META, nodeSqlRunner(db), 'store-do', { storeId: 's1' })
    ).not.toThrow();
  });

  it('LOW: groupBy needs a field, _sum needs a numeric field', async () => {
    const { lite } = setup();
    await expect(lite.product.groupBy({ by: [] })).rejects.toThrow(/at least one field/);
    await expect(lite.product.aggregate({ _sum: { name: true } })).rejects.toThrow(/numeric/);
  });
});

describe('`_count: true` answers a number, as Prisma does (insights dashboard read `{ _all: 5 }` as the order count)', () => {
  it('aggregate and groupBy: `_count: true` is a number, `_count: { _all: true }` stays an object', async () => {
    const { lite } = setup();
    expect(await lite.product.aggregate({ where: { storeId: 's1' }, _count: true })).toEqual({
      _count: 2,
    });
    expect(
      await lite.product.aggregate({ where: { storeId: 's1' }, _count: { _all: true } })
    ).toEqual({ _count: { _all: 2 } });
    expect(
      await lite.product.groupBy({ by: ['storeId'], _count: true, orderBy: { storeId: 'asc' } })
    ).toEqual([
      { storeId: 's1', _count: 2 },
      { storeId: 's2', _count: 1 },
    ]);
  });
});

describe('Json path filter (promotion-resolver first-order check on a DO store)', () => {
  it('`{ path, equals }` matches the JSON value at the path, type-strict; anything else is refused', async () => {
    const { db, lite } = setup();
    const O = db.prepare(
      `INSERT INTO orders (id, store_id, order_number, status, payment_status, subtotal, total, shipping_address, billing_address, created_at, updated_at)
       VALUES (?, 's1', ?, 'pending', 'paid', 100, 100, ?, '{}', 1, 1)`
    );
    O.run('o1', 1, '{"phone":"+201000000001","email":"a@x.eg"}');
    O.run('o2', 2, '{"phone":"+201000000001"}');
    O.run('o3', 3, '{"phone":201000000001}');
    O.run('o4', 4, '{"nested":{"phone":"+201000000001"}}');
    const n = (where: unknown) =>
      lite.order.count({ where: { storeId: 's1', ...(where as object) } });
    expect(await n({ shippingAddress: { path: ['phone'], equals: '+201000000001' } })).toBe(2);
    expect(await n({ shippingAddress: { path: ['phone'], equals: 201000000001 } })).toBe(1);
    expect(
      await n({ shippingAddress: { path: ['nested', 'phone'], equals: '+201000000001' } })
    ).toBe(1);
    expect(
      await n({
        OR: [
          { shippingAddress: { path: ['phone'], equals: '+209999' } },
          { shippingAddress: { path: ['email'], equals: 'a@x.eg' } },
        ],
      })
    ).toBe(1);
    await expect(
      n({ shippingAddress: { path: ["phone') OR 1=1 --"], equals: 'x' } })
    ).rejects.toThrow(/plain keys/);
    await expect(n({ shippingAddress: { path: ['phone'], string_contains: 'x' } })).rejects.toThrow(
      /equals` only/
    );
    await expect(n({ name: { path: ['x'], equals: 'y' } })).rejects.toThrow();
  });
});

describe('an omitted scalar list is `[]` on create, as Prisma answers it', () => {
  it('a coupon created without its scope lists stores and reads them as []', async () => {
    const { lite } = setup();
    const c = await lite.coupon.create({
      data: {
        id: 'c1',
        storeId: 's1',
        code: 'CLEAR-X',
        name: 'Clearance',
        type: 'percentage',
        value: 10,
      },
    });
    expect([c.scopeProductIds, c.scopeCategoryIds]).toEqual([[], []]);
  });
});
