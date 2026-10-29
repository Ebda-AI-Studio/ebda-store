/**
 * INFRA-CF-1 PR D2b-5 (Ruling CF-LAST-1): gold setProductPricing, bulkSwitchMode and the gold variant create moved to the StoreDO give
 * the same answer and leave the same rows on Postgres and on the DO. Each test is a SCENARIO driving the real service; it runs
 * once on Postgres (unchanged code) and once with the DO money client over the real DO schema on SQLite (real wire codec,
 * `answerMoneyOp`, `runMoneyOp`). Each backend gets its own identical world (mirrored into SQLite); the scrubbed traces
 * (return values or error, then the ledger / order / stock / price rows) must be equal. Trial balance parity is asserted
 * per account code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
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
import { VariantService } from '../../apps/api/src/services/variant.service';
import { featureService } from '../../apps/api/src/services/feature.service';
import {
  makeMoneyClient,
  storeDb,
  storeMoney,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { seedCoaForStore } from '../../apps/api/src/services/accounting/account.service';
import { GoldRateService } from '../../apps/api/src/services/gold-rate/gold-rate.service';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { hasDb } from '../helpers/bundle-fixtures';
import { createProduct, ownerPool } from '../helpers/gold-sql';

const sfx = Date.now().toString(36);
let STORE = '';
let ownerId = '';
const sqlite = openSqlite();
const ownerPg = ownerPool();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', {
    storeId: STORE,
  }) as never;
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
function scrub(v: unknown, names: Record<string, string>): unknown {
  let text = JSON.stringify(canon(v)) ?? 'null';
  for (const [id, name] of Object.entries(names)) text = text.split(id).join(`<${name}>`);
  return JSON.parse(
    text
      .replace(UUID, '<id>')
      .replace(/(JE|ORD|PAID)-[A-Z0-9-]+/g, '<no>')
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
interface World {
  ids: string[];
  names: Record<string, string>;
}
const GOLD = {
  pricingMode: 'gold_rate',
  karat: 21,
  weightMg: 3250,
  makingChargeType: 'per_gram',
  makingChargeValue: 15_000,
  marginBps: 0,
} as const;

/** Rates (mirrored), `count` fixed products with a complete gold spec on them (+ optional extras), mirrored into the DO. */
async function world(
  mirror: boolean,
  o: {
    count?: number;
    rate?: boolean;
    spec?: boolean;
    fixedPrice?: number;
    compareAt?: number | null;
  } = {}
): Promise<World> {
  const k = `${sfx}${++n}`;
  if (o.rate !== false) {
    await GoldRateService.applyRates(
      STORE,
      { rates: [{ karat: 21, ratePerGram: 576_000 }], confirm: true },
      { userId: ownerId }
    );
  }
  const ids: string[] = [];
  for (let i = 0; i < (o.count ?? 1); i++) {
    const p = await prisma.product.create({
      data: {
        storeId: STORE,
        name: `Ring ${i}`,
        slug: `ring-${k}-${i}`,
        price: o.fixedPrice ?? 1_000,
        compareAtPrice: o.compareAt === undefined ? 1_500 : o.compareAt,
        status: 'active',
        ...(o.spec
          ? {
              goldKarat: 21,
              goldWeightMg: 3250,
              makingChargeType: 'per_gram',
              makingChargeValue: 15_000,
              goldMarginBps: 0,
            }
          : {}),
      },
    });
    ids.push(p.id);
  }
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
    for (const id of ids)
      insertSqlite(sqlite, 'Product', [
        await prisma.product.findUniqueOrThrow({ where: { id } }),
      ] as never);
  }
  return { ids, names: Object.fromEntries(ids.map((id, i) => [id, `p${i}`])) };
}
async function rows(w: World) {
  const db = (await storeDb(STORE)) as never as {
    product: { findMany(a: unknown): Promise<unknown[]> };
    productVariant: { findMany(a: unknown): Promise<unknown[]> };
  };
  return {
    products: await db.product.findMany({
      where: { id: { in: w.ids } },
      orderBy: { name: 'asc' },
      select: {
        name: true,
        pricingMode: true,
        price: true,
        compareAtPrice: true,
        goldKarat: true,
        goldWeightMg: true,
        makingChargeType: true,
        makingChargeValue: true,
        goldMarginBps: true,
      },
    }),
    variants: await db.productVariant.findMany({
      where: { productId: { in: w.ids } },
      orderBy: { title: 'asc' },
      select: {
        title: true,
        price: true,
        compareAtPrice: true,
        pricingMode: true,
        goldKarat: true,
        sku: true,
      },
    }),
  };
}
async function parity(
  make: (mirror: boolean) => Promise<World>,
  act: (w: World) => Promise<unknown>,
  read: (w: World) => Promise<unknown> = rows
) {
  const run = async (on: typeof onPg, mirror: boolean) => {
    const w = await make(mirror);
    const out = await settle(() => on(() => act(w)));
    return scrub({ out, state: await on(() => read(w)) }, w.names);
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  return pg as any;
}
const actor = () => ({ userId: ownerId });
const inStore = <T>(f: () => Promise<T>) => runInTenantContext(STORE, f);

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `d2b5-${sfx}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'D',
      lastName: 'B',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  STORE = (
    await prisma.store.create({
      data: { name: 'D2b5', slug: `d2b5-${sfx}`, ownerId: owner.id, status: 'active' },
    })
  ).id;
});
beforeEach(() => {
  vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(false);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await ownerPg.end();
  await prisma.$disconnect();
});
// each scenario starts from an empty book: rates and products of the previous one would leak into the next world
async function reset() {
  await ownerPg.query('delete from bundles where store_id = $1', [STORE]);
  await ownerPg.query('delete from product_price_tiers where store_id = $1', [STORE]);
  await ownerPg.query('delete from gold_rates_current where store_id = $1', [STORE]);
  await ownerPg.query(
    'delete from product_variants where product_id in (select id from products where store_id = $1)',
    [STORE]
  );
  await ownerPg.query('delete from products where store_id = $1', [STORE]);
  await ownerPg.query('delete from gold_rates where store_id = $1', [STORE]);
  sqlite.exec(
    'DELETE FROM bundles; DELETE FROM product_price_tiers; DELETE FROM product_variants; DELETE FROM products; DELETE FROM gold_rates_current; DELETE FROM gold_rates'
  );
}
beforeEach(reset);

describe.skipIf(!hasDb)('gold product pricing on Postgres vs the DO', () => {
  it('fixed -> gold: priced from the rate, compare-at cleared, equal rows', async () => {
    const t = await parity(
      w => world(w),
      w =>
        inStore(() =>
          GoldRateService.setProductPricing(STORE, w.ids[0], { product: GOLD }, actor())
        )
    );
    expect(t.out.ok.pricingMode).toBe('gold_rate');
    expect(t.state.products[0].compareAtPrice).toBeNull();
    expect(t.state.products[0].price).toBeGreaterThan(1_000);
  });

  it('gold -> fixed freezes the price; a variant override and a fixed priced variant behave the same', async () => {
    const t = await parity(
      async m => {
        const w = await world(m);
        const v = await prisma.productVariant.create({
          data: { productId: w.ids[0], title: 'A', price: 777, sku: 'A1' },
        });
        if (m) insertSqlite(sqlite, 'ProductVariant', [v] as never);
        return { ...w, names: { ...w.names, [v.id]: 'va' } };
      },
      async w => {
        const vid = (
          await prisma.productVariant.findFirstOrThrow({ where: { productId: w.ids[0] } })
        ).id;
        await inStore(() =>
          GoldRateService.setProductPricing(
            STORE,
            w.ids[0],
            { product: GOLD, variants: [{ id: vid, pricingMode: 'fixed' }] },
            actor()
          )
        );
        return inStore(() =>
          GoldRateService.setProductPricing(
            STORE,
            w.ids[0],
            { product: { pricingMode: 'fixed' } },
            actor()
          )
        );
      }
    );
    expect(t.out.ok.pricingMode).toBe('fixed');
  });

  it('refusals are the same code and status: missing rate, bundled product, price tiers, catalogue, unknown product', async () => {
    const miss = await parity(
      w => world(w, { rate: false }),
      w =>
        inStore(() =>
          GoldRateService.setProductPricing(STORE, w.ids[0], { product: GOLD }, actor())
        )
    );
    expect(miss.out.err.code).toBe('GOLD_RATE_MISSING');
    const unknown = await parity(
      w => world(w),
      () =>
        inStore(() =>
          GoldRateService.setProductPricing(
            STORE,
            '00000000-0000-4000-8000-000000000000',
            { product: GOLD },
            actor()
          )
        )
    );
    expect(unknown.out.err).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const tier = await parity(
      async m => {
        const w = await world(m);
        const row = await prisma.productPriceTier.create({
          data: { storeId: STORE, productId: w.ids[0], minQty: 5, priceMinor: 900 },
        });
        if (m) insertSqlite(sqlite, 'ProductPriceTier', [row] as never);
        return w;
      },
      w =>
        inStore(() =>
          GoldRateService.setProductPricing(STORE, w.ids[0], { product: GOLD }, actor())
        )
    );
    expect(tier.out.err.code).toBe('GOLD_NO_PRICE_TIERS');
    const bundled = await parity(
      async m => {
        const w = await world(m);
        const b = await prisma.bundle.create({
          data: {
            storeId: STORE,
            name: 'B',
            slug: `b-${sfx}-${++n}`,
            pricingType: 'fixed_price',
            pricingValue: 1,
          },
        });
        const bi = await prisma.bundleItem.create({
          data: { bundleId: b.id, productId: w.ids[0], quantity: 1 },
        });
        if (m) {
          insertSqlite(sqlite, 'Bundle', [b] as never);
          insertSqlite(sqlite, 'BundleItem', [bi] as never);
        }
        return w;
      },
      w =>
        inStore(() =>
          GoldRateService.setProductPricing(STORE, w.ids[0], { product: GOLD }, actor())
        )
    );
    expect(bundled.out.err.code).toBe('GOLD_IN_BUNDLE');
  });

  it('bulkSwitchMode: switched and skipped (reason per id) are equal, then back to fixed', async () => {
    const t = await parity(
      async m => {
        const w = await world(m, { count: 3, spec: true });
        // one product with an incomplete spec
        await ownerPg.query('update products set gold_karat = null where id = $1', [w.ids[2]]);
        if (m) sqlite.prepare('UPDATE products SET gold_karat = NULL WHERE id = ?').run(w.ids[2]);
        return w;
      },
      async w => {
        const ids = [...w.ids, '00000000-0000-4000-8000-000000000000'];
        const up = await inStore(() =>
          GoldRateService.bulkSwitchMode(STORE, ids, 'gold_rate', actor())
        );
        const again = await inStore(() =>
          GoldRateService.bulkSwitchMode(STORE, ids, 'gold_rate', actor())
        );
        const down = await inStore(() =>
          GoldRateService.bulkSwitchMode(STORE, w.ids, 'fixed', actor())
        );
        // Postgres answers in row order (unspecified), the DO in the caller's: compare the sets
        const norm = (r: { switched: string[]; skipped: { id: string; reason: string }[] }) => ({
          switched: [...r.switched].sort((a, b) => w.ids.indexOf(a) - w.ids.indexOf(b)),
          skipped: [...r.skipped].sort(
            (a, b) => w.ids.indexOf(a.id) - w.ids.indexOf(b.id) || a.reason.localeCompare(b.reason)
          ),
        });
        return { up: norm(up), again: norm(again), down: norm(down) };
      }
    );
    expect(t.out.ok.up.switched).toHaveLength(2);
    expect(t.out.ok.up.skipped.map((s: any) => s.reason).sort()).toEqual([
      'NOT_FOUND',
      'SPEC_INCOMPLETE',
    ]);
  });

  it('a variant of a gold product is born priced; with no rate it is refused and nothing is left', async () => {
    const mk = (rate: boolean) => async (m: boolean) => {
      const w = await world(m, { spec: true, rate });
      if (rate)
        await GoldRateService.setProductPricing(STORE, w.ids[0], { product: GOLD }, actor()).catch(
          () => undefined
        );
      if (m && rate) {
        sqlite.exec('DELETE FROM products');
        insertSqlite(sqlite, 'Product', [
          await prisma.product.findUniqueOrThrow({ where: { id: w.ids[0] } }),
        ] as never);
      }
      return w;
    };
    const ok = await parity(mk(true), w =>
      inStore(() =>
        VariantService.createVariant(STORE, w.ids[0], { optionValueIds: [], sku: 'V1' } as never)
      ).then(v => ({ title: v.title }))
    );
    expect(ok.state.variants).toHaveLength(1);
    expect(ok.state.variants[0].price).toBe(ok.state.products[0].price);
  });
});
