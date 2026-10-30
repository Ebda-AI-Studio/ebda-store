/**
 * INFRA-CF-1 R6b (Ruling CF-R6B-1): readers of DO-writable models that were direct Postgres reads now follow the store's
 * backend. Each scenario runs the real service once with the store on Postgres and once on the Durable Object (real DO schema
 * on SQLite) and the answers must be equal - and a switch WRITTEN on the DO must be HONOURED when read back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@ebda/database';
import {
  createDoClient,
  createPrismaLite,
  runReads,
  runWrites,
  ensureIdempotencySchema,
} from '@ebda-src/repo';
import {
  storeDb,
  storeWriter,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { hasDb } from '../helpers/bundle-fixtures';
import { InventoryService } from '../../apps/api/src/services/inventory.service';
import { ProductService } from '../../apps/api/src/services/product.service';
import { redis } from '../../apps/api/src/services/redis.service';

const sfx = Date.now().toString(36);
let STORE = '';
let ownerId = '';
const sqlite = openSqlite();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  return { storeId: STORE, backend: 'do' as const, db: c as StoreReads, writer: c as StoreWrites };
}
const pgRepo = () => ({
  storeId: STORE,
  backend: 'pg' as const,
  db: prisma as never,
  writer: prisma as never,
});
const onPg = <T>(f: () => Promise<T>) => withRepo(pgRepo(), f);
const onDo = <T>(f: () => Promise<T>) => withRepo(doRepo(), f);

const settle = async <T>(f: () => Promise<T>) =>
  f().then(
    v => ({ ok: v }),
    (e: { code?: string; statusCode?: number }) => ({ err: { status: e.statusCode, code: e.code } })
  );
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const scrub = (v: unknown) =>
  JSON.parse(
    (JSON.stringify(canon(v)) ?? 'null')
      .replace(UUID, '<id>')
      .replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"')
  );

const ids: Record<string, string> = {};
async function seedProduct(slug: string, data: Record<string, unknown> = {}) {
  const row = await prisma.product.create({
    data: {
      storeId: STORE,
      name: slug,
      slug,
      price: 100,
      inventory: 5,
      status: 'active',
      ...data,
    } as never,
  });
  insertSqlite(sqlite, 'Product', [row as Record<string, unknown>]);
  ids[slug] = row.id;
  return row;
}

beforeAll(async () => {
  if (!hasDb) return;
  ownerId = (
    await prisma.user.create({
      data: {
        email: `r6b-${sfx}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'R',
        lastName: 'B',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    })
  ).id;
  STORE = (
    await prisma.store.create({
      data: { name: 'R6b', slug: `r6b-${sfx}`, ownerId, status: 'active' },
    })
  ).id;
  await seedProduct('visible');
  await seedProduct('archived', { status: 'archived' });
  await seedProduct('deleted', { deletedAt: new Date('2026-01-01') });
  await seedProduct('wholesale', { audience: 'wholesale_only' });
  await seedProduct('threshold', { trackInventory: true, lowStockThreshold: 3 });
  const cat = await prisma.category.create({
    data: { storeId: STORE, name: 'Rings', slug: `rings-${sfx}` },
  });
  insertSqlite(sqlite, 'Category', [cat as Record<string, unknown>]);
});
afterAll(async () => {
  if (!hasDb) return;
  await prisma.store.deleteMany({ where: { id: STORE } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)('R6b routed readers: Postgres vs the Durable Object', () => {
  it('storefront product by slug: visible is served, archived / deleted / wholesale-only are 404 on both backends', async () => {
    for (const slug of ['visible', 'archived', 'deleted', 'wholesale']) {
      await redis.delete(`product:${STORE}:${slug}`).catch(() => undefined);
      const pg = scrub(await onPg(() => settle(() => ProductService.getPublicBySlug(STORE, slug))));
      const dobj = scrub(
        await onDo(() => settle(() => ProductService.getPublicBySlug(STORE, slug)))
      );
      expect(dobj, slug).toEqual(pg);
      if (slug === 'visible')
        expect((pg as { ok?: unknown }).ok, 'visible must return data').toBeTruthy();
      else expect((pg as { err?: unknown }).err, `${slug} must be refused`).toBeTruthy();
    }
  });

  it('filter options (categories, tags, price range aggregate) are equal', async () => {
    const pg = scrub(await onPg(() => settle(() => ProductService.getFilterOptions(STORE))));
    const dobj = scrub(await onDo(() => settle(() => ProductService.getFilterOptions(STORE))));
    expect(dobj).toEqual(pg);
    expect(JSON.stringify(pg)).toContain('"min":100');
  });

  it('storefront listing serves only visible products, with the D1 store ref put back, equal on both backends', async () => {
    const run = (on: typeof onPg) =>
      on(() => settle(() => ProductService.listPublic(STORE, { page: 1, limit: 20 } as never)));
    const pg = scrub(await run(onPg));
    const dobj = scrub(await run(onDo));
    expect(dobj).toEqual(pg);
    const names = ((pg as any).ok.products as Array<{ slug: string; store?: unknown }>)
      .map(p => p.slug)
      .sort();
    expect(names).toEqual(['threshold', 'visible']);
    expect(
      (pg as any).ok.products[0].store,
      'the store ref is part of the row on both backends'
    ).toBeTruthy();
  });

  it('a low-stock threshold WRITTEN on the DO is honoured when read, and Postgres answers the same', async () => {
    const run = async (on: typeof onPg) =>
      scrub(
        await on(async () => {
          const first = await InventoryService.updateThreshold(STORE, ids.threshold, 9);
          const back = await (
            await storeDb(STORE)
          ).product.findFirst({
            where: { id: ids.threshold },
            select: { lowStockThreshold: true },
          });
          const gone = await settle(() => InventoryService.updateThreshold(STORE, ids.deleted, 1));
          return { first, back, gone };
        })
      );
    const pg = (await run(onPg)) as {
      first: { lowStockThreshold: number };
      back: { lowStockThreshold: number };
      gone: { err?: unknown };
    };
    const dobj = await run(onDo);
    expect(dobj).toEqual(pg);
    expect(pg.back.lowStockThreshold).toBe(9);
    expect(pg.gone.err, 'a soft-deleted product is not found').toBeTruthy();
    // the DO row itself carries the switch (not a Postgres read-through)
    const doRow = await onDo(async () =>
      (await storeWriter(STORE)).product.findFirst({
        where: { id: ids.threshold },
        select: { lowStockThreshold: true },
      })
    );
    expect(doRow?.lowStockThreshold).toBe(9);
  });
});
