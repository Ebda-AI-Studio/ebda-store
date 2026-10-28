/**
 * INFRA-CF-1 task 2.4/2.5 (Ruling CF-REPO-1): the READ paths moved onto `storeDb` return the same thing on both
 * backends. The same rows go into real Postgres (through Prisma) and into the StoreDO schema on SQLite; each moved service
 * call then runs once with the store on 'pg' and once with the store on 'do' (an in-process Durable Object: the real
 * wire codec, the real read executor, prisma-lite over node:sqlite), and the canonicalised results must be deeply equal.
 * Empty results prove nothing, so every case also asserts it returned data (or the specific empty answer under test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
import { createDoClient, runReads, createPrismaLite } from '@ebda-src/repo';
import { BlogService } from '../../apps/api/src/services/blog.service';
import { PagesService } from '../../apps/api/src/services/pages.service';
import { LocationsService } from '../../apps/api/src/services/locations.service';
import { SizeChartService } from '../../apps/api/src/services/size-chart.service';
import { ProductService } from '../../apps/api/src/services/product.service';
import { storeDb, withRepo, type StoreReads } from '../../apps/api/src/lib/repo-factory';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';

const sfx = Date.now().toString(36);
let STORE = '';
let OTHER = '';
let userId = '';
const db = openSqlite();
const otherDb = openSqlite();

const doClient = (sqlite: ReturnType<typeof openSqlite>, storeId: string) => {
  const lite = createPrismaLite(META as never, nodeSqlRunner(sqlite), 'store-do', { storeId });
  return createDoClient(q => runReads(lite as never, q)) as unknown as StoreReads;
};

/** Run `call` with the store served by Postgres, then by the in-process Durable Object; return both. */
async function both<T>(call: () => Promise<T>) {
  const pg = await runInTenantContext(STORE, () =>
    withRepo({ storeId: STORE, backend: 'pg', db: prisma as never }, call)
  );
  const dobj = await withRepo({ storeId: STORE, backend: 'do', db: doClient(db, STORE) }, call);
  return { pg: canon(pg), dobj: canon(dobj) };
}
const same = async <T>(call: () => Promise<T>, nonEmpty = true) => {
  const { pg, dobj } = await both(call);
  if (nonEmpty) expect(Array.isArray(pg) ? pg.length : pg).toBeTruthy();
  expect(dobj).toEqual(pg);
  return pg;
};

/** Create in Postgres (inside the store's tenant scope, as production does) and mirror the returned row into SQLite. */
async function seed<T extends object>(
  model: string,
  create: () => Promise<T>,
  into: Array<ReturnType<typeof openSqlite>> = [db]
) {
  const row = await runInTenantContext(STORE, create);
  for (const d of into) insertSqlite(d, model, [row as Record<string, unknown>]);
  return row;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `repo-contract-${sfx}@example.test`,
      passwordHash: 'x',
      firstName: 'R',
      lastName: 'C',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  userId = user.id;
  STORE = (
    await prisma.store.create({
      data: {
        name: 'Repo Contract',
        slug: `repo-contract-${sfx}`,
        ownerId: userId,
        status: 'active',
      },
    })
  ).id;
  OTHER = (
    await prisma.store.create({
      data: { name: 'Repo Other', slug: `repo-other-${sfx}`, ownerId: userId, status: 'active' },
    })
  ).id;

  // blog: two published (ordered by publishedAt then createdAt), one draft
  const t = (d: number) => new Date(Date.UTC(2026, 0, d));
  for (const [slug, isPublished, publishedAt] of [
    ['post-a', true, t(3)],
    ['post-b', true, t(5)],
    ['post-draft', false, null],
  ] as const)
    await seed('BlogPost', () =>
      prisma.blogPost.create({
        data: {
          storeId: STORE,
          slug,
          title: `Title ${slug}`,
          titleAr: `عنوان ${slug}`,
          content: `Body ${slug}`,
          isPublished,
          publishedAt,
        },
      })
    );
  // pages: published with blocks, hard-off
  await seed('StorePage', () =>
    prisma.storePage.create({
      data: {
        storeId: STORE,
        slug: 'about',
        title: 'About',
        titleAr: 'عنا',
        contentBlocks: [{ type: 'paragraph', text: 'Hello' }],
        contentBlocksAr: [{ type: 'paragraph', text: 'مرحبا' }],
        isPublished: true,
        position: 2,
      },
    })
  );
  await seed('StorePage', () =>
    prisma.storePage.create({
      data: { storeId: STORE, slug: 'hidden', title: 'Hidden', isPublished: false, position: 1 },
    })
  );
  // locations
  for (const [name, isPublished, position] of [
    ['Cairo', true, 1],
    ['Alex', true, 0],
    ['Closed', false, 2],
  ] as const)
    await seed('StoreLocation', () =>
      prisma.storeLocation.create({
        data: {
          storeId: STORE,
          name,
          country: 'Egypt',
          address: `${name} St`,
          isPublished,
          position,
        },
      })
    );
  // size charts
  for (const name of ['Rings', 'Tops'])
    await seed('SizeChart', () =>
      prisma.sizeChart.create({
        data: {
          storeId: STORE,
          name,
          nameAr: `م-${name}`,
          unit: 'cm',
          columns: [
            { label: 'Size', labelAr: 'المقاس' },
            { label: 'Cm', labelAr: 'سم' },
          ],
          rows: [
            ['S', '10'],
            ['M', '12'],
          ],
        },
      })
    );
  // tags: a popular one, a rarer one, one with only an archived product (must not show)
  const tag = (name: string, nameAr: string | null) =>
    seed('Tag', () => prisma.tag.create({ data: { storeId: STORE, name, nameAr } }));
  const sensitive = (await tag('sensitive', 'حساسة')) as { id: string };
  const oily = (await tag('oily', null)) as { id: string };
  const ghost = (await tag('ghost', null)) as { id: string };
  const product = (slug: string, status: 'active' | 'archived') =>
    seed('Product', () =>
      prisma.product.create({
        data: { storeId: STORE, name: slug, slug, price: 100, inventory: 1, status },
      })
    ) as Promise<{ id: string }>;
  const p1 = await product('p1', 'active');
  const p2 = await product('p2', 'active');
  const p3 = await product('p3', 'archived');
  for (const [p, g] of [
    [p1, sensitive],
    [p2, sensitive],
    [p1, oily],
    [p3, ghost],
  ] as const)
    await seed('ProductTag', () =>
      prisma.productTag.create({ data: { productId: p.id, tagId: g.id } })
    );
});

afterAll(async () => {
  await prisma.store.deleteMany({ where: { id: { in: [STORE, OTHER] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('moved reads are identical on both backends', () => {
  it('SizeChartService.listPublic', async () => {
    expect((await same(() => SizeChartService.listPublic(STORE))) as unknown[]).toHaveLength(2);
  });

  it('BlogService.listPublished (order, paging) and getPublishedBySlug (published / draft / missing)', async () => {
    const list = (await same(() => BlogService.listPublished(STORE, { limit: 10 }))) as {
      slug: string;
    }[];
    expect(list.map(p => p.slug)).toEqual(['post-b', 'post-a']); // newest first, draft hidden
    await same(() => BlogService.listPublished(STORE, { limit: 1, offset: 1 }));
    await same(() => BlogService.getPublishedBySlug(STORE, 'post-a'));
    expect(await same(() => BlogService.getPublishedBySlug(STORE, 'post-draft'), false)).toBeNull();
    expect(await same(() => BlogService.getPublishedBySlug(STORE, 'nope'), false)).toBeNull();
  });

  it('PagesService.list / get (compound unique) / getPublic (ok, disabled, not_found)', async () => {
    const pages = (await same(() => PagesService.list(STORE))) as { slug: string }[];
    expect(pages.map(p => p.slug)).toEqual(['hidden', 'about']); // by position
    await same(() => PagesService.get(STORE, 'about'));
    expect(await same(() => PagesService.get(STORE, 'missing'), false)).toBeNull();
    expect(await same(() => PagesService.getPublic(STORE, 'about'))).toMatchObject({
      status: 'ok',
    });
    expect(await same(() => PagesService.getPublic(STORE, 'hidden'))).toEqual({
      status: 'disabled',
    });
    expect(await same(() => PagesService.getPublic(STORE, 'missing'))).toEqual({
      status: 'not_found',
    });
  });

  it('LocationsService.list / listPublished (compound orderBy)', async () => {
    const all = (await same(() => LocationsService.list(STORE))) as { name: string }[];
    expect(all.map(l => l.name)).toEqual(['Alex', 'Cairo', 'Closed']);
    const pub = (await same(() => LocationsService.listPublished(STORE))) as { name: string }[];
    expect(pub.map(l => l.name)).toEqual(['Alex', 'Cairo']);
  });

  it('ProductService.getPublicTags (relation filter, _count ordering) and getPublicTagByName', async () => {
    const tags = (await same(() => ProductService.getPublicTags(STORE))) as {
      name: string;
      productCount: number;
    }[];
    expect(tags.map(t => [t.name, t.productCount])).toEqual([
      ['sensitive', 2],
      ['oily', 1],
    ]); // 'ghost' has only an archived product
    expect(await same(() => ProductService.getPublicTagByName(STORE, 'sensitive'))).toMatchObject({
      name: 'sensitive',
    });
    expect(await same(() => ProductService.getPublicTagByName(STORE, 'ghost'), false)).toBeNull();
  });
});

describe('isolation on the moved path', () => {
  it("a store's Durable Object never returns another store's rows, whichever id the caller asks for", async () => {
    // OTHER has its own DO (its own SQLite) holding ONE page; STORE's DO holds two.
    const o = (await runInTenantContext(OTHER, () =>
      prisma.storePage.create({
        data: { storeId: OTHER, slug: 'other-only', title: 'Other', isPublished: true },
      })
    )) as unknown as Record<string, unknown>;
    insertSqlite(otherDb, 'StorePage', [o]);

    const a = await withRepo({ storeId: STORE, backend: 'do', db: doClient(db, STORE) }, () =>
      PagesService.list(STORE)
    );
    const b = await withRepo({ storeId: OTHER, backend: 'do', db: doClient(otherDb, OTHER) }, () =>
      PagesService.list(OTHER)
    );
    expect(a.map(p => p.slug).sort()).toEqual(['about', 'hidden']);
    expect(b.map(p => p.slug)).toEqual(['other-only']);

    // asking STORE's client for OTHER's id still reads STORE's DO (the DO is the boundary), and finds nothing of OTHER's
    const crossed = await withRepo(
      { storeId: STORE, backend: 'do', db: doClient(db, STORE) },
      async () => (await storeDb(STORE)).storePage.findMany({ where: { storeId: OTHER } })
    );
    expect(crossed).toEqual([]);
  });
});
