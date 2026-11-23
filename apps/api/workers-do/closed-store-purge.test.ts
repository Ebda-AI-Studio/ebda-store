import { beforeAll, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { ensurePlatformIndex } from './platform-index';

// Ruling NZ-D15B (plan N-24): the Durable Object side of the closed-store purge, on real workerd. The DO wipes only a CLOSED store whose
// fiscal row count still equals the verified export; everything else is refused and nothing is touched.
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

describe('NZ-D15B: closed-store fiscal export + wipe', () => {
  it('an OPEN store is neither exported nor wiped (409 STORE_NOT_CLOSED), nothing changes', async () => {
    const { stub } = await store('cp-open');
    expect(await stub.closedFiscalPage('cp-open', 0, 100)).toMatchObject({
      ok: false,
      code: 'STORE_NOT_CLOSED',
      status: 409,
    });
    expect(await stub.purgeClosedStore('cp-open', { fiscalDocuments: 3 })).toMatchObject({
      ok: false,
      code: 'STORE_NOT_CLOSED',
    });
    expect((await fiscal(stub)).length).toBe(3);
  });

  it('a closed store is exported in serial pages that add up to every document, with the count and last issue date', async () => {
    const { stub, orders } = await store('cp-export');
    await settle(stub, orders);
    await stub.closeIfNoMoneyInFlight('cp-export');
    const all: Array<Record<string, unknown>> = [];
    let after = 0;
    for (;;) {
      const page = (await stub.closedFiscalPage('cp-export', after, 2)) as {
        ok: true;
        data: { rows: Array<Record<string, unknown>>; count: number; lastIssuedAt: number | null };
      };
      expect(page.data.count).toBe(3);
      expect(page.data.lastIssuedAt).toBeGreaterThan(0);
      if (!page.data.rows.length) break;
      all.push(...page.data.rows);
      after = Number(page.data.rows.at(-1)!.serial);
    }
    expect(all.map(r => r.id)).toEqual((await fiscal(stub)).map(r => r.id));
  });

  it('refuses the wipe when the export is stale (row count differs): the store and its tax records stay', async () => {
    const { stub, orders } = await store('cp-stale');
    await settle(stub, orders);
    await stub.closeIfNoMoneyInFlight('cp-stale');
    expect(await stub.purgeClosedStore('cp-stale', { fiscalDocuments: 2 })).toMatchObject({
      ok: false,
      code: 'PURGE_EXPORT_STALE',
      status: 409,
    });
    expect((await fiscal(stub)).length).toBe(3);
  });

  it('wipes a closed store whose count equals the verified export: every table is gone, even the fiscal rows a SQL DELETE refuses', async () => {
    const { stub, orders } = await store('cp-wipe');
    await settle(stub, orders);
    await stub.closeIfNoMoneyInFlight('cp-wipe');
    expect(await stub.purgeClosedStore('cp-wipe', { fiscalDocuments: 3 })).toEqual({
      ok: true,
      data: { wiped: true },
    });
    const tables = await rows<{ name: string }>(
      stub,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`
    );
    expect(tables).toEqual([]);
  });

  it('resume after a crash mid-wipe: an already-empty DO counts as wiped, an OPEN store never does', async () => {
    const wiped = await store('cp-resume');
    await settle(wiped.stub, wiped.orders);
    await wiped.stub.closeIfNoMoneyInFlight('cp-resume');
    await wiped.stub.purgeClosedStore('cp-resume', { fiscalDocuments: 3 });
    // the second call is the re-run after the crash: no store profile, no fiscal row left
    expect(
      await wiped.stub.purgeClosedStore('cp-resume', { fiscalDocuments: 3, resume: true })
    ).toEqual({
      ok: true,
      data: { wiped: true, alreadyEmpty: true },
    });
    // without `resume` the same empty store is refused (only a caller that wrote wipeStartedAt may say it)
    expect(await wiped.stub.purgeClosedStore('cp-resume', { fiscalDocuments: 3 })).toMatchObject({
      ok: false,
      code: 'STORE_NOT_CLOSED',
    });
    // an OPEN store with `resume` is refused: it has a profile and fiscal rows
    const open = await store('cp-resume-open');
    expect(
      await open.stub.purgeClosedStore('cp-resume-open', { fiscalDocuments: 3, resume: true })
    ).toMatchObject({
      ok: false,
      code: 'STORE_NOT_CLOSED',
    });
    expect((await fiscal(open.stub)).length).toBe(3);
  });
});
