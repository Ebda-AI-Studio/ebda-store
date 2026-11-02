import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 R3 (Ruling IMPORT-DO-1): the CSV import batch on real workerd. The Postgres interactive transaction (and its
// unique (store, sku) index) is the DO's single thread plus one section: a failing row rolls the WHOLE batch back, and two
// imports of one new SKU racing each other leave exactly one product.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer =
  | { ok: true; json: string }
  | { ok: false; code: string; status: number; message?: string };
const op = async (stub: ReturnType<typeof stubFor>, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const num = (stub: ReturnType<typeof stubFor>, sql: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql).one().n as number);
const codes = (a: Answer[]) =>
  a.reduce<Record<string, number>>((m, x) => {
    const k = x.ok ? 'ok' : x.code;
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

const row = (rowIndex: number, sku: string, over: Record<string, unknown> = {}) => ({
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
  imageUrls: ['https://example.com/a.jpg'],
  variants: [
    { sku: `${sku}-S`, price: 1000, inventory: 2, option1Name: 'Size', option1Value: 'S' },
    { sku: `${sku}-M`, price: 1100, inventory: 3, option1Name: 'Size', option1Value: 'M' },
  ],
  ...over,
});
const batch = (stub: ReturnType<typeof stubFor>, store: string, rows: unknown[]) =>
  op(stub, store, 'importBatch', { rows, aiFields: ['name', 'description'], userId: 'u1' });
async function bound(store: string) {
  const stub = stubFor(store);
  await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store
  return stub;
}

describe('CSV import batches on the store DO', () => {
  it('a failing row rolls the whole batch back: no product, no stock history, no variant, no image', async () => {
    const store = 'imp-rollback';
    const stub = await bound(store);
    const a = await batch(stub, store, [row(2, 'A'), row(3, 'B'), row(4, 'A')]); // row 4 repeats sku A
    expect(a).toMatchObject({ ok: false, code: 'IMPORT_ROW_FAILED' });
    expect((a as { message: string }).message).toMatch(/^row 4: /);
    for (const t of [
      'products',
      'inventory_history',
      'product_variants',
      'product_images',
      'product_options',
    ])
      expect(await num(stub, `SELECT COUNT(*) n FROM ${t}`)).toBe(0);
  });

  it('20 concurrent imports of one new SKU: one product, one history row, its two variants; 19 refused whole', async () => {
    const store = 'imp-race';
    const stub = await bound(store);
    const r = await Promise.all(
      Array.from({ length: 20 }, () => batch(stub, store, [row(2, 'X')]))
    );
    expect(codes(r)).toEqual({ ok: 1, IMPORT_ROW_FAILED: 19 });
    expect(await num(stub, 'SELECT COUNT(*) n FROM products')).toBe(1);
    expect(await num(stub, 'SELECT COUNT(*) n FROM inventory_history')).toBe(1);
    expect(await num(stub, 'SELECT COUNT(*) n FROM product_variants')).toBe(2);
    expect(await num(stub, 'SELECT has_variants n FROM products')).toBe(1);
  });

  it('re-importing replaces the variants, keeps a swatch, and records the slug rename for the Worker', async () => {
    const store = 'imp-update';
    const stub = await bound(store);
    const first = await batch(stub, store, [row(2, 'Y')]);
    expect(first.ok).toBe(true);
    const { products } = decodeRpc<any>((first as { json: string }).json);
    await runInDurableObject(stub, (_i, s) =>
      s.storage.sql.exec(
        "UPDATE product_option_values SET swatch_hex = '#ffffff' WHERE value = 'S'"
      )
    );
    const again = await batch(stub, store, [
      row(2, 'Y', {
        existingId: products[0].productId,
        existingSlug: 'slug-Y',
        slug: 'renamed',
        fields: {
          name: 'Y2',
          slug: 'renamed',
          price: 1200,
          sku: 'Y',
          inventory: 9,
          status: 'active',
          trackInventory: true,
        },
        imported: { name: 'Y2' },
        imageUrls: null,
      }),
    ]);
    const out = decodeRpc<any>((again as { json: string }).json);
    expect(out).toMatchObject({
      created: 0,
      updated: 1,
      variantsCreated: 2,
      renames: [{ from: 'slug-Y', to: 'renamed' }],
    });
    expect(await num(stub, 'SELECT COUNT(*) n FROM product_variants')).toBe(2); // replaced, not doubled
    expect(
      await num(stub, "SELECT COUNT(*) n FROM product_option_values WHERE swatch_hex = '#ffffff'")
    ).toBe(1);
    expect(await num(stub, 'SELECT COUNT(*) n FROM product_images')).toBe(1); // blank cell leaves the images alone
    expect(await num(stub, "SELECT inventory n FROM products WHERE sku = 'Y'")).toBe(9);
  });
});
