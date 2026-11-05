import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 final integration (Ruling BARCODE-DO-1): in-store barcode allocation on real workerd. The Postgres twin takes an
// advisory lock so two requests are never handed the same code; here the DO's single thread plus one section must give the
// same guarantee: any number of concurrent fills / ensures hand out each code to exactly one item.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer =
  | { ok: true; json: string }
  | { ok: false; code: string; status: number; message?: string };
const op = async (stub: ReturnType<typeof stubFor>, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const rows = <T>(stub: ReturnType<typeof stubFor>, sql: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql).toArray() as T[]);
const out = <T>(a: Answer) => decodeRpc<T>((a as { json: string }).json);

const product = (rowIndex: number, sku: string) => ({
  rowIndex,
  existingId: null,
  existingSlug: null,
  slug: `slug-${sku}`,
  fields: {
    name: sku,
    slug: `slug-${sku}`,
    price: 1000,
    sku,
    inventory: 5,
    status: 'active',
    trackInventory: true,
  },
  imported: { name: sku },
  categoryIds: null,
  tagIds: null,
  imageUrls: null,
  variants: [],
});
async function seeded(store: string, n: number) {
  const stub = stubFor(store);
  await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store
  const r = await op(stub, store, 'importBatch', {
    rows: Array.from({ length: n }, (_, i) => product(i + 2, `S${i}`)),
    aiFields: ['name'],
    userId: 'u1',
  });
  expect(r).toMatchObject({ ok: true });
  return stub;
}
const held = (stub: ReturnType<typeof stubFor>) =>
  rows<{ barcode: string }>(stub, 'SELECT barcode FROM products WHERE barcode IS NOT NULL');

describe('in-store barcodes on the store DO', () => {
  it('30 concurrent fills of 40 barcode-less products: every product gets exactly one distinct in-store code', async () => {
    const store = 'bc-fill-race';
    const stub = await seeded(store, 40);
    const r = await Promise.all(
      Array.from({ length: 30 }, () => op(stub, store, 'barcodeFill', { limit: 7 }))
    );
    expect(r.filter(a => !a.ok)).toEqual([]);
    const total = r.reduce((s, a) => s + out<{ products: number }>(a).products, 0);
    expect(total).toBe(40);
    const codes = (await held(stub)).map(x => x.barcode);
    expect(codes).toHaveLength(40);
    expect(new Set(codes).size).toBe(40);
    expect(codes.every(c => /^20\d{11}$/.test(c))).toBe(true);
  });

  it('25 concurrent ensures for 25 products never hand one code to two items; a second ensure of the same item returns null', async () => {
    const store = 'bc-ensure-race';
    const stub = await seeded(store, 25);
    const ids = (await rows<{ id: string }>(stub, 'SELECT id FROM products')).map(x => x.id);
    const r = await Promise.all(
      ids.map(productId => op(stub, store, 'barcodeEnsure', { productId }))
    );
    const got = r.map(a => out<{ code: string | null }>(a).code);
    expect(got.every(Boolean)).toBe(true);
    expect(new Set(got).size).toBe(25);
    const again = await Promise.all(
      ids.map(productId => op(stub, store, 'barcodeEnsure', { productId }))
    );
    expect(again.map(a => out<{ code: string | null }>(a).code)).toEqual(Array(25).fill(null));
    expect(await held(stub)).toHaveLength(25);
  });

  it('a fill and ensures racing each other still give distinct codes', async () => {
    const store = 'bc-mixed-race';
    const stub = await seeded(store, 20);
    const ids = (await rows<{ id: string }>(stub, 'SELECT id FROM products LIMIT 10')).map(
      x => x.id
    );
    await Promise.all([
      ...ids.map(productId => op(stub, store, 'barcodeEnsure', { productId })),
      op(stub, store, 'barcodeFill', { limit: 500 }),
      op(stub, store, 'barcodeFill', { limit: 500 }),
    ]);
    const codes = (await held(stub)).map(x => x.barcode);
    expect(codes).toHaveLength(20);
    expect(new Set(codes).size).toBe(20);
  });
});
