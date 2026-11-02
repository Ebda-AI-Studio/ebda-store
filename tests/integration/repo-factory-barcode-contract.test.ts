/**
 * INFRA-CF-1 final integration (Ruling BARCODE-DO-1): in-store barcode allocation (`generateMissingBarcodes`, `ensureBarcode`,
 * `fillMissingAfterImport`, `assertBarcodeAvailable`) on the StoreDO gives the same codes and leaves the same rows as the
 * Postgres twin. Each scenario runs the real service once on Postgres (unchanged code) and once with the DO money client over the
 * real DO schema on SQLite; the traces must be equal.
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
import { featureService } from '../../apps/api/src/services/feature.service';
import {
  assertBarcodeAvailable,
  ensureBarcode,
  fillMissingAfterImport,
  generateMissingBarcodes,
} from '../../apps/api/src/services/barcode.service';

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
const settleErr = settle;
/** Products and variants of the store: a few with codes (one in the in-store range), a deleted one, a variant parent, mirrored. */
async function world(mirror: boolean) {
  const k = `${sfx}${++n}`;
  const mk = (sku: string, o: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: {
        storeId: STORE,
        name: sku,
        slug: `${sku.toLowerCase()}-${k}`,
        sku: `${sku}-${k}`,
        price: 1_000,
        status: 'active',
        ...o,
      },
    });
  const a = await mk('A');
  const b = await mk('B', { barcode: '2000000000411' }); // already in the in-store range: allocation continues after it
  const c = await mk('C', { deletedAt: new Date() });
  const parent = await mk('P', { hasVariants: true });
  const v1 = await prisma.productVariant.create({
    data: { productId: parent.id, title: 'S', sku: `PS-${k}`, price: 1_000, inventory: 0 },
  });
  const v2 = await prisma.productVariant.create({
    data: { productId: parent.id, title: 'M', sku: `PM-${k}`, price: 1_000, inventory: 0 },
  });
  if (mirror) {
    insertSqlite(sqlite, 'Product', [a, b, c, parent] as never);
    insertSqlite(sqlite, 'ProductVariant', [v1, v2] as never);
  }
  return { k, a: a.id, b: b.id, parent: parent.id, v1: v1.id, v2: v2.id };
}
type W = Awaited<ReturnType<typeof world>>;

async function state(w: W) {
  const db = (await storeDb(STORE)) as any;
  const products = await db.product.findMany({
    where: { storeId: STORE, sku: { endsWith: w.k } },
    select: { sku: true, barcode: true },
    orderBy: { sku: 'asc' },
  });
  const variants = await db.productVariant.findMany({
    where: { productId: w.parent },
    select: { sku: true, barcode: true },
    orderBy: { sku: 'asc' },
  });
  return { products, variants };
}

async function parity(act: (w: W) => Promise<unknown>) {
  const run = async (on: typeof onPg, mirror: boolean) => {
    const w = await world(mirror);
    const out = await settleErr(() => on(() => act(w)));
    return scrub({ out, state: await on(() => state(w)) }, {}, w.k);
  };
  // each world starts from an empty book: the previous one's in-store codes would move the next serial
  const reset = async () => {
    await prisma.productVariant.deleteMany({ where: { product: { storeId: STORE } } });
    await prisma.product.deleteMany({ where: { storeId: STORE } });
    sqlite.exec('DELETE FROM product_variants; DELETE FROM products');
  };
  await reset();
  const pg = await run(onPg, false);
  await reset();
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  return pg as any;
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `bc-${sfx}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'B',
      lastName: 'C',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  STORE = (
    await prisma.store.create({
      data: {
        name: 'BcDo',
        slug: `bcdo-${sfx}`,
        ownerId: owner.id,
        status: 'active',
        plan: 'enterprise',
      },
    })
  ).id;
});
beforeEach(() => {
  vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(true);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)('in-store barcodes on Postgres vs the DO', () => {
  it('generateMissingBarcodes fills live products without variants and every variant, after the highest code, never a deleted item', async () => {
    const t = await parity(() => generateMissingBarcodes(STORE));
    expect(t.out.ok).toMatchObject({ products: 1, variants: 2, remaining: 0 });
    const codes = [...t.state.products, ...t.state.variants]
      .map((r: any) => r.barcode)
      .filter(Boolean);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c: string) => /^20\d{11}$/.test(c))).toBe(true);
    expect(t.state.products.find((p: any) => p.sku.startsWith('C'))?.barcode).toBeNull(); // the deleted one
  });

  it('a limit leaves the rest as remaining; a second call finishes; a third finds nothing', async () => {
    const t = await parity(async () => {
      const first = await generateMissingBarcodes(STORE, 2);
      const second = await generateMissingBarcodes(STORE, 2);
      const third = await generateMissingBarcodes(STORE, 2);
      return { first, second, third };
    });
    expect(t.out.ok.first).toMatchObject({ products: 1, variants: 1, remaining: 1 });
    expect(t.out.ok.second).toMatchObject({ products: 0, variants: 1, remaining: 0 });
    expect(t.out.ok.third).toMatchObject({ products: 0, variants: 0, remaining: 0 });
  });

  it('ensureBarcode gives one fresh code to a product or variant with none, and nothing to one that has it', async () => {
    const t = await parity(async w => ({
      product: await ensureBarcode(STORE, { productId: w.a }),
      productAgain: await ensureBarcode(STORE, { productId: w.a }),
      withCode: await ensureBarcode(STORE, { productId: w.b }),
      variant: await ensureBarcode(STORE, { variantId: w.v1 }),
    }));
    expect(t.out.ok.product).toMatch(/^20\d{11}$/);
    expect(t.out.ok.productAgain).toBeNull();
    expect(t.out.ok.withCode).toBeNull();
    expect(t.out.ok.variant).toMatch(/^20\d{11}$/);
  });

  it('fillMissingAfterImport fills everything in one pass when the store has the barcode feature', async () => {
    const t = await parity(async () => fillMissingAfterImport(STORE));
    expect(
      [...t.state.products, ...t.state.variants]
        .filter((r: any) => !r.barcode)
        .map((r: any) => r.sku)
    ).toEqual(['C-<k>', 'P-<k>']);
  });

  it('assertBarcodeAvailable refuses a code another live item holds, either spelling, and lets the holder keep it', async () => {
    const t = await parity(async w => {
      const taken = await settleErr(() => assertBarcodeAvailable(STORE, '2000000000411'));
      const upc = await settleErr(() => assertBarcodeAvailable(STORE, '200000000041'));
      const own = await settleErr(() =>
        assertBarcodeAvailable(STORE, '2000000000411', { productId: w.b })
      );
      const free = await settleErr(() => assertBarcodeAvailable(STORE, '2000000000428'));
      return { taken, upc, own, free };
    });
    expect(t.out.ok.taken.err.code).toBe('BARCODE_IN_USE');
    expect(t.out.ok.own.ok).toBeUndefined();
    expect(t.out.ok.free.ok).toBeUndefined();
  });
});
