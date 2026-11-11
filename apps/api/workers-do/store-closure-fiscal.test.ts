import { beforeAll, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';
import type { MerchantSubject } from '../src/cf/erasure';
import { ensurePlatformIndex } from './platform-index';

// S3-M5 (ruling MONEYB-4, NZ-D15/D16/D17): deleting a store never erases its tax records. For a store on its Durable Object the
// deletion is: money gate + CLOSE (nothing is wiped), then PDPL anonymisation that KEEPS fiscal rows. The records are exercised on
// real workerd: issued receipts survive a refused close, a successful close, a merchant erasure and a direct DELETE attempt.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
beforeAll(ensurePlatformIndex);
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Stub = ReturnType<typeof stubFor>;
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (stub: Stub, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const val = (a: Answer) => {
  if (!a.ok) throw new Error(`refused ${a.code}`);
  return decodeRpc<any>(a.json);
};
const rows = <T>(stub: Stub, q: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(q).toArray() as T[]);
const fiscal = (stub: Stub) =>
  rows<Record<string, unknown>>(
    stub,
    `SELECT id, order_id, doc_type, serial, number, status, total_amount, vat_amount, retain_until FROM fiscal_documents ORDER BY serial`
  );

async function store(id: string) {
  const stub = stubFor(id);
  await op(stub, id, 'cancel', { orderId: 'nope' });
  await runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec(
      `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'Shop', ?, 'owner')`,
      id,
      id
    );
    s.storage.sql.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', ?, 'Widget', 'widget', 1000, 50, 'active')`,
      id
    );
  });
  const orders: string[] = [];
  // a distinct phone per order: the open-order hold cap is per buyer
  for (let i = 0; i < 3; i++)
    orders.push(
      val(
        await op(stub, id, 'createOrder', {
          lines: [{ productId: 'p1', quantity: 1 }],
          shippingAddress: { name: 'Mona Adel', phone: `0100000000${i + 1}` },
        })
      ).orderId
    );
  return { stub, orders };
}
const settle = (stub: Stub, ids: string[]) =>
  runInDurableObject(stub, (_i, s) => {
    for (const id of ids)
      s.storage.sql.exec(
        `UPDATE orders SET status = 'delivered', payment_status = 'paid' WHERE id = ?`,
        id
      );
  });
const merchant = (id: string): MerchantSubject => ({
  kind: 'merchant',
  requestId: `req-${id}`,
  storeId: id,
  ownerUserId: 'owner',
});

describe('S3-M5: a store deletion keeps its tax records', () => {
  it('a store with a paid, undelivered order is REFUSED the close (409 counts) and nothing changes', async () => {
    const { stub, orders } = await store('mv-del-refused');
    await runInDurableObject(stub, (_i, s) =>
      s.storage.sql.exec(
        `UPDATE orders SET payment_status = 'paid', status = 'confirmed' WHERE id = ?`,
        orders[0]
      )
    );
    const before = await fiscal(stub);
    expect(before.length).toBe(3);
    const r = (await stub.closeIfNoMoneyInFlight('mv-del-refused')) as {
      ok: true;
      data: { refused?: true; counts?: { paidUndelivered: number } };
    };
    expect(r.data.refused).toBe(true);
    expect(r.data.counts!.paidUndelivered).toBe(1);
    expect((await rows(stub, `SELECT * FROM do_flags WHERE name LIKE 'closed%'`)).length).toBe(0);
    expect(await fiscal(stub)).toEqual(before);
  });

  it('once settled, the close succeeds, writes are refused 410 STORE_CLOSED, and every issued document is byte-for-byte kept', async () => {
    const { stub, orders } = await store('mv-del-closed');
    await settle(stub, orders);
    const before = await fiscal(stub);
    const r = (await stub.closeIfNoMoneyInFlight('mv-del-closed')) as {
      ok: true;
      data: { closed?: true; token: string | null };
    };
    expect(r.data.closed).toBe(true);
    expect(
      await op(stub, 'mv-del-closed', 'createOrder', {
        lines: [{ productId: 'p1', quantity: 1 }],
        shippingAddress: {},
      })
    ).toMatchObject({
      ok: false,
      code: 'STORE_CLOSED',
    });
    expect(await fiscal(stub)).toEqual(before);
    expect((await rows<{ n: number }>(stub, `SELECT count(*) AS n FROM orders`))[0]!.n).toBe(3); // the orders the documents describe are not wiped either
  });

  it('merchant erasure after the close anonymises the buyer but keeps the fiscal documents and their retention date', async () => {
    const { stub, orders } = await store('mv-del-erase');
    await settle(stub, orders);
    const before = await fiscal(stub);
    await stub.closeIfNoMoneyInFlight('mv-del-erase');
    const r = await stub.eraseSubject(merchant('mv-del-erase'));
    expect(r.refused).toBeUndefined();
    expect(r.remaining).toBe(0);
    expect(await fiscal(stub)).toEqual(before);
    for (const d of before)
      expect(Number(d.retain_until)).toBeGreaterThan(Date.now() + 5 * 365 * 86_400_000);
    // the receipt payload names no buyer (PDPL minimisation: a plain receipt carries no buyer data)
    const payloads = await rows<{ payload: string }>(stub, `SELECT payload FROM fiscal_documents`);
    for (const p of payloads) expect(p.payload).not.toMatch(/Mona|01000000001/);
  });

  it('a fiscal document cannot be deleted before its retention date, even by a direct DELETE (the DB refuses)', async () => {
    const { stub } = await store('mv-del-trigger');
    await expect(
      runInDurableObject(stub, (_i, s) => s.storage.sql.exec(`DELETE FROM fiscal_documents`))
    ).rejects.toThrow();
    expect((await fiscal(stub)).length).toBe(3);
  });

  it('a failed delete reopens the store only with its own closure token (compensating rollback)', async () => {
    const { stub, orders } = await store('mv-del-reopen');
    await settle(stub, orders);
    const r = (await stub.closeIfNoMoneyInFlight('mv-del-reopen')) as {
      ok: true;
      data: { token: string };
    };
    expect(await stub.reopenAfterFailedDelete('mv-del-reopen', 'not-my-token')).toMatchObject({
      ok: true,
      data: { reopened: false },
    });
    expect(await stub.reopenAfterFailedDelete('mv-del-reopen', r.data.token)).toMatchObject({
      ok: true,
      data: { reopened: true },
    });
    expect((await fiscal(stub)).length).toBe(3);
  });
});
