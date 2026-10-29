/**
 * INFRA-CF-1 PR D1b (Ruling CF-WRITES-2): every writer moved in D1b gives the same result on Postgres and on the StoreDO.
 * Each test is a SCENARIO: a function that drives real services/handlers and returns a trace of what they returned and
 * what the store then holds. The same scenario runs once on Postgres (inside the store's tenant scope, as production does)
 * and once against the DO schema on SQLite (real wire codec, `runWrites`, prisma-lite, the same seeded rows); the scrubbed
 * traces must be equal. The scenario looks its own ids up, so generated ids may differ per backend.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';
import {
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
  applyStoreSettings,
} from '@ebda-src/repo';
import { ProductService } from '../../apps/api/src/services/product.service';
import { VariantService } from '../../apps/api/src/services/variant.service';
import { BulkService } from '../../apps/api/src/services/bulk.service';
import { PriceTierService } from '../../apps/api/src/services/price-tier.service';
import { recommendationService } from '../../apps/api/src/services/recommendation.service';
import { applyStoreCategories } from '../../apps/api/src/services/store-category-suggest.service';
import * as PageBuilder from '../../apps/api/src/services/page-builder.service';
import {
  storeWriter,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';

vi.mock('../../apps/api/src/lib/b2b-invalidate', async importOriginal => ({
  ...(await importOriginal<typeof import('../../apps/api/src/lib/b2b-invalidate')>()),
  assertWholesaleEntitled: async () => undefined,
}));

const sfx = Date.now().toString(36);
let STORE = '';
let userId = '';
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function scrub(v: unknown): unknown {
  const text = JSON.stringify(canon(v)) ?? 'null';
  return JSON.parse(text.replace(UUID, '<id>').replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"'));
}
const settle = async <T>(f: () => Promise<T>) =>
  f().then(
    v => ({ ok: v }),
    (e: { code?: string; statusCode?: number; message?: string }) => ({
      err: {
        code: e.code,
        status: e.statusCode,
        message: e.code ? undefined : String(e.message).slice(0, 160),
      },
    })
  );
const onPg = <T>(f: () => Promise<T>) => runInTenantContext(STORE, () => withRepo(pgRepo(), f));
const onDo = <T>(f: () => Promise<T>) => runInTenantContext(STORE, () => withRepo(doRepo(), f));

/** Run the scenario on both backends and demand identical scrubbed traces. Returns the (shared) trace. */
async function parity(scenario: () => Promise<unknown>) {
  const pg = scrub(await settle(() => onPg(scenario)));
  const dobj = scrub(await settle(() => onDo(scenario)));
  expect(dobj).toEqual(pg);
  expect(pg).toHaveProperty('ok'); // a scenario that throws proves nothing
  return (pg as { ok: any }).ok;
}
/** Rows of a model through the CURRENT backend (the scenario's own view). */
const rows = async (model: string, args: Record<string, unknown> = {}) =>
  ((await storeWriter(STORE)) as any)[model].findMany({ where: { storeId: STORE }, ...args });

async function seed(model: string, create: () => Promise<object>) {
  const row = await runInTenantContext(STORE, create);
  insertSqlite(sqlite, model, [row as Record<string, unknown>]);
  return row as any;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `d1b-${sfx}@example.test`,
      passwordHash: 'x',
      firstName: 'D',
      lastName: 'B',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  userId = user.id;
  STORE = (
    await prisma.store.create({
      data: { name: 'D1b', slug: `d1b-${sfx}`, ownerId: userId, status: 'active' },
    })
  ).id;
});
afterAll(async () => {
  await prisma.store.deleteMany({ where: { id: STORE } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('products', () => {
  it('create (nested images + categories, slug de-duplication) and a non-zero opening stock is refused on the DO only', async () => {
    const cat = await seed('Category', () =>
      prisma.category.create({ data: { storeId: STORE, name: 'Rings', slug: `rings-${sfx}` } })
    );
    const trace = await parity(async () => {
      const a = await ProductService.create(STORE, {
        name: 'Ruby Ring',
        price: 1000,
        images: [{ url: 'https://x.test/1.jpg' }, { url: 'https://x.test/2.jpg' }],
        categories: [cat.id],
      } as never);
      const b = await ProductService.create(STORE, { name: 'Ruby Ring', price: 1200 } as never); // same name -> ruby-ring-1
      return {
        a,
        b,
        products: await rows('product', { orderBy: { slug: 'asc' } }),
        images: await ((await storeWriter(STORE)) as any).productImage.findMany({
          orderBy: { position: 'asc' },
        }),
      };
    });
    expect(trace.products.map((p: any) => p.slug)).toEqual(['ruby-ring', 'ruby-ring-1']);
    const stock = () =>
      ProductService.create(STORE, { name: 'Stocked', price: 5, inventory: 7 } as never);
    expect((await settle(() => onPg(stock))).hasOwnProperty('ok')).toBe(true);
    expect(await settle(() => onDo(stock))).toMatchObject({
      err: { message: expect.stringContaining('stock columns') },
    });
  });

  it('update (replace images, replace categories keeping saved positions, ai provenance merge, slug change), soft delete, getById', async () => {
    const [c1, c2] = await Promise.all(
      ['A', 'B'].map(n =>
        seed('Category', () =>
          prisma.category.create({
            data: { storeId: STORE, name: n, slug: `${n.toLowerCase()}-${sfx}` },
          })
        )
      )
    );
    const p = await seed('Product', () =>
      prisma.product.create({
        data: {
          storeId: STORE,
          name: 'Gem',
          slug: `gem-${sfx}`,
          price: 100,
          inventory: 2,
          status: 'active',
          aiFieldSources: { metaTitle: 'ai', excerpt: 'ai' },
        },
      })
    );
    await seed('ProductCategory', () =>
      prisma.productCategory.create({ data: { productId: p.id, categoryId: c1.id, position: 4 } })
    );
    await seed('ProductImage', () =>
      prisma.productImage.create({
        data: { productId: p.id, url: 'https://x.test/old.jpg', alt: 'old', position: 0 },
      })
    );
    const trace = await parity(async () => {
      const upd = await ProductService.update(STORE, p.id, {
        name: 'Gem v2',
        price: 150,
        description: 'Fine gem',
        images: [{ url: 'https://x.test/n1.jpg' }, { url: 'https://x.test/n2.jpg', alt: 'two' }],
        categories: [c1.id, c2.id],
      } as never);
      const again = await ProductService.getById(STORE, p.id);
      const links = await ((await storeWriter(STORE)) as any).productCategory.findMany({
        where: { productId: p.id },
        orderBy: { position: 'asc' },
      });
      return { upd, again, links };
    });
    expect(trace.links.map((l: any) => l.position).sort()).toEqual([0, 4]); // c1 keeps its saved position 4, c2 is new at 0
    expect(trace.upd.aiFieldSources).toMatchObject({ metaTitle: 'ai', excerpt: 'ai' }); // untouched keys survive the merge
    expect(trace.again.store).toMatchObject({ slug: `d1b-${sfx}` }); // the D1 `store` relation is attached on both backends
    const gone = await parity(async () => {
      await ProductService.delete(STORE, p.id);
      return (await rows('product', { where: { id: p.id, storeId: STORE } }))[0]?.deletedAt != null;
    });
    expect(gone).toBe(true);
  });

  it('bulk: update (flags, status, category link, price set), delete soft + hard, status; low stock threshold', async () => {
    const cat = await seed('Category', () =>
      prisma.category.create({ data: { storeId: STORE, name: 'Bulk', slug: `bulk-${sfx}` } })
    );
    const ps = await Promise.all(
      [1, 2, 3].map(i =>
        seed('Product', () =>
          prisma.product.create({
            data: {
              storeId: STORE,
              name: `Bulk ${i}`,
              slug: `bulk-${i}-${sfx}`,
              price: 10 * i,
              inventory: 1,
              status: 'draft',
            },
          })
        )
      )
    );
    const ids = ps.map(p => p.id);
    const trace = await parity(async () => {
      const upd = await ProductService.bulkUpdate(STORE, ids, {
        status: 'active',
        isFeatured: true,
        addCategoryId: cat.id,
        price: { mode: 'set', value: 777 },
      });
      const st = await BulkService.bulkUpdateStatus(STORE, [ids[0]], 'archived');
      const soft = await BulkService.bulkDelete(STORE, [ids[1]], false);
      const hard = await BulkService.bulkDelete(STORE, [ids[2]], true);
      const links = await ((await storeWriter(STORE)) as any).productCategory.findMany({
        where: { categoryId: cat.id },
      });
      return {
        upd,
        st,
        soft,
        hard,
        links: links.length,
        left: (
          await rows('product', {
            where: { id: { in: ids }, storeId: STORE },
            orderBy: { slug: 'asc' },
          })
        ).map((p: any) => [p.slug, p.status, p.featured, p.price, p.deletedAt != null]),
      };
    });
    expect(trace.left).toHaveLength(2);
    expect(trace.hard).toMatchObject({ deleted: 1 });
  });
});

describe('variants (everything except stock columns)', () => {
  it('option values add/update/delete, createVariant, updateVariant (non-stock), delete, generate, reorder, deleteOption', async () => {
    const p = await seed('Product', () =>
      prisma.product.create({
        data: {
          storeId: STORE,
          name: 'Var',
          slug: `var-${sfx}`,
          price: 100,
          inventory: 0,
          status: 'active',
        },
      })
    );
    const trace = await parity(async () => {
      const opt = await VariantService.addOption(STORE, p.id, {
        name: 'Size',
        values: [{ value: 'S' }, { value: 'M' }],
      });
      const opt2 = await VariantService.addOption(STORE, p.id, {
        name: 'Color',
        values: [{ value: 'Red' }],
      });
      const l = await VariantService.addOptionValue(STORE, p.id, opt.id, { value: 'L' });
      const renamed = await VariantService.updateOptionValue(STORE, p.id, l.id, { value: 'XL' });
      const gen = await VariantService.generateVariants(STORE, p.id);
      const w = (await storeWriter(STORE)) as any;
      const vs = await w.productVariant.findMany({
        where: { productId: p.id },
        orderBy: { title: 'asc' },
      });
      const upd = await VariantService.updateVariant(STORE, p.id, vs[0].id, {
        price: 250,
        isActive: true,
      } as never);
      await VariantService.reorderVariants(STORE, p.id, vs.map((v: any) => v.id).reverse());
      await VariantService.reorderOptions(STORE, p.id, [opt2.id, opt.id]);
      await VariantService.deleteVariant(STORE, p.id, vs[1].id);
      await VariantService.deleteOptionValue(STORE, p.id, renamed.id);
      await VariantService.deleteOption(STORE, p.id, opt2.id);
      return {
        gen,
        upd: { price: upd.price },
        variants: (
          await w.productVariant.findMany({ where: { productId: p.id }, orderBy: { title: 'asc' } })
        ).map((v: any) => [v.title, v.price, v.position]),
        options: (await w.productOption.findMany({ where: { productId: p.id } })).map((o: any) => [
          o.name,
          o.position,
        ]),
        hasVariants: (await w.product.findFirst({ where: { id: p.id } })).hasVariants,
      };
    });
    expect(trace.options).toEqual([['Size', 1]]);
  });

  it('refuses a stock value in a variant patch on the DO (stock stays D2), allows it on Postgres', async () => {
    const p = await seed('Product', () =>
      prisma.product.create({
        data: {
          storeId: STORE,
          name: 'VarS',
          slug: `vars-${sfx}`,
          price: 100,
          inventory: 0,
          status: 'active',
        },
      })
    );
    const opt = await runInTenantContext(STORE, () =>
      prisma.productOption.create({
        data: { productId: p.id, name: 'Size', values: { create: [{ value: 'S' }] } },
        include: { values: true },
      })
    );
    const v = await seed('ProductVariant', () =>
      prisma.productVariant.create({ data: { productId: p.id, title: 'S', inventory: 1 } })
    );
    insertSqlite(sqlite, 'ProductOption', [opt as any]);
    const patch = () => VariantService.updateVariant(STORE, p.id, v.id, { inventory: 9 } as never);
    expect(await settle(() => onPg(patch))).toHaveProperty('ok');
    expect(await settle(() => onDo(patch))).toMatchObject({
      err: { message: expect.stringContaining('stock columns') },
    });
  });
});

describe('page builder revisions', () => {
  it('saveDraft (create, then update guarded by rev, stale baseRev conflicts), publishDraft, listRevisions', async () => {
    const key = 'home';
    const base = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
    const trace = await parity(async () => {
      const r1 = await PageBuilder.saveDraft({
        storeId: STORE,
        pageKey: key,
        baseRev: 0,
        definition: base,
        userId: null,
      });
      const r2 = await PageBuilder.saveDraft({
        storeId: STORE,
        pageKey: key,
        baseRev: 0,
        definition: base,
        userId: null,
      }); // stale
      const r3 = await PageBuilder.saveDraft({
        storeId: STORE,
        pageKey: key,
        baseRev: 1,
        definition: base,
        userId: null,
      });
      const pub = await PageBuilder.publishDraft({ storeId: STORE, pageKey: key, baseRev: 2 });
      const revs = await PageBuilder.listRevisions({ storeId: STORE, pageKey: key, limit: 10 });
      return {
        r1: scrubRes(r1),
        r2: scrubRes(r2),
        r3: scrubRes(r3),
        pub: scrubRes(pub),
        revs: scrubRes(revs),
      };
    });
    expect(trace.r1).toMatchObject({ ok: true });
    expect(trace.r2).toMatchObject({ ok: false });
    expect(trace.pub).toMatchObject({ ok: true });
  });
});
const scrubRes = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));

describe('price tiers, recommendations, product FAQ', () => {
  it('price tiers create / update / remove (+ duplicate tier 409)', async () => {
    const p = await seed('Product', () =>
      prisma.product.create({
        data: {
          storeId: STORE,
          name: 'Tiered',
          slug: `tier-${sfx}`,
          price: 1000,
          inventory: 0,
          status: 'active',
        },
      })
    );
    await parity(async () => {
      const t = await PriceTierService.create(STORE, p.id, { minQty: 10, priceMinor: 900 });
      const dup = await settle(() =>
        PriceTierService.create(STORE, p.id, { minQty: 10, priceMinor: 800 })
      );
      const up = await PriceTierService.update(STORE, p.id, t.tier.id, { priceMinor: 850 });
      await PriceTierService.remove(STORE, p.id, up.tier.id);
      return {
        t: { minQty: t.tier.minQty, priceMinor: t.tier.priceMinor },
        dup,
        up: up.tier.priceMinor,
        left: (await rows('productPriceTier')).length,
      };
    });
  });

  it('product relations: replace-all is atomic, add and remove', async () => {
    const [a, b, c] = await Promise.all(
      ['a', 'b', 'c'].map(n =>
        seed('Product', () =>
          prisma.product.create({
            data: {
              storeId: STORE,
              name: `Rel ${n}`,
              slug: `rel-${n}-${sfx}`,
              price: 1,
              inventory: 0,
              status: 'active',
            },
          })
        )
      )
    );
    await parity(async () => {
      await recommendationService.setProductRelations(STORE, a.id, [
        { targetProductId: b.id, type: 'related' },
        { targetProductId: c.id, type: 'related' },
      ]);
      await recommendationService.setProductRelations(STORE, a.id, [
        { targetProductId: c.id, type: 'related' },
      ]);
      const added = await recommendationService.addRelation(STORE, a.id, {
        targetProductId: b.id,
        type: 'upsell',
      } as never);
      await recommendationService.removeRelation(STORE, a.id, (added as any).id);
      return (await rows('productRelation', { orderBy: { position: 'asc' } })).map((r: any) => [
        r.type,
        r.position,
      ]);
    });
  });

  it('FAQ create / update / delete and the AI FAQ writer (delete AI-drafted + createMany in one batch)', async () => {
    const p = await seed('Product', () =>
      prisma.product.create({
        data: {
          storeId: STORE,
          name: 'Faq',
          slug: `faq-${sfx}`,
          price: 1,
          inventory: 0,
          status: 'active',
        },
      })
    );
    await parity(async () => {
      const w = (await storeWriter(STORE)) as any;
      const f = await w.productFaq.create({
        data: { productId: p.id, question: 'Q1?', answer: 'A1' },
      });
      const u = await w.productFaq.updateMany({
        where: { id: f.id, productId: p.id },
        data: { answer: 'A1b', manuallyEdited: true },
      });
      // bulk-ai-product-faqs: force replaces only AI-drafted, non-edited rows, atomically with the new batch
      await w.productFaq.create({
        data: { productId: p.id, question: 'AI old', answer: 'x', aiDrafted: true },
      });
      await w.$transaction([
        w.productFaq.deleteMany({
          where: { productId: p.id, aiDrafted: true, manuallyEdited: false },
        }),
        w.productFaq.createMany({
          data: [{ productId: p.id, question: 'AI new', answer: 'y', aiDrafted: true }],
        }),
      ]);
      const d = await w.productFaq.deleteMany({ where: { id: f.id, productId: p.id } });
      return {
        u,
        d,
        left: (await w.productFaq.findMany({ where: { productId: p.id } })).map(
          (x: any) => x.question
        ),
      };
    });
  });
});

describe('bulk AI writers (the exact write shapes the jobs issue)', () => {
  it('product copy fields, category SEO, image alt, tag create + link (skipDuplicates), categorize', async () => {
    const cat = await seed('Category', () =>
      prisma.category.create({ data: { storeId: STORE, name: 'Ai', slug: `ai-${sfx}` } })
    );
    const p = await seed('Product', () =>
      prisma.product.create({
        data: {
          storeId: STORE,
          name: 'AiP',
          slug: `aip-${sfx}`,
          price: 1,
          inventory: 0,
          status: 'active',
        },
      })
    );
    const img = await seed('ProductImage', () =>
      prisma.productImage.create({
        data: { productId: p.id, url: 'https://x.test/a.jpg', alt: '', position: 0 },
      })
    );
    const trace = await parity(async () => {
      const w = (await storeWriter(STORE)) as any;
      await w.product.update({
        where: { id: p.id, storeId: STORE },
        data: { metaDescriptionAeo: 'AEO', metaDescriptionAeoAr: null, excerpt: 'Ex' },
      });
      await w.category.update({
        where: { id: cat.id, storeId: STORE },
        data: { metaDescriptionAeo: 'C-AEO' },
      });
      await w.productImage.update({ where: { id: img.id }, data: { alt: 'A ruby ring' } });
      const tag = await w.tag.create({ data: { storeId: STORE, name: 'gift' } });
      await w.productTag.createMany({
        data: [{ productId: p.id, tagId: tag.id }],
        skipDuplicates: true,
      });
      await w.productTag.createMany({
        data: [{ productId: p.id, tagId: tag.id }],
        skipDuplicates: true,
      }); // duplicate is skipped
      await w.productCategory.create({
        data: { productId: p.id, categoryId: cat.id, position: 0 },
      });
      return {
        p: await w.product.findFirst({
          where: { id: p.id },
          select: { metaDescriptionAeo: true, excerpt: true },
        }),
        c: await w.category.findFirst({
          where: { id: cat.id },
          select: { metaDescriptionAeo: true },
        }),
        alt: (await w.productImage.findFirst({ where: { id: img.id } })).alt,
        tags: await w.productTag.count({ where: { productId: p.id } }),
      };
    });
    expect(trace).toMatchObject({ alt: 'A ruby ring', tags: 1 });
  });

  it('store category suggestions apply in ONE batch with generated ids', async () => {
    const ps = await Promise.all(
      [1, 2].map(i =>
        seed('Product', () =>
          prisma.product.create({
            data: {
              storeId: STORE,
              name: `Sg${i}`,
              slug: `sg${i}-${sfx}`,
              price: 1,
              inventory: 0,
              status: 'active',
            },
          })
        )
      )
    );
    const trace = await parity(async () => {
      const res = await applyStoreCategories({
        storeId: STORE,
        userId,
        categories: [
          { name: 'Suggested A', nameAr: '', productIds: [ps[0].id] },
          { name: 'Suggested B', nameAr: '', productIds: [ps[0].id, ps[1].id] },
        ],
      });
      const w = (await storeWriter(STORE)) as any;
      return {
        res: JSON.parse(JSON.stringify(res, (k, v) => (k === 'id' ? undefined : v))),
        links: await w.productCategory.count({ where: { productId: { in: ps.map(p => p.id) } } }),
      };
    });
    expect(trace.links).toBeGreaterThanOrEqual(3);
  });
});

describe('settings copy and the Store split', () => {
  it('applyStoreSettings writes the DO copy: profile and config columns, reports D1-only, refuses unknown fields; store_profile needs its row', () => {
    const sql = nodeSqlRunner(sqlite);
    sqlite.exec(
      `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES ('${STORE}', 'D1b', 'd1b', 'u')`
    );
    const r = applyStoreSettings(sql as never, META as never, STORE, {
      theme: { primary: '#B08D57' },
      heroTitle: 'Hi',
      blogEnabled: true,
      returnWindowDays: 14,
      domainStatus: 'active',
      slug: undefined,
    });
    expect(r.directoryOnly).toEqual(['domainStatus']);
    expect([...r.profile, ...r.config].sort()).toEqual([
      'blogEnabled',
      'heroTitle',
      'returnWindowDays',
      'theme',
    ]);
    const p = sqlite
      .prepare('SELECT theme, hero_title FROM store_profile WHERE store_id = ?')
      .get(STORE) as any;
    expect([JSON.parse(p.theme), p.hero_title]).toEqual([{ primary: '#B08D57' }, 'Hi']);
    const c = sqlite
      .prepare('SELECT blog_enabled, return_window_days FROM store_config WHERE store_id = ?')
      .get(STORE) as any;
    expect([c.blog_enabled, c.return_window_days]).toEqual([1, 14]);
    expect(() => applyStoreSettings(sql as never, META as never, STORE, { notAField: 1 })).toThrow(
      /unknown Store field/
    );
    expect(() =>
      applyStoreSettings(sql as never, META as never, 'someone-else', { heroTitle: 'x' })
    ).toThrow(/store_profile row is missing/);
  });
});
