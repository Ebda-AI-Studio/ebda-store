import { beforeAll, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { ensurePlatformIndex } from './platform-index';

// INFRA-CF-1 PR D2b-3 (Rulings CF-PAY-1, CF-LEDGER-1): payments, webhooks, refunds and the ledger on real workerd. The DO is
// single threaded, so the Postgres payment-row lock and the (provider, event) idempotency are one step here: a webhook replay
// applies once, a double refund attempt refunds once, a double ledger post posts once.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
beforeAll(ensurePlatformIndex);
/** the gateway reference of the store the current test set up */
let currentRef = 'tx-1';
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
      // unique per store: the D1 entity index is shared by every store of this file and refuses a reused reference
      transactionId: (currentRef = `tx-${store}`),
    })
  );
  return { stub, o, p };
}
const hook = (eventId: string) => ({
  input: {
    provider: 'paymob',
    eventId,
    providerRef: currentRef,
    kind: 'payment',
    status: 'completed',
    amount: 3000,
    currency: 'EGP',
  },
});

describe('StoreDO.moneyOp payments', () => {
  it('a webhook delivered 20 times concurrently applies once: one event row, one paid transition, one order_paid', async () => {
    const { stub } = await seed('pay-replay');
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => op(stub, 'pay-replay', 'paymentWebhook', hook('evt-1')))
    );
    expect(codes(answers)).toEqual({ ok: 20 });
    const outcomes = answers.map(a => val(a).outcome);
    expect(outcomes.filter(x => x === 'applied')).toHaveLength(1);
    expect(outcomes.filter(x => x === 'replayed')).toHaveLength(19);
    expect(await num(stub, `SELECT count(*) AS n FROM payment_event_log`)).toBe(1);
    expect(
      await num(stub, `SELECT count(*) AS n FROM payment_events WHERE event_type = 'webhook'`)
    ).toBe(1);
    expect(await num(stub, `SELECT count(*) AS n FROM orders WHERE payment_status = 'paid'`)).toBe(
      1
    );
  });

  it('a double refund attempt refunds once: 20 concurrent full-refund claims, one wins, the balance ends at the payment amount', async () => {
    const { stub, p } = await seed('pay-refund');
    await op(stub, 'pay-refund', 'paymentWebhook', hook('evt-1'));
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(stub, 'pay-refund', 'refundBegin', { paymentId: p.paymentId })
      )
    );
    expect(answers.filter(a => a.ok)).toHaveLength(1);
    expect(await num(stub, `SELECT refunded_amount AS n FROM payments`)).toBe(3000);
    expect(
      await num(
        stub,
        `SELECT count(*) AS n FROM payment_events WHERE event_type = 'refund_initiated'`
      )
    ).toBe(1);
  });

  // Ruling NZ-REFUND-LOCK-1: the Postgres `SELECT ... FOR NO KEY UPDATE` on the payment is gone; the over-refund guard is the
  // remaining-balance check inside `beginRefund`'s ONE transactionSync section (packages/repo/src/do/payments.ts). Partial
  // claims that each fit but together exceed the payment are the case the lock existed for: a lost check lets two land.
  it('concurrent partial refunds that together exceed the payment: one claim, never over-refunded (2 and 20 at once)', async () => {
    for (const n of [2, 20]) {
      const store = `pay-overrefund-${n}`;
      const { stub, p } = await seed(store);
      await op(stub, store, 'paymentWebhook', hook('evt-1'));
      const answers = await Promise.all(
        Array.from({ length: n }, () =>
          op(stub, store, 'refundBegin', { paymentId: p.paymentId, amount: 2000 })
        )
      );
      expect(codes(answers), `n=${n}`).toEqual({ ok: 1, REFUND_EXCEEDS_REMAINING: n - 1 });
      expect(await num(stub, `SELECT refunded_amount AS n FROM payments`), `n=${n}`).toBe(2000);
      expect(
        await num(
          stub,
          `SELECT count(*) AS n FROM payment_events WHERE event_type = 'refund_initiated'`
        ),
        `n=${n}`
      ).toBe(1);
    }
  });

  it('20 concurrent refunds with one refundKey: exactly one claim', async () => {
    const { stub, p } = await seed('pay-refundkey');
    await op(stub, 'pay-refundkey', 'paymentWebhook', hook('evt-1'));
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(stub, 'pay-refundkey', 'refundBegin', {
          paymentId: p.paymentId,
          amount: 500,
          refundKey: 'rk-abcdef',
        })
      )
    );
    expect(answers.filter(a => a.ok)).toHaveLength(1);
    expect(await num(stub, `SELECT refunded_amount AS n FROM payments`)).toBe(500);
  });

  it('20 concurrent whole-order refund bookings restore the stock once', async () => {
    const { stub, o } = await seed('pay-restock');
    await op(stub, 'pay-restock', 'paymentWebhook', hook('evt-1'));
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(stub, 'pay-restock', 'refundBook', { orderId: o.orderId })
      )
    );
    expect(codes(answers)).toEqual({ ok: 20 });
    expect(answers.filter(a => !val(a).replayed)).toHaveLength(1);
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(20);
  });

  it('the sale journal posted 20 times concurrently posts two entries once (sale + COGS), and a refund reverses both once', async () => {
    const { stub, o } = await seed('pay-ledger');
    await op(stub, 'pay-ledger', 'paymentWebhook', hook('evt-1'));
    const posts = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(stub, 'pay-ledger', 'journalSale', { orderId: o.orderId })
      )
    );
    expect(posts.map(a => val(a).entries).reduce((s, x) => s + x, 0)).toBe(2);
    expect(await num(stub, `SELECT count(*) AS n FROM journal_entries`)).toBe(2);
    const refunds = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(stub, 'pay-ledger', 'journalRefund', { orderId: o.orderId })
      )
    );
    expect(refunds.map(a => val(a).reversed).reduce((s, x) => s + x, 0)).toBe(2);
    expect(await num(stub, `SELECT count(*) AS n FROM journal_entries`)).toBe(4);
    expect(await num(stub, `SELECT SUM(debit) - SUM(credit) AS n FROM journal_lines`)).toBe(0);
    // numbers are distinct: no two entries share a journal number
    expect(await num(stub, `SELECT count(DISTINCT entry_number) AS n FROM journal_entries`)).toBe(
      4
    );
  });

  it('a second store id is STORE_MISMATCH for every new operation', async () => {
    const { stub } = await seed('pay-mismatch');
    const r = (await stub.moneyOp(
      'other',
      'paymentWebhook',
      encodeRpc(hook('e')),
      undefined
    )) as Answer;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('STORE_MISMATCH');
  });
});
