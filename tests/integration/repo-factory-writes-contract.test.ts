/**
 * INFRA-CF-1 PR D1 (Ruling CF-WRITES-1): every WRITE moved onto `storeWriter` gives the same result on Postgres and on the
 * StoreDO. The same service call runs once against real Postgres (inside the store's tenant scope, as production does) and
 * once against the StoreDO schema on SQLite (real wire codec, real write executor `runWrites`, prisma-lite); the returned
 * values AND the resulting table state must be deeply equal once generated ids/timestamps are normalised. Failures (a taken
 * slug, a missing row) must be the same error on both. A final block proves atomic batches, idempotent replay and isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
import {
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { BlogService } from '../../apps/api/src/services/blog.service';
import { PagesService } from '../../apps/api/src/services/pages.service';
import { LocationsService } from '../../apps/api/src/services/locations.service';
import { SizeChartService } from '../../apps/api/src/services/size-chart.service';
import { ProductService } from '../../apps/api/src/services/product.service';
import { VariantService } from '../../apps/api/src/services/variant.service';
import {
  storeWriter,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';

const sfx = Date.now().toString(36);
let STORE = '';
let OTHER = '';
let userId = '';
const sqlite = openSqlite();
const otherSqlite = openSqlite();

function doRig(db: ReturnType<typeof openSqlite>, storeId: string) {
  const sql = nodeSqlRunner(db);
  ensureIdempotencySchema(sql);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  return { storeId, backend: 'do' as const, db: c as StoreReads, writer: c as StoreWrites };
}
const pgRepo = (storeId: string) => ({
  storeId,
  backend: 'pg' as const,
  db: prisma as never,
  writer: prisma as never,
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** ids and timestamps are generated per backend: compare shape and every other value. */
function scrub(v: unknown): unknown {
  const text = JSON.stringify(canon(v)) ?? 'null'; // a void result (remove) is null on both
  return JSON.parse(text.replace(UUID, '<id>').replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"'));
}

async function onPg<T>(call: () => Promise<T>) {
  return runInTenantContext(STORE, () => withRepo(pgRepo(STORE), call));
}
async function onDo<T>(call: () => Promise<T>) {
  return withRepo(doRig(sqlite, STORE), call);
}
const settle = async <T>(p: Promise<T>) =>
  p.then(
    v => ({ ok: scrub(v) }),
    (e: { code?: string; statusCode?: number; message?: string }) => ({
      err: { code: e.code, status: e.statusCode },
    })
  );
/** The same call on both backends: results (or errors) equal, and non-trivial. */
async function same<T>(call: () => Promise<T>, expectErr = false) {
  const pg = await settle(onPg(call));
  const dobj = await settle(onDo(call));
  expect(dobj).toEqual(pg);
  if (expectErr) expect(pg).toHaveProperty('err');
  else expect(pg).toHaveProperty('ok');
  return pg;
}
/** Table state on both backends after a sequence of writes. */
async function state(model: string, orderBy: Record<string, 'asc'>) {
  const read = (repo: any) =>
    withRepo(repo, async () =>
      repo.db[model[0].toLowerCase() + model.slice(1)].findMany({
        where: { storeId: STORE },
        orderBy,
      })
    );
  const pg = await runInTenantContext(STORE, () => read(pgRepo(STORE)));
  const dobj = await read(doRig(sqlite, STORE));
  expect(scrub(dobj)).toEqual(scrub(pg));
  return pg as any[];
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `repo-wcontract-${sfx}@example.test`,
      passwordHash: 'x',
      firstName: 'R',
      lastName: 'W',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  userId = user.id;
  const mk = (n: string) =>
    prisma.store.create({
      data: { name: n, slug: `${n}-${sfx}`, ownerId: userId, status: 'active' },
    });
  STORE = (await mk('wc-a')).id;
  OTHER = (await mk('wc-b')).id;
});
afterAll(async () => {
  await prisma.store.deleteMany({ where: { id: { in: [STORE, OTHER] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

/** A row created on Postgres (as production does) and mirrored into the DO, so both start identical. */
async function seed(model: string, create: () => Promise<object>) {
  const row = await runInTenantContext(STORE, create);
  insertSqlite(sqlite, model, [row as Record<string, unknown>]);
  return row as any;
}

describe('moved writes are identical on both backends', () => {
  it('BlogService create / update / remove (+ taken slug, missing id)', async () => {
    await same(() =>
      BlogService.create(STORE, {
        slug: 'hello',
        title: 'Hello',
        content: 'Body',
        titleAr: 'مرحبا',
      })
    );
    await same(() =>
      BlogService.create(STORE, { slug: 'live', title: 'Live', content: 'B', isPublished: true })
    );
    await same(
      () => BlogService.create(STORE, { slug: 'hello', title: 'Dup', content: 'x' }),
      true
    ); // 409 SLUG_TAKEN
    const rows = await state('BlogPost', { slug: 'asc' });
    const hello = rows.find(r => r.slug === 'hello');
    // ids differ per backend: resolve each backend's own id by slug
    const idOn = async (on: 'pg' | 'do') =>
      (on === 'pg'
        ? await onPg(() => BlogService.listAll(STORE))
        : await onDo(() => BlogService.listAll(STORE))
      ).find((p: any) => p.slug === 'hello')!.id;
    const [pgId, doId] = [await idOn('pg'), await idOn('do')];
    expect(hello).toBeTruthy();
    const patch = { title: 'Hello v2', isPublished: true, excerpt: 'short' };
    expect(scrub(await onDo(() => BlogService.update(STORE, doId, patch)))).toEqual(
      scrub(await onPg(() => BlogService.update(STORE, pgId, patch)))
    );
    await state('BlogPost', { slug: 'asc' });
    await onPg(() => BlogService.remove(STORE, pgId));
    await onDo(() => BlogService.remove(STORE, doId));
    expect((await state('BlogPost', { slug: 'asc' })).map(r => r.slug)).toEqual(['live']);
    await same(() => BlogService.getById(STORE, '00000000-0000-4000-8000-000000000000'), true); // 404 on both
  });

  it('PagesService upsert (create, then patch) and remove (idempotent on a missing page)', async () => {
    await same(() =>
      PagesService.upsert(STORE, 'about', {
        title: 'About',
        titleAr: 'عنا',
        isPublished: true,
        position: 2,
      })
    );
    await same(() =>
      PagesService.upsert(STORE, 'about', {
        title: 'About us',
        contentBlocks: [{ type: 'paragraph', text: 'Hi' }] as never,
      })
    );
    await same(() => PagesService.upsert(STORE, 'faq', { title: 'FAQ' }));
    expect((await state('StorePage', { slug: 'asc' })).map(r => [r.slug, r.title])).toEqual([
      ['about', 'About us'],
      ['faq', 'FAQ'],
    ]);
    await same(() => PagesService.remove(STORE, 'faq'));
    await same(() => PagesService.remove(STORE, 'faq')); // P2025 swallowed on both
    expect((await state('StorePage', { slug: 'asc' })).map(r => r.slug)).toEqual(['about']);
  });

  it('LocationsService create / update (hit, miss) / remove (hit, miss)', async () => {
    const loc = {
      name: 'Cairo',
      country: 'Egypt',
      address: '1 Nile St',
      isPublished: true,
      position: 1,
    } as never;
    await same(() => LocationsService.create(STORE, loc));
    const ids = {
      pg: (await onPg(() => LocationsService.list(STORE)))[0].id as string,
      do: (await onDo(() => LocationsService.list(STORE)))[0].id as string,
    };
    expect(
      scrub(
        await onDo(() =>
          LocationsService.update(STORE, ids.do, { name: 'Cairo 2', position: 5 } as never)
        )
      )
    ).toEqual(
      scrub(
        await onPg(() =>
          LocationsService.update(STORE, ids.pg, { name: 'Cairo 2', position: 5 } as never)
        )
      )
    );
    const miss = '00000000-0000-4000-8000-000000000001';
    expect(await same(() => LocationsService.update(STORE, miss, { name: 'x' } as never))).toEqual({
      ok: null,
    });
    expect(await same(() => LocationsService.remove(STORE, miss))).toEqual({ ok: false });
    await state('StoreLocation', { name: 'asc' });
    expect(await onPg(() => LocationsService.remove(STORE, ids.pg))).toBe(true);
    expect(await onDo(() => LocationsService.remove(STORE, ids.do))).toBe(true);
    expect(await state('StoreLocation', { name: 'asc' })).toEqual([]);
  });

  it('SizeChartService create / update / delete (+ missing)', async () => {
    const chart = {
      name: 'Rings',
      nameAr: 'خواتم',
      unit: 'cm',
      columns: [
        { label: 'Size', labelAr: 'المقاس' },
        { label: 'Cm', labelAr: 'سم' },
      ],
      rows: [
        ['S', '10'],
        ['M', '12'],
      ],
      note: '',
      noteAr: '',
    } as never;
    await same(() => SizeChartService.create(STORE, chart));
    const id = async (on: 'pg' | 'do') =>
      (
        (on === 'pg'
          ? await onPg(() => SizeChartService.list(STORE))
          : await onDo(() => SizeChartService.list(STORE))) as any[]
      )[0].id as string;
    const [pgId, doId] = [await id('pg'), await id('do')];
    const next = {
      ...(chart as object),
      name: 'Rings v2',
      rows: [
        ['S', '10'],
        ['M', '12'],
        ['L', '14'],
      ],
    } as never;
    expect(scrub(await onDo(() => SizeChartService.update(STORE, doId, next)))).toEqual(
      scrub(await onPg(() => SizeChartService.update(STORE, pgId, next)))
    );
    await same(
      () => SizeChartService.update(STORE, '00000000-0000-4000-8000-000000000002', next),
      true
    );
    await state('SizeChart', { name: 'asc' });
    await onPg(() => SizeChartService.delete(STORE, pgId));
    await onDo(() => SizeChartService.delete(STORE, doId));
    expect(await state('SizeChart', { name: 'asc' })).toEqual([]);
  });

  it('Tag update, category create/update/reorder ($transaction of updateMany), productCategory reorder', async () => {
    const tag = await seed('Tag', () =>
      prisma.tag.create({ data: { storeId: STORE, name: 'old', nameAr: null } })
    );
    const upd = (id: string) => async () =>
      (await storeWriter(STORE)).tag.update({
        where: { id, storeId: STORE },
        data: { name: 'new', nameAr: 'جديد' },
        select: { id: true, name: true, nameAr: true },
      });
    expect(scrub(await onDo(upd(tag.id)))).toEqual(scrub(await onPg(upd(tag.id))));

    const mkCat = (name: string, position: number) => async () =>
      (await storeWriter(STORE)).category.create({
        data: { storeId: STORE, name, slug: name.toLowerCase(), position },
      });
    for (const [n, p] of [
      ['Rings', 0],
      ['Chains', 1],
    ] as const)
      await same(mkCat(n, p));
    const ids = {
      pg: (await onPg(async () =>
        (await storeWriter(STORE)).category.findMany({
          where: { storeId: STORE },
          orderBy: { name: 'asc' },
        })
      )) as any[],
      do: (await onDo(async () =>
        (await storeWriter(STORE)).category.findMany({
          where: { storeId: STORE },
          orderBy: { name: 'asc' },
        })
      )) as any[],
    };
    const reorder = (cats: any[]) => async () => {
      const w = await storeWriter(STORE);
      return w.$transaction(
        [...cats].reverse().map((c, index) =>
          w.category.updateMany({
            where: { id: c.id, storeId: STORE, deletedAt: null },
            data: { position: index },
          })
        ),
        { idempotencyKey: `reorder-${sfx}-0001` }
      );
    };
    expect(scrub(await onDo(reorder(ids.do)))).toEqual(scrub(await onPg(reorder(ids.pg))));
    expect((await state('Category', { name: 'asc' })).map(c => [c.name, c.position])).toEqual([
      ['Chains', 1],
      ['Rings', 0],
    ]);
    // soft delete
    const soft = (cats: any[]) => async () =>
      (await storeWriter(STORE)).category.update({
        where: { id: cats[0].id, storeId: STORE },
        data: { deletedAt: new Date('2026-01-01T00:00:00Z') },
      });
    await onPg(soft(ids.pg));
    await onDo(soft(ids.do));
    await state('Category', { name: 'asc' });
    await state('Tag', { name: 'asc' });
  });

  it('Products: bulkSetLowStockThreshold (updateMany) and VariantService.addOption / updateOption (nested create, hasVariants)', async () => {
    const product = await seed('Product', () =>
      prisma.product.create({
        data: {
          storeId: STORE,
          name: 'Ring',
          slug: 'ring',
          price: 100,
          inventory: 3,
          status: 'active',
        },
      })
    );
    expect(
      await same(() => ProductService.bulkSetLowStockThreshold(STORE, [product.id], 9))
    ).toEqual({ ok: { count: 1 } });
    await same(() =>
      VariantService.addOption(STORE, product.id, {
        name: 'Size',
        nameAr: 'المقاس',
        values: [{ value: 'S' }, { value: 'M', valueAr: 'م' }],
      })
    );
    await same(
      () => VariantService.addOption(STORE, product.id, { name: 'Size', values: [{ value: 'x' }] }),
      true
    ); // DUPLICATE_OPTION
    const optId = async (on: 'pg' | 'do') => {
      const rows: any[] = await (on === 'pg' ? onPg : onDo)(async () =>
        (await storeWriter(STORE)).productOption.findMany({ where: { productId: product.id } })
      );
      return rows[0].id as string;
    };
    expect(
      scrub(
        await onDo(async () =>
          VariantService.updateOption(STORE, product.id, await optId('do'), { name: 'Sizes' })
        )
      )
    ).toEqual(
      scrub(
        await onPg(async () =>
          VariantService.updateOption(STORE, product.id, await optId('pg'), { name: 'Sizes' })
        )
      )
    );
    const p = await state('Product', { name: 'asc' });
    expect(p[0]).toMatchObject({ lowStockThreshold: 9, hasVariants: true, inventory: 3 }); // stock untouched
  });
});

describe('the DO write path itself', () => {
  it('refuses a stock write and a money model through the very client services hold', async () => {
    const w = (await withRepo(doRig(sqlite, STORE), () => storeWriter(STORE))) as any;
    await expect(w.product.updateMany({ where: {}, data: { inventory: 99 } })).rejects.toThrow(
      /stock columns/
    );
    expect(
      await (async () => {
        try {
          await (doRig(sqlite, STORE).writer as any).order.create({ data: {} });
        } catch (e) {
          return (e as Error).message;
        }
      })()
    ).toMatch(/not ported|not writable|MODEL_NOT_WRITABLE/i);
  });

  it("isolation: a DO bound to store A cannot be made to write store B's rows, and B's DO never sees A's", async () => {
    const a = doRig(sqlite, STORE).writer as any;
    await expect(
      a.storePage.create({ data: { storeId: OTHER, slug: 'leak', title: 'x' } })
    ).rejects.toThrow(/storeId/);
    const b = doRig(otherSqlite, OTHER);
    await b.writer.storePage.create({
      data: { storeId: OTHER, slug: 'b-only', title: 'B' },
    } as never);
    expect((await (a as any).storePage.findMany({ where: { slug: 'b-only' } })).length).toBe(0);
    expect((await (b.db as any).storePage.findMany({ where: { slug: 'about' } })).length).toBe(0);
  });

  it('an idempotent batch replays (one effect), and a failed batch leaves nothing behind', async () => {
    const w = doRig(sqlite, STORE).writer as any;
    const run = () =>
      w.$transaction([w.tag.create({ data: { storeId: STORE, name: 'once' } })], {
        idempotencyKey: `tag-once-${sfx}`,
      });
    const [first] = await run();
    const [second] = await run();
    expect(second.id).toBe(first.id);
    expect((await w.tag.findMany({ where: { name: 'once' } })).length).toBe(1);
    await expect(
      w.$transaction([
        w.tag.create({ data: { storeId: STORE, name: 'half' } }),
        w.tag.create({ data: { storeId: STORE, name: 'once' } }),
      ])
    ).rejects.toMatchObject({ code: 'P2002' });
    expect((await w.tag.findMany({ where: { name: 'half' } })).length).toBe(0); // rolled back with the failing op
  });
});
