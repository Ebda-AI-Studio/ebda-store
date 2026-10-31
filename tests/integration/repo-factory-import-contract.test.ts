/**
 * INFRA-CF-1 R3 (Ruling IMPORT-DO-1): the CSV import orchestrator on the StoreDO gives the same result and leaves the same
 * rows as the Postgres interactive transaction. The scenario drives the real `BulkService.importProducts` once on Postgres
 * (unchanged code) and once with the DO money client over the real DO schema on SQLite; the scrubbed traces (the import
 * result, then products, stock, history, links, options and variants, and the platform slug redirects) must be equal.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@ebda/database';
import {
  answerMoneyOp,
  decodeRpc,
  encodeRpc,
  ensureMoneyOpsSchema,
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import {
  makeMoneyClient,
  storeDb,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { hasDb } from '../helpers/bundle-fixtures';
import { GoldRateService } from '../../apps/api/src/services/gold-rate/gold-rate.service';
import { featureService } from '../../apps/api/src/services/feature.service';
import { BulkService } from '../../apps/api/src/services/bulk.service';

const sfx = Date.now().toString(36);
let STORE = '';
let ownerId = '';
const sqlite = openSqlite();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, STORE, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  return {
    storeId: STORE,
    backend: 'do' as const,
    db: c as StoreReads,
    writer: c as StoreWrites,
    money,
  };
}
const pgRepo = () => ({
  storeId: STORE,
  backend: 'pg' as const,
  db: prisma as never,
  writer: prisma as never,
});
const onPg = <T>(f: () => Promise<T>) => withRepo(pgRepo(), f);
const onDo = <T>(f: () => Promise<T>) => withRepo(doRepo(), f);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function scrub(v: unknown, names: Record<string, string>, sfxk = ''): unknown {
  let text = JSON.stringify(canon(v)) ?? 'null';
  if (sfxk) text = text.split(`-${sfxk}`).join('-<k>');
  for (const [id, name] of Object.entries(names)) text = text.split(id).join(`<${name}>`);
  return JSON.parse(
    text
      .replace(UUID, '<id>')
      .replace(/ORD-[A-Z0-9-]+/g, '<no>')
      .replace(/\b\d{12}\b/g, '<ref>')
      .replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"')
  );
}
const settle = async <T>(f: () => Promise<T>) =>
  f().then(
    v => ({ ok: v }),
    (e: { code?: string; statusCode?: number; message?: string }) => ({
      err: {
        status: e.statusCode,
        code: e.code,
        message: e.code ? undefined : String(e.message).slice(0, 120),
      },
    })
  );

let n = 0;
/** Two products that already exist in the store (one is renamed by the file, one gets variants from it), mirrored into the DO. */
async function world(mirror: boolean) {
  const k = `${sfx}${++n}`;
  const mk = (sku: string, slug: string, name: string, inventory: number) =>
    prisma.product.create({
      data: {
        storeId: STORE,
        name,
        slug: `${slug}-${k}`,
        sku: `${sku}-${k}`,
        price: 1_000,
        status: 'active',
        inventory,
        trackInventory: true,
      },
    });
  const old = await mk('OLD', 'old-slug', 'Old', 7);
  const keep = await mk('KEEP', 'keep', 'Keep', 3);
  if (mirror) insertSqlite(sqlite, 'Product', [old, keep] as never);
  return { k, old: old.id, keep: keep.id };
}
type W = Awaited<ReturnType<typeof world>>;

const csvFor = (w: W) =>
  [
    'name,nameAr,slug,sku,price,inventory,status,categories,tags,images,description,parentSku,option1Name,option1Value',
    // update by sku with a NEW slug (redirect) and new stock
    `Old Renamed,,renamed-${w.k},OLD-${w.k},1500,11,active,Shoes,sale,https://example.com/a.jpg,fresh text,,,`,
    // a new product with links, opening stock and three variants
    `Tee,تيشيرت,tee-${w.k},TEE-${w.k},2000,5,active,"Shoes,Tops","sale,new",https://example.com/t1.jpg,,,,`,
    `,,,TEE-S-${w.k},2000,4,,,,,,TEE-${w.k},Size,S`,
    `,,,TEE-M-${w.k},2100,6,,,,,,TEE-${w.k},Size,M`,
    `,,,TEE-L-${w.k},2200,8,,,,,,TEE-${w.k},Size,L`,
    // variants for a parent that exists in the store but is not in the file
    `,,,KEEP-X-${w.k},900,2,,,,,,KEEP-${w.k},Color,Red`,
    // a bad row: no price
    `Broken,,broken-${w.k},BRK-${w.k},,1,active,,,,,,,`,
  ].join('\n');

async function state(w: W) {
  const db = (await storeDb(STORE)) as any;
  const products = await db.product.findMany({
    where: { storeId: STORE, sku: { endsWith: w.k } },
    select: {
      id: true,
      name: true,
      slug: true,
      sku: true,
      price: true,
      inventory: true,
      status: true,
      hasVariants: true,
      description: true,
    },
    orderBy: { sku: 'asc' },
  });
  const ids = products.map((p: any) => p.id);
  const label = new Map(products.map((p: any) => [p.id, p.sku.replace(`-${w.k}`, '')]));
  const catNames = await Promise.all(
    (
      await db.productCategory.findMany({
        where: { productId: { in: ids } },
        select: { productId: true, categoryId: true },
      })
    ).map(async (l: any) => ({
      p: label.get(l.productId),
      c: (await db.category.findFirst({ where: { id: l.categoryId }, select: { name: true } }))
        .name,
    }))
  );
  const tagNames = await Promise.all(
    (
      await db.productTag.findMany({
        where: { productId: { in: ids } },
        select: { productId: true, tagId: true },
      })
    ).map(async (l: any) => ({
      p: label.get(l.productId),
      t: (await db.tag.findFirst({ where: { id: l.tagId }, select: { name: true } })).name,
    }))
  );
  const images = (
    await db.productImage.findMany({
      where: { productId: { in: ids } },
      select: { productId: true, url: true, position: true },
    })
  ).map((i: any) => ({ p: label.get(i.productId), url: i.url, position: i.position }));
  const variants = (
    await db.productVariant.findMany({
      where: { productId: { in: ids } },
      select: {
        productId: true,
        title: true,
        sku: true,
        price: true,
        inventory: true,
        position: true,
      },
    })
  ).map((v: any) => ({
    p: label.get(v.productId),
    title: v.title,
    sku: v.sku,
    price: v.price,
    inventory: v.inventory,
    position: v.position,
  }));
  const options = (
    await db.productOption.findMany({
      where: { productId: { in: ids } },
      select: { productId: true, name: true, position: true },
    })
  ).map((o: any) => ({ p: label.get(o.productId), name: o.name, position: o.position }));
  const history = (
    await db.inventoryHistory.findMany({
      where: { productId: { in: ids } },
      select: { productId: true, type: true, quantity: true, newStock: true },
    })
  ).map((h: any) => ({
    p: label.get(h.productId),
    type: h.type,
    quantity: h.quantity,
    newStock: h.newStock,
  }));
  const redirects = await prisma.slugRedirect.findMany({
    where: { storeId: STORE, toSlug: { endsWith: w.k } },
    select: { fromSlug: true, toSlug: true },
  });
  const sortBy = (a: any[]) =>
    [...a].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  return {
    products: products.map((p: any) => ({ ...p, id: undefined })),
    categories: sortBy(catNames),
    tags: sortBy(tagNames),
    images: sortBy(images),
    variants: sortBy(variants),
    options: sortBy(options),
    history: sortBy(history),
    redirects,
  };
}

async function parity(act?: (w: W) => Promise<unknown>) {
  const run = async (on: typeof onPg, mirror: boolean) => {
    const w = await world(mirror);
    const out = await settle(() =>
      on(() => BulkService.importProducts(STORE, csvFor(w), { updateExisting: true }, ownerId))
    );
    void act;
    return scrub(
      { out, state: await on(() => state(w)) },
      { [w.old]: 'old', [w.keep]: 'keep' },
      w.k
    );
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  return pg as any;
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `r3imp-${sfx}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'R',
      lastName: 'I',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  STORE = (
    await prisma.store.create({
      data: {
        name: 'R3Imp',
        slug: `r3imp-${sfx}`,
        ownerId: owner.id,
        status: 'active',
        plan: 'enterprise',
      },
    })
  ).id;
});
beforeEach(() => {
  vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(false);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)('CSV import on Postgres vs the DO', () => {
  it('products, stock, history, links, options, variants and redirects come out the same; the bad row fails alone', async () => {
    const t = await parity();
    expect(t.out.ok).toMatchObject({
      total: 7,
      created: 1,
      updated: 1,
      variantsCreated: 4,
      failed: 1,
    });
    expect(t.state.redirects).toHaveLength(1);
    expect(t.state.history).toContainEqual({ p: 'TEE', type: 'initial', quantity: 5, newStock: 5 });
    expect(t.state.variants).toHaveLength(4);
  });
});

/**
 * Gold specs through the import (Ruling IMPORT-DO-1 + CF-LAST-1): the batch commits as one DO section, then each gold row is
 * applied through `GoldRateService.setProductPricing` (its own money section). The same CSV must leave the same pricing on both.
 */
describe.skipIf(!hasDb)('CSV import with gold specs on Postgres vs the DO', () => {
  let goldN = 0;
  async function goldWorld(mirror: boolean) {
    const k = `g${sfx}${++goldN}`;
    await GoldRateService.applyRates(
      STORE,
      { rates: [{ karat: 21, ratePerGram: 576_000 }], confirm: true },
      { userId: ownerId }
    );
    // a fixed-price product the file switches to gold, and a gold one the file switches back to fixed
    const toGold = await prisma.product.create({
      data: {
        storeId: STORE,
        name: 'Ring',
        slug: `ring-${k}`,
        sku: `RING-${k}`,
        price: 1_000,
        status: 'active',
      },
    });
    const chain = await prisma.product.create({
      data: {
        storeId: STORE,
        name: 'Chain',
        slug: `chain-${k}`,
        sku: `CHAIN-${k}`,
        price: 2_000,
        status: 'active',
      },
    });
    await GoldRateService.setProductPricing(
      STORE,
      chain.id,
      {
        product: {
          pricingMode: 'gold_rate',
          karat: 21,
          weightMg: 3250,
          makingChargeType: 'per_gram',
          makingChargeValue: 15_000,
          marginBps: 0,
        },
      },
      { userId: ownerId }
    );
    const toFixed = await prisma.product.findUniqueOrThrow({ where: { id: chain.id } });
    if (mirror) {
      sqlite.exec('DELETE FROM gold_rates_current; DELETE FROM gold_rates');
      insertSqlite(
        sqlite,
        'GoldRate',
        (await prisma.goldRate.findMany({ where: { storeId: STORE } })) as never
      );
      insertSqlite(
        sqlite,
        'GoldRateCurrent',
        (await prisma.goldRateCurrent.findMany({ where: { storeId: STORE } })) as never
      );
      insertSqlite(sqlite, 'Product', [toGold, toFixed] as never);
    }
    return { k, toGold: toGold.id, toFixed: toFixed.id };
  }
  const goldCsv = (w: { k: string }) =>
    [
      'name,slug,sku,price,inventory,status,pricing_mode,gold_karat,gold_weight_g',
      `Ring,ring-${w.k},RING-${w.k},1000,0,active,gold_rate,21,3.25`,
      `Chain,chain-${w.k},CHAIN-${w.k},2000,0,active,fixed,,`,
      `New Bangle,bangle-${w.k},BANGLE-${w.k},1,0,active,gold_rate,21,5`,
      `Bad Karat,badk-${w.k},BADK-${w.k},1,0,active,gold_rate,19,5`,
    ].join('\n');
  async function goldState(k: string) {
    const db = (await storeDb(STORE)) as any;
    return db.product.findMany({
      where: { storeId: STORE, sku: { endsWith: k } },
      select: {
        sku: true,
        price: true,
        compareAtPrice: true,
        pricingMode: true,
        goldKarat: true,
        goldWeightMg: true,
        makingChargeType: true,
        makingChargeValue: true,
        goldMarginBps: true,
      },
      orderBy: { sku: 'asc' },
    });
  }
  it('gold specs are applied through the import, a gold product price edit and a bad karat fail alone: equal on both backends', async () => {
    const run = async (on: typeof onPg, mirror: boolean) => {
      const w = await goldWorld(mirror);
      const out = await settle(() =>
        on(() => BulkService.importProducts(STORE, goldCsv(w), { updateExisting: true }, ownerId))
      );
      return scrub({ out, state: await on(() => goldState(w.k)) }, {}, w.k);
    };
    const pg = (await run(onPg, false)) as any;
    const dobj = await run(onDo, true);
    expect(dobj).toEqual(pg);
    const by = (sku: string) => pg.state.find((p: any) => p.sku === `${sku}-<k>`);
    expect(by('RING').pricingMode).toBe('gold_rate');
    expect(by('RING').goldWeightMg).toBe(3250);
    expect(by('RING').price).toBeGreaterThan(1_000); // repriced from the 21k rate
    // Ruling B5-13: a file may not change the price of a gold product, so its row is refused whole, on both backends
    expect(by('CHAIN').pricingMode).toBe('gold_rate');
    expect(pg.out.ok.errors.some((e: any) => /priced by the gold rate/.test(e.error))).toBe(true);
    expect(by('BANGLE').pricingMode).toBe('gold_rate');
    expect(pg.out.ok.failed).toBe(2);
    expect(pg.state.find((p: any) => p.sku === 'BADK-<k>')).toBeUndefined();
  });
});
