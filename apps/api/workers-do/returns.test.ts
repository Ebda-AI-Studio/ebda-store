import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 last-mile R1 (Ruling CF-RETURNS-1): the Return lifecycle and the partial-return journal on real workerd. The DO is
// single threaded, so the completion claim, the over-claim check, the wallet credit and the journal booking are each one step:
// concurrent callers can never complete a return twice, over-claim a line, credit the wallet twice or book a partial twice.
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

describe('StoreDO.moneyOp returns', () => {
  it('40 concurrent completions of one return: exactly one claims it', async () => {
    const stub = await seed('ret-claim');
    const id = await received(stub, 'ret-claim', [tee(1)]);
    const answers = await Promise.all(
      Array.from({ length: 40 }, () =>
        op(stub, 'ret-claim', 'returnClaim', { returnId: id, refundMethod: 'manual' })
      )
    );
    expect(codes(answers)).toEqual({ ok: 1, RETURN_ALREADY_COMPLETING: 39 });
  });

  it('two different returns of one order completing together: one wins, the other is RETURN_ORDER_BUSY', async () => {
    const stub = await seed('ret-busy');
    const a = await received(stub, 'ret-busy', [tee(1)]);
    const b = await received(stub, 'ret-busy', [cap(1)]);
    const answers = await Promise.all([
      op(stub, 'ret-busy', 'returnClaim', { returnId: a, refundMethod: 'manual' }),
      op(stub, 'ret-busy', 'returnClaim', { returnId: b, refundMethod: 'manual' }),
    ]);
    expect(codes(answers)).toEqual({ ok: 1, RETURN_ORDER_BUSY: 1 });
  });

  it('10 concurrent requests for the same two tees: exactly one return holds them', async () => {
    const stub = await seed('ret-claimqty');
    const answers = await Promise.all(
      Array.from({ length: 10 }, () =>
        op(stub, 'ret-claimqty', 'returnCreate', {
          orderId: 'o1',
          customerId: 'cust',
          type: 'return',
          reason: 'r',
          items: [tee(2)],
        })
      )
    );
    expect(codes(answers)).toEqual({ ok: 1, INVALID_QUANTITY: 9 });
    expect(await num(stub, `SELECT count(*) AS n FROM returns`)).toBe(1);
  });

  it('a double partial return books once: 30 concurrent journals of one refundKey post one adjustment and one COGS entry', async () => {
    const stub = await seed('ret-journal');
    const id = await received(stub, 'ret-journal', [tee(1)]);
    await op(stub, 'ret-journal', 'returnClaim', { returnId: id, refundMethod: 'manual' });
    val(
      await op(stub, 'ret-journal', 'returnFinish', {
        returnId: id,
        refundMethod: 'manual',
        userId: 'u',
      })
    );
    const answers = await Promise.all(
      Array.from({ length: 30 }, () =>
        op(stub, 'ret-journal', 'journalPartialReturn', {
          orderId: 'o1',
          refundKey: id,
          items: [{ orderItemId: 'i1', quantity: 1 }],
        })
      )
    );
    const posted = answers.map(a => (a.ok ? decodeRpc<{ posted: number }>(a.json).posted : -1));
    expect(posted.filter(p => p === 2)).toHaveLength(1);
    expect(posted.filter(p => p === 0)).toHaveLength(29);
    expect(
      await num(
        stub,
        `SELECT count(*) AS n FROM journal_entries WHERE source_id LIKE 'o1:partial:%'`
      )
    ).toBe(2);
    expect(await num(stub, `SELECT SUM(debit) - SUM(credit) AS n FROM journal_lines`)).toBe(0);
  });

  it('a completion with store credit retried 25 times (a rolled-back request, a double click): one wallet credit, one restock', async () => {
    const stub = await seed('ret-credit');
    const id = await received(stub, 'ret-credit', [tee(1)]);
    const args = { returnId: id, refundMethod: 'store_credit', walletFeature: true };
    val(await op(stub, 'ret-credit', 'returnClaim', args));
    const answers = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        op(
          stub,
          'ret-credit',
          'returnFinish',
          { ...args, userId: 'u' },
          i % 2 ? 'finish-key-retry-1' : undefined
        )
      )
    );
    expect(codes(answers)).toEqual({ ok: 25 });
    const replayed = answers.filter(
      a => a.ok && decodeRpc<{ replayed: boolean }>(a.json).replayed
    ).length;
    expect(replayed).toBe(24);
    expect(await num(stub, `SELECT count(*) AS n FROM wallet_transactions`)).toBe(1);
    expect(await num(stub, `SELECT balance AS n FROM customer_wallets`)).toBe(10260);
    expect(await num(stub, `SELECT inventory AS n FROM products WHERE id = 'p1'`)).toBe(4);
    expect(await num(stub, `SELECT count(*) AS n FROM returns WHERE status = 'completed'`)).toBe(1);
  });

  it('a completion whose wallet credit cannot be applied leaves the return received, un-restocked and un-credited', async () => {
    const stub = await seed('ret-atomic');
    const id = await received(stub, 'ret-atomic', [tee(1)]);
    const args = { returnId: id, refundMethod: 'store_credit', walletFeature: true };
    val(await op(stub, 'ret-atomic', 'returnClaim', args));
    await runInDurableObject(stub, (_i, s) =>
      s.storage.sql.exec(
        `CREATE TRIGGER wallet_boom BEFORE INSERT ON customer_wallets BEGIN SELECT RAISE(ABORT, 'wallet unavailable'); END`
      )
    );
    const refused = await op(stub, 'ret-atomic', 'returnFinish', { ...args, userId: 'u' });
    expect(refused).toMatchObject({ ok: false });
    expect(await num(stub, `SELECT count(*) AS n FROM returns WHERE status = 'received'`)).toBe(1);
    expect(await num(stub, `SELECT inventory AS n FROM products WHERE id = 'p1'`)).toBe(3);
    expect(await num(stub, `SELECT count(*) AS n FROM wallet_transactions`)).toBe(0);
  });

  it('the return credit lands on the account (users.id) even when the merchant has NO CRM row for the shopper (Ruling CF-FIX-2)', async () => {
    const stub = await seed('ret-nocrm');
    const id = await received(stub, 'ret-nocrm', [tee(1)]);
    await runInDurableObject(stub, (_i, s) => s.storage.sql.exec(`DELETE FROM customers`));
    const args = { returnId: id, refundMethod: 'store_credit', walletFeature: true };
    val(await op(stub, 'ret-nocrm', 'returnClaim', args));
    val(await op(stub, 'ret-nocrm', 'returnFinish', { ...args, userId: 'u' }));
    expect(await num(stub, `SELECT count(*) AS n FROM returns WHERE status = 'completed'`)).toBe(1);
    expect(
      await num(stub, `SELECT balance AS n FROM customer_wallets WHERE customer_id = 'cust'`)
    ).toBeGreaterThan(0);
  });
});
