import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 R6a (Ruling CF-R6A-1): the admin palette's product and customer lookups on real workerd, with no Postgres. The DO
// keeps its search index fresh with dirty-marking triggers and flushes it at the start of every search, so a search made after a
// write committed must see that row however many writes and searches interleave, and a store must never see another's.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer =
  | { ok: true; json: string }
  | { ok: false; code: string; status: number; message?: string };
const op = async (stub: ReturnType<typeof stubFor>, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const out = <T>(a: Answer) => decodeRpc<T>((a as { json: string }).json);
const exec = (stub: ReturnType<typeof stubFor>, sql: string, ...b: unknown[]) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql, ...b).toArray());

const product = (rowIndex: number, name: string, nameAr: string, sku: string) => ({
  rowIndex,
  existingId: null,
  existingSlug: null,
  slug: `slug-${sku}`,
  fields: {
    name,
    nameAr,
    slug: `slug-${sku}`,
    price: 1000,
    sku,
    inventory: 5,
    status: 'active',
    trackInventory: true,
  },
  imported: { name },
  categoryIds: null,
  tagIds: null,
  imageUrls: null,
  variants: [],
});
const importOne = (
  stub: ReturnType<typeof stubFor>,
  store: string,
  p: ReturnType<typeof product>
) => op(stub, store, 'importBatch', { rows: [p], aiFields: ['name'], userId: 'u1' });
type Ids = { ids: string[]; truncated: boolean };
const find = (stub: ReturnType<typeof stubFor>, store: string, raw: string, scope = 'admin') =>
  op(stub, store, 'searchProducts', { raw, opts: { scope, field: 'name', limit: 5 } });

describe('palette search on the store DO', () => {
  it('product search folds Arabic spellings and matches the SKU', async () => {
    const store = 'ps-fold';
    const stub = stubFor(store);
    await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store
    await importOne(stub, store, product(2, 'Running Shoe', 'أحذية رياضية', 'SHOE-1'));
    await importOne(stub, store, product(3, 'Leather Belt', 'حزام جلد', 'BELT-2'));
    expect(out<Ids>(await find(stub, store, 'احذيه')).ids).toHaveLength(1);
    expect(out<Ids>(await find(stub, store, 'BELT-2')).ids).toHaveLength(1);
    expect(out<Ids>(await find(stub, store, 'zzzz')).ids).toEqual([]);
    expect(out<Ids>(await find(stub, store, '')).ids).toEqual([]);
  });

  it('40 writers racing 40 searchers: every search made after its write committed finds the row', async () => {
    const store = 'ps-race';
    const stub = stubFor(store);
    await op(stub, store, 'cancel', { orderId: 'nope' });
    const r = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const token = `zork${String(i).padStart(3, '0')}x`;
        const w = await importOne(stub, store, product(i + 2, `Gadget ${token}`, 'جهاز', `G-${i}`));
        const s = await find(stub, store, token);
        return { w, found: s.ok ? out<Ids>(s).ids.length : -1 };
      })
    );
    expect(r.filter(x => !x.w.ok)).toEqual([]);
    expect(r.map(x => x.found)).toEqual(Array(40).fill(1));
  });

  it('customer matching: any phone form, folded name, e-mail and guest contact; another store sees none of it', async () => {
    const store = 'ps-cust';
    const other = 'ps-cust-other';
    const stub = stubFor(store);
    await op(stub, store, 'cancel', { orderId: 'nope' });
    await exec(
      stub,
      "INSERT INTO customers (id, store_id, first_name, last_name, phone, email, created_at, updated_at) VALUES ('c1', ?, 'أحمد', 'علي', '+201012345678', 'a@x.test', 1, 1)",
      store
    );
    await exec(
      stub,
      "INSERT INTO orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address, created_at, updated_at) VALUES ('g1', ?, 'EB-1', 1, 1, ?, '{}', 1, 1)",
      store,
      JSON.stringify({
        firstName: 'منى',
        lastName: 'سالم',
        phone: '0112 345 6789',
        email: 'Mona@X.test',
      })
    );
    type M = { userIds: string[]; guestOrderIds: string[] };
    const m = async (q: string) => out<M>(await op(stub, store, 'searchCustomers', { q }));
    for (const q of ['0101 234 5678', '+201012345678', '٠١٠١٢٣٤٥٦٧٨', 'احمد', 'a@x.test'])
      expect((await m(q)).userIds, q).toEqual(['c1']);
    for (const q of ['01123456789', 'منى', 'mona@x.test'])
      expect((await m(q)).guestOrderIds, q).toEqual(['g1']);
    const o = stubFor(other);
    await op(o, other, 'cancel', { orderId: 'nope' });
    expect(out<M>(await op(o, other, 'searchCustomers', { q: 'احمد' }))).toMatchObject({
      userIds: [],
      guestOrderIds: [],
    });
  });
});
