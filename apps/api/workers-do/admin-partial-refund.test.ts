import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// STORE-QA-76: the merchant-opened return / partial refund on real workerd: two partials sum to the paid total and a third is
// refused, restock is per line (stock + the inventory GL reversal), the merchant-only flags cannot be forged by a shopper, and
// the revenue figure follows. Seed mirrors returns.test.ts (a delivered, paid order: 2 tees at 10000, 1 cap at 5000).
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
const val = <T = any>(a: Answer): T => {
  if (!a.ok) throw new Error(`refused ${a.code}`);
  return decodeRpc<T>(a.json);
};
const num = (stub: ReturnType<typeof stubFor>, sql: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql).one().n as number);
const codes = (a: Answer[]) =>
  a.reduce<Record<string, number>>((m, x) => {
    const k = x.ok ? 'ok' : x.code;
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

const now = Date.now();
/** A delivered, paid order of 2 tees (10000) + 1 cap (5000) with its sale + COGS entries, and a customer with no wallet yet. */
async function seed(store: string) {
  const stub = stubFor(store);
  await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store (a refusal, nothing written)
  await runInDurableObject(stub, (_i, s) => {
    const x = (sql: string, ...p: unknown[]) => s.storage.sql.exec(sql, ...p);
    x(`INSERT INTO store_config (store_id) VALUES (?)`, store);
    x(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', ?, 'Tee', 'tee', 10000, 3, 'active')`,
      store
    );
    x(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p2', ?, 'Cap', 'cap', 5000, 4, 'active')`,
      store
    );
    x(
      `INSERT INTO customers (id, store_id, first_name, last_name, user_id) VALUES ('crm-cust', ?, 'A', 'B', 'cust')`,
      store
    );
    x(
      `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, discount, tax, shipping, total, wallet_amount, shipping_address, billing_address, delivered_at, updated_at, created_at)
       VALUES ('o1', ?, 'cust', 'ORD-1', 'delivered', 'paid', 25000, 2500, 3150, 0, 25650, 0, '{}', '{}', ?, ?, ?)`,
      store,
      now - 1000,
      now - 1000,
      now - 5000
    );
    x(
      `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, total, cost_price) VALUES ('i1', 'o1', 'p1', 'Tee', 2, 10000, 20000, 4000)`
    );
    x(
      `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, total, cost_price) VALUES ('i2', 'o1', 'p2', 'Cap', 1, 5000, 5000, 2000)`
    );
    for (const [c, t] of [
      ['1000', 'asset'],
      ['1200', 'asset'],
      ['2100', 'liability'],
      ['2150', 'liability'],
      ['2160', 'liability'],
      ['4000', 'revenue'],
      ['4090', 'revenue'],
      ['5000', 'expense'],
    ])
      x(
        `INSERT INTO accounts (id, store_id, code, name_en, type, is_system) VALUES ('a' || ?, ?, ?, ?, ?, 1)`,
        c,
        store,
        c,
        c,
        t
      );
    const entry = (id: string, src: string, lines: Array<[string, number, number]>) => {
      x(
        `INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, source_id, status, created_at) VALUES (?, ?, ?, ?, 'order', ?, 'posted', ?)`,
        id,
        store,
        `JE-${id}`,
        now,
        src,
        now
      );
      lines.forEach(([a, d, c], i) =>
        x(
          `INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          `${id}-${i}`,
          id,
          `a${a}`,
          d,
          c,
          now
        )
      );
    };
    entry('e1', 'o1', [
      ['1000', 25650, 0],
      ['4000', 0, 22500],
      ['2100', 0, 3150],
    ]);
    entry('e2', 'o1:cogs', [
      ['5000', 10000, 0],
      ['1200', 0, 10000],
    ]);
  });
  return stub;
}
const tee = (q: number) => ({
  orderItemId: 'i1',
  productId: 'p1',
  productName: 'Tee',
  quantity: q,
});
const cap = (q: number) => ({
  orderItemId: 'i2',
  productId: 'p2',
  productName: 'Cap',
  quantity: q,
});
async function received(stub: ReturnType<typeof stubFor>, store: string, items: object[]) {
  const { returnId } = val(
    await op(stub, store, 'returnCreate', {
      orderId: 'o1',
      customerId: 'cust',
      type: 'return',
      reason: 'size',
      items,
    })
  );
  await op(stub, store, 'returnStatus', { returnId, status: 'approved', userId: 'u' });
  await op(stub, store, 'returnStatus', { returnId, status: 'received', userId: 'u' });
  return returnId as string;
}

const lineArg = (
  orderItemId: string,
  productId: string,
  name: string,
  quantity: number,
  restock?: boolean
) => ({
  orderItemId,
  productId,
  productName: name,
  quantity,
  ...(restock === undefined ? {} : { restock }),
});
const T1 = (q: number, restock?: boolean) => lineArg('i1', 'p1', 'Tee', q, restock);
const C1 = (q: number, restock?: boolean) => lineArg('i2', 'p2', 'Cap', q, restock);

/** What the admin "Refund" dialog does server-side: open (merchant) -> approve -> receive -> claim -> finish -> journal. */
async function partialRefund(
  stub: ReturnType<typeof stubFor>,
  store: string,
  items: object[],
  method = 'cash'
) {
  const { returnId } = val<{ returnId: string }>(
    await op(stub, store, 'returnCreate', {
      orderId: 'o1',
      type: 'refund',
      reason: 'damaged in transit',
      byMerchant: true,
      items,
    })
  );
  await op(stub, store, 'returnStatus', { returnId, status: 'approved', userId: 'u' });
  await op(stub, store, 'returnStatus', { returnId, status: 'received', userId: 'u' });
  val(await op(stub, store, 'returnClaim', { returnId, refundMethod: method }));
  const done = val<{ refundAmount: number }>(
    await op(stub, store, 'returnFinish', { returnId, refundMethod: method, userId: 'u' })
  );
  const wanted = (items as Array<{ orderItemId: string; quantity: number }>).map(i => ({
    orderItemId: i.orderItemId,
    quantity: i.quantity,
  }));
  await op(stub, store, 'journalPartialReturn', {
    orderId: 'o1',
    refundKey: returnId,
    items: wanted,
  });
  return { returnId, refundAmount: done.refundAmount };
}

describe('STORE-QA-76 merchant partial refund / return on the StoreDO', () => {
  it('two partial refunds sum to exactly what was paid, the third is refused, the revenue and the ledger agree', async () => {
    const store = 'qa76-sum';
    const stub = await seed(store);
    const quote0 = val(await op(stub, store, 'analyticsRefundQuote', { orderId: 'o1' }));
    expect(quote0).toMatchObject({ paid: 25650, refunded: 0, refundable: 25650 });

    const a = await partialRefund(stub, store, [T1(1)]);
    const mid = val(await op(stub, store, 'analyticsRefundQuote', { orderId: 'o1' }));
    expect(mid.refundable).toBe(25650 - a.refundAmount);
    expect(mid.lines.find((l: any) => l.orderItemId === 'i1').remaining).toBe(1);
    // the net sales figure already follows (REVENUE-DEF-1: total - LEAST(total, GREATEST(returns, payments.refunded)))
    expect(val(await op(stub, store, 'analyticsNetRevenue', {})).revenue).toBe(
      25650 - a.refundAmount
    );

    const b = await partialRefund(stub, store, [T1(1), C1(1)]);
    expect(a.refundAmount + b.refundAmount).toBe(25650);
    const after = val(await op(stub, store, 'analyticsRefundQuote', { orderId: 'o1' }));
    expect(after).toMatchObject({ refunded: 25650, refundable: 0 });
    expect(val(await op(stub, store, 'analyticsNetRevenue', {})).revenue).toBe(0);

    // a third: every unit is already claimed, and a merchant-booked amount cannot exceed what is left either
    const third = await op(stub, store, 'returnCreate', {
      orderId: 'o1',
      type: 'refund',
      reason: 'again',
      byMerchant: true,
      items: [C1(1)],
    });
    expect(third).toMatchObject({ ok: false, code: 'INVALID_QUANTITY' });
    const over = await op(stub, store, 'refundBook', {
      orderId: 'o1',
      amount: 1,
      refundKey: 'manual-3',
    });
    expect(over).toMatchObject({ ok: false, code: 'REFUND_EXCEEDS_ORDER' });

    // journal reversal posted for both, every entry balanced; the sale + two partials net the revenue accounts
    expect(
      await num(
        stub,
        `SELECT count(*) AS n FROM journal_entries WHERE source_id LIKE 'o1:partial:%' AND source_id NOT LIKE '%:cogs'`
      )
    ).toBe(2);
    expect(await num(stub, `SELECT SUM(debit) - SUM(credit) AS n FROM journal_lines`)).toBe(0);
  });

  it('restock is per line: a restocked tracked line goes back on the shelf, a not-restocked one does not and keeps its COGS expensed', async () => {
    const store = 'qa76-restock';
    const stub = await seed(store);
    const r = await partialRefund(stub, store, [T1(1, true), C1(1, false)]);
    expect(await num(stub, `SELECT inventory AS n FROM products WHERE id = 'p1'`)).toBe(4); // 3 -> 4
    expect(await num(stub, `SELECT inventory AS n FROM products WHERE id = 'p2'`)).toBe(4); // untouched
    expect(
      await num(stub, `SELECT count(*) AS n FROM inventory_history WHERE type = 'return_stock'`)
    ).toBe(1);
    // inventory GL: only the tee (cost 4000) comes back; the cap's 2000 stays in COGS
    expect(
      await num(
        stub,
        `SELECT COALESCE(SUM(l.debit), 0) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.source_id = 'o1:partial:${r.returnId}:cogs' AND l.account_id = 'a1200'`
      )
    ).toBe(4000);
    expect(await num(stub, `SELECT SUM(debit) - SUM(credit) AS n FROM journal_lines`)).toBe(0);
    // an untracked product is never restocked even when the merchant says so
    const stub2 = await seed('qa76-untracked');
    await runInDurableObject(stub2, (_i, s) =>
      s.storage.sql.exec(`UPDATE products SET track_inventory = 0 WHERE id = 'p1'`)
    );
    await partialRefund(stub2, 'qa76-untracked', [T1(1, true)]);
    expect(await num(stub2, `SELECT inventory AS n FROM products WHERE id = 'p1'`)).toBe(3);
  });

  it('refuses before any money moves: a whole-order return cannot skip a restock, a guest order has no return yet', async () => {
    const store = 'qa76-refuse';
    const stub = await seed(store);
    const { returnId } = val<{ returnId: string }>(
      await op(stub, store, 'returnCreate', {
        orderId: 'o1',
        type: 'refund',
        reason: 'all',
        byMerchant: true,
        items: [T1(2, true), C1(1, false)],
      })
    );
    await op(stub, store, 'returnStatus', { returnId, status: 'received', userId: 'u' });
    expect(await op(stub, store, 'returnClaim', { returnId, refundMethod: 'cash' })).toMatchObject({
      ok: false,
      code: 'FULL_RETURN_RESTOCK_ALL',
    });
    expect(await num(stub, `SELECT inventory AS n FROM products WHERE id = 'p2'`)).toBe(4);

    await runInDurableObject(stub, (_i, s) =>
      s.storage.sql.exec(`UPDATE orders SET customer_id = NULL`)
    );
    expect(
      await op(stub, store, 'returnCreate', {
        orderId: 'o1',
        type: 'refund',
        reason: 'g',
        byMerchant: true,
        items: [T1(1)],
      })
    ).toMatchObject({ ok: false, code: 'GUEST_ORDER_RETURN_UNSUPPORTED' });
  });

  it('a shopper cannot forge the merchant-only flags: no_restock is dropped and the customer match + window still bind', async () => {
    const store = 'qa76-forge';
    const stub = await seed(store);
    val(
      await op(stub, store, 'returnCreate', {
        orderId: 'o1',
        customerId: 'cust',
        type: 'return',
        reason: 'r',
        items: [{ ...tee(1), condition: 'no_restock', restock: false }],
      })
    );
    expect(
      await num(stub, `SELECT count(*) AS n FROM return_items WHERE condition IS NOT NULL`)
    ).toBe(0);
    // another customer's order, and byMerchant omitted: refused as before
    expect(
      await op(stub, store, 'returnCreate', {
        orderId: 'o1',
        customerId: 'someone-else',
        type: 'return',
        reason: 'r',
        items: [tee(1)],
      })
    ).toMatchObject({ ok: false, code: 'INVALID_ORDER' });
  });

  it('the same idempotency key opens ONE return (a double click, a retried request)', async () => {
    const store = 'qa76-idem';
    const stub = await seed(store);
    const args = { orderId: 'o1', type: 'refund', reason: 'r', byMerchant: true, items: [T1(1)] };
    const a = val<{ returnId: string }>(await op(stub, store, 'returnCreate', args, 'k-12345678'));
    const b = val<{ returnId: string }>(await op(stub, store, 'returnCreate', args, 'k-12345678'));
    expect(b.returnId).toBe(a.returnId);
    expect(await num(stub, `SELECT count(*) AS n FROM returns`)).toBe(1);
  });

  it('the quote estimates a selection with the same allocation the completion pays', async () => {
    const store = 'qa76-quote';
    const stub = await seed(store);
    const q = val(
      await op(stub, store, 'analyticsRefundQuote', {
        orderId: 'o1',
        items: [{ orderItemId: 'i1', quantity: 1 }],
      })
    );
    expect(q.coversWholeOrder).toBe(false);
    const r = await partialRefund(stub, store, [T1(1)]);
    expect(q.estimate).toBe(r.refundAmount);
    expect(
      await op(stub, store, 'analyticsRefundQuote', {
        orderId: 'o1',
        items: [{ orderItemId: 'i1', quantity: 5 }],
      })
    ).toMatchObject({ ok: false, code: 'INVALID_QUANTITY' });
  });
});
