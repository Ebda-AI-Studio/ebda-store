import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// Ruling CF-JOBS-3: the job operations on real workerd. A job delivered twice (an at-least-once queue, an alarm re-fire, a
// cron tick that overlaps) runs ONCE: the abandonment stamp lands once, a cancel-if-unpaid restocks once, and a payment that
// landed first beats the auto-cancel sweep.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (
  stub: ReturnType<typeof stubFor>,
  store: string,
  name: string,
  args: object,
  key?: string
) => (await stub.moneyOp(store, name, encodeRpc(args), key)) as Answer;
const val = (a: Answer) => {
  if (!a.ok) throw new Error(`refused ${a.code}`);
  return decodeRpc<any>(a.json);
};
const num = (stub: ReturnType<typeof stubFor>, sql: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql).one().n as number);
const codes = (a: Answer[]) =>
  a.reduce<Record<string, number>>((m, x) => {
    const k = x.ok ? 'ok' : x.code;
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

const COA: Array<[string, string]> = [
  ['1000', 'asset'],
  ['1200', 'asset'],
  ['2100', 'liability'],
  ['2150', 'liability'],
  ['4000', 'revenue'],
  ['4010', 'revenue'],
  ['5000', 'expense'],
];
/** A store with one order of 3 x 1000 (cost 400) and a paymob payment, ready for a webhook. */
async function seed(store: string) {
  const stub = stubFor(store);
  await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store
  await runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec(
      `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'Shop', ?, 'owner')`,
      store,
      store
    );
    s.storage.sql.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status, cost_price) VALUES ('p1', ?, 'Widget', 'widget', 1000, 20, 'active', 400)`,
      store
    );
    s.storage.sql.exec(
      `INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES (?, 1)`,
      store
    );
    for (const [code, type] of COA)
      s.storage.sql.exec(
        `INSERT INTO accounts (id, store_id, code, name_en, type, is_system) VALUES (?, ?, ?, ?, ?, 1)`,
        `a${code}`,
        store,
        code,
        code,
        type
      );
  });
  const o = val(
    await op(stub, store, 'createOrder', {
      lines: [{ productId: 'p1', quantity: 3 }],
      shippingAddress: { phone: '01000000001' },
    })
  );
  const p = val(
    await op(stub, store, 'paymentCreate', {
      orderId: o.orderId,
      provider: 'paymob',
      amount: o.total,
      transactionId: 'tx-1',
    })
  );
  return { stub, o, p };
}
const hook = (eventId: string) => ({
  input: {
    provider: 'paymob',
    eventId,
    providerRef: 'tx-1',
    kind: 'payment',
    status: 'completed',
    amount: 3000,
  },
});

describe('StoreDO.moneyOp job operations', () => {
  it('the abandonment stamp fired 20 times concurrently stamps once', async () => {
    const { stub, o } = await seed('job-abandon');
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(stub, 'job-abandon', 'abandonStamp', { orderId: o.orderId })
      )
    );
    expect(codes(answers)).toEqual({ ok: 20 });
    expect(answers.filter(a => val(a).stamped)).toHaveLength(1);
    expect(
      await num(
        stub,
        `SELECT count(*) AS n FROM orders WHERE payment_gateway_abandoned_at IS NOT NULL`
      )
    ).toBe(1);
  });

  it('the auto-cancel fired 20 times concurrently cancels once and restores the stock once', async () => {
    const { stub, o } = await seed('job-cancel');
    const before = await num(stub, `SELECT inventory AS n FROM products WHERE id = 'p1'`);
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(stub, 'job-cancel', 'cancel', { orderId: o.orderId, unpaidOnly: true })
      )
    );
    expect(codes(answers)).toEqual({ ok: 20 });
    expect(answers.filter(a => !val(a).replayed)).toHaveLength(1);
    expect(await num(stub, `SELECT count(*) AS n FROM orders WHERE status = 'cancelled'`)).toBe(1);
    expect(await num(stub, `SELECT inventory AS n FROM products WHERE id = 'p1'`)).toBe(before + 3);
  });

  it('a payment that lands first beats the auto-cancel: the order stays, nothing is restocked', async () => {
    const { stub, o } = await seed('job-paid');
    await op(stub, 'job-paid', 'paymentWebhook', hook('evt-1'));
    const before = await num(stub, `SELECT inventory AS n FROM products WHERE id = 'p1'`);
    const a = await op(stub, 'job-paid', 'cancel', { orderId: o.orderId, unpaidOnly: true });
    expect(a.ok ? 'ok' : a.code).toBe('ORDER_ALREADY_PAID');
    expect(await num(stub, `SELECT count(*) AS n FROM orders WHERE status = 'cancelled'`)).toBe(0);
    expect(await num(stub, `SELECT inventory AS n FROM products WHERE id = 'p1'`)).toBe(before);
  });

  it('the trial balance after a sale balances, and a refused op writes nothing', async () => {
    const { stub, o } = await seed('job-tb');
    await op(stub, 'job-tb', 'paymentWebhook', hook('evt-1'));
    await op(stub, 'job-tb', 'journalSale', { orderId: o.orderId });
    const tb = val(await op(stub, 'job-tb', 'trialBalance', {}));
    expect(tb.debit).toBeGreaterThan(0);
    expect(tb.debit).toBe(tb.credit);
    const bad = await op(stub, 'job-tb', 'paymentEventRecord', {
      paymentId: 'nope',
      orderId: o.orderId,
      eventType: 'reconciliation',
    });
    expect(bad.ok ? 'ok' : bad.code).toBe('PAYMENT_NOT_FOUND');
  });
});
