// Prisma-lite READ fidelity: every query below runs through real Prisma on Postgres AND prisma-lite on the
// StoreDO schema over SQLite, over the same rows; the canonicalised results must be identical.
// Needs PRISMALITE_PG_URL (a migrated Postgres); skipped without it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canon, insertSqlite, makePair, PG_URL } from './diff-harness';

const run = PG_URL ? describe : describe.skip;

run('prisma-lite reads == Prisma reads', () => {
  let pair: Awaited<ReturnType<typeof makePair>>;
  let storeId = '';
  const sfx = Math.random().toString(36).slice(2, 8);

  async function both(model: string, data: Record<string, unknown>) {
    const delegate = model[0].toLowerCase() + model.slice(1);
    const row = await (pair.prisma as any)[delegate].create({ data });
    insertSqlite(pair.db, model, [row]);
    return row;
  }

  beforeAll(async () => {
    pair = await makePair();
    const user = await pair.prisma.user.create({
      data: {
        email: `diff-${sfx}@example.com`,
        passwordHash: 'x',
        firstName: 'D',
        lastName: 'T',
      } as never,
    });
    const store = await pair.prisma.store.create({
      data: {
        name: 'Diff',
        slug: `diff-${sfx}`,
        ownerId: user.id,
        emailSenderLocalPart: `diff-${sfx}`,
      } as never,
    });
    storeId = store.id;
    const catA = await both('Category', { storeId, name: 'Rings', slug: 'rings', position: 2 });
    const catB = await both('Category', { storeId, name: 'خواتم', slug: 'khawatem', position: 1 });
    const tag = await both('Tag', { storeId, name: 'gift' });
    const mk = async (i: number, extra: Record<string, unknown> = {}) =>
      both('Product', {
        storeId,
        name: `Product ${i}`,
        nameAr: `منتج ${i}`,
        slug: `p-${i}`,
        price: 1000 * i,
        inventory: i % 3,
        status: i === 5 ? 'draft' : 'active',
        featured: i % 2 === 0,
        ...extra,
      });
    const ps = [];
    for (let i = 1; i <= 7; i++) ps.push(await mk(i, i === 3 ? { compareAtPrice: 9000 } : {}));
    for (const [i, p] of ps.entries()) {
      await both('ProductImage', { productId: p.id, url: `https://x/${i}-a.jpg`, position: 1 });
      await both('ProductImage', { productId: p.id, url: `https://x/${i}-b.jpg`, position: 0 });
      await both('ProductImage', { productId: p.id, url: `https://x/${i}-c.jpg`, position: 2 });
      await both('ProductCategory', {
        productId: p.id,
        categoryId: i % 2 ? catA.id : catB.id,
        position: i,
      });
      if (i % 3 === 0) await both('ProductTag', { productId: p.id, tagId: tag.id });
      if (i % 2 === 1)
        await both('ProductVariant', {
          productId: p.id,
          title: 'S',
          sku: `sku-${i}`,
          price: 1000 * i,
          inventory: 4,
          isActive: true,
        });
    }
  });

  afterAll(async () => {
    if (!pair) return;
    await pair.prisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
    await pair.close();
  });

  const cases: [string, string, () => Record<string, unknown>][] = [
    [
      'plain list ordered',
      'product',
      () => ({
        where: { storeId, deletedAt: null, status: 'active' },
        orderBy: { createdAt: 'desc' },
      }),
    ],
    [
      'price asc + take/skip',
      'product',
      () => ({ where: { storeId }, orderBy: [{ price: 'asc' }, { id: 'asc' }], take: 3, skip: 2 }),
    ],
    [
      'range + in + NOT',
      'product',
      () => ({
        where: { storeId, price: { gte: 2000, lte: 6000 }, NOT: { slug: { in: ['p-3', 'p-4'] } } },
        orderBy: { price: 'asc' },
      }),
    ],
    [
      'contains insensitive Arabic and Latin',
      'product',
      () => ({
        where: {
          storeId,
          OR: [
            { name: { contains: 'product 1', mode: 'insensitive' } },
            { nameAr: { contains: 'منتج 2' } },
          ],
        },
        orderBy: { price: 'asc' },
      }),
    ],
    [
      'case-sensitive contains',
      'product',
      () => ({ where: { storeId, name: { contains: 'roduct 2' } } }),
    ],
    [
      'relation some (category) + every/none',
      'product',
      () => ({
        where: {
          storeId,
          categories: { some: { categoryId: undefined, category: { slug: 'rings' } } },
        },
        orderBy: { price: 'asc' },
      }),
    ],
    [
      'tags none',
      'product',
      () => ({ where: { storeId, tags: { none: {} } }, orderBy: { price: 'asc' } }),
    ],
    [
      'isNot null / is null',
      'product',
      () => ({ where: { storeId, compareAtPrice: { not: null } } }),
    ],
    [
      'listing select shape (images take 2, categories include, variants select, store select)',
      'product',
      () => ({
        where: { storeId, status: 'active', deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          name: true,
          nameAr: true,
          slug: true,
          price: true,
          compareAtPrice: true,
          inventory: true,
          featured: true,
          images: { orderBy: { position: 'asc' }, take: 2 },
          categories: { include: { category: true } },
          variants: {
            select: {
              id: true,
              price: true,
              compareAtPrice: true,
              inventory: true,
              allowBackorder: true,
              isActive: true,
            },
          },
        },
      }),
    ],
    [
      'include with _count',
      'product',
      () => ({
        where: { storeId },
        orderBy: { price: 'asc' },
        include: {
          images: { orderBy: { position: 'asc' } },
          _count: { select: { variants: true, images: true } },
        },
      }),
    ],
    [
      "order by a relation's row count, Prisma's shape ({ rel: { _count } }), then a tiebreak",
      'product',
      () => ({
        where: { storeId },
        orderBy: [{ variants: { _count: 'desc' } }, { images: { _count: 'asc' } }, { slug: 'asc' }],
        select: { slug: true, _count: { select: { variants: true } } },
      }),
    ],
    [
      'category ordered by joined product createdAt',
      'productCategory',
      () => ({
        where: { categoryId: undefined, category: { slug: 'rings' } },
        orderBy: [{ position: 'asc' }, { product: { createdAt: 'desc' } }],
        select: { productId: true },
      }),
    ],
  ];

  cases.push(
    [
      'NULL ordering asc (default nulls)',
      'product',
      () => ({ where: { storeId }, orderBy: [{ compareAtPrice: 'asc' }, { id: 'asc' }] }),
    ],
    [
      'NULL ordering desc (default nulls)',
      'product',
      () => ({ where: { storeId }, orderBy: [{ compareAtPrice: 'desc' }, { id: 'asc' }] }),
    ],
    [
      'not scalar drops NULL like Prisma',
      'product',
      () => ({ where: { storeId, compareAtPrice: { not: 1234 } }, orderBy: { id: 'asc' } }),
    ],
    [
      'not equals drops NULL like Prisma',
      'product',
      () => ({
        where: { storeId, compareAtPrice: { not: { equals: 1234 } } },
        orderBy: { id: 'asc' },
      }),
    ],
    [
      'not in drops NULL like Prisma',
      'product',
      () => ({
        where: { storeId, compareAtPrice: { not: { in: [1234] } } },
        orderBy: { id: 'asc' },
      }),
    ],
    [
      'notIn drops NULL like Prisma',
      'product',
      () => ({ where: { storeId, compareAtPrice: { notIn: [1234] } }, orderBy: { id: 'asc' } }),
    ],
    [
      'insensitive equals',
      'product',
      () => ({ where: { storeId, name: { equals: 'PRODUCT 3', mode: 'insensitive' } } }),
    ],
    [
      'insensitive in',
      'product',
      () => ({
        where: { storeId, name: { in: ['PRODUCT 3', 'product 4'], mode: 'insensitive' } },
        orderBy: { id: 'asc' },
      }),
    ],
    [
      'nested take/skip per parent',
      'product',
      () => ({
        where: { storeId },
        orderBy: { slug: 'asc' },
        select: { slug: true, images: { orderBy: { position: 'asc' }, skip: 1, take: 1 } },
      }),
    ],
    [
      'cursor desc page',
      'product',
      () => ({
        where: { storeId },
        orderBy: { slug: 'desc' },
        cursor: { storeId_slug: { storeId, slug: 'p-5' } },
        take: 3,
        skip: 1,
      }),
    ]
  );
  for (const [name, model, build] of cases) {
    it(name, async () => {
      const args = build();
      const [a, b] = await Promise.all([
        (pair.prisma as any)[model].findMany(args),
        (pair.lite as any)[model].findMany(args),
      ]);
      expect(canon(b)).toEqual(canon(a));
      expect(a.length).toBeGreaterThan(0);
    });
  }

  it('count agrees', async () => {
    const where = { storeId, featured: true, status: 'active' };
    expect(await pair.lite.product.count({ where })).toBe(
      await pair.prisma.product.count({ where: where as never })
    );
  });
  it('findUnique by compound key and findFirst agree', async () => {
    const a = await pair.prisma.product.findUnique({
      where: { storeId_slug: { storeId, slug: 'p-2' } } as never,
    });
    const b = await pair.lite.product.findUnique({
      where: { storeId_slug: { storeId, slug: 'p-2' } },
    });
    expect(canon(b)).toEqual(canon(a));
    expect(
      canon(await pair.lite.product.findFirst({ where: { storeId }, orderBy: { price: 'desc' } }))
    ).toEqual(
      canon(await pair.prisma.product.findFirst({ where: { storeId }, orderBy: { price: 'desc' } }))
    );
  });
});
