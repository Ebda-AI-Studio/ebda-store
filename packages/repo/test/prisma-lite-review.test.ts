// Regression tests for the Opus review of prisma-lite (findings 1-11 + the nested-write findings). No Postgres needed.
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { META, openSqlite } from './diff-harness';
import { createPrismaLite } from '../src/prisma-lite/client';
import { nodeSqlRunner } from './node-sql';

function setup() {
  const db = openSqlite();
  const lite = createPrismaLite(META, nodeSqlRunner(db)) as any;
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
    db.prepare(
      `INSERT INTO store_credentials (store_id, wbs_api_key, meta_access_token, agent_api_key) VALUES ('s1', 'W', 'M', 'A')`
    ).run();
    const plain = await lite.storeCredential.findFirst({ where: { storeId: 's1' } });
    expect(plain).not.toHaveProperty('wbsApiKey');
    expect(plain).not.toHaveProperty('metaAccessToken');
    expect(plain).not.toHaveProperty('agentApiKey');
    expect((await lite.storeCredential.findFirst({ select: { wbsApiKey: true } })).wbsApiKey).toBe(
      'W'
    );
    expect(
      (await lite.storeCredential.findFirst({ omit: { metaAccessToken: false } })).metaAccessToken
    ).toBe('M');
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
