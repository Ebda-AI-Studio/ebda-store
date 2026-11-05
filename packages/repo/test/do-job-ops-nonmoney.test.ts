// Ruling CF-JOBS-4: the ledger totals and the Customer Intelligence order stamp the non-money jobs need on a store that lives on
// its Durable Object, run on the real DO schema (node:sqlite).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';
import { ensurePaymentSchema } from '../src/do/payments';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
const COA: Array<[string, string, string]> = [
  ['1000', 'Cash Online', 'asset'],
  ['1020', 'Cash COD', 'asset'],
  ['1200', 'Inventory', 'asset'],
  ['2100', 'Tax Payable', 'liability'],
  ['2150', 'Customer Wallet Liability', 'liability'],
  ['4000', 'Sales', 'revenue'],
  ['4010', 'Shipping Income', 'revenue'],
  ['5000', 'COGS', 'expense'],
];
function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  ensurePaymentSchema(db);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status, cost_price) VALUES ('sku', 's1', 'Widget', 'widget', 1000, 20, 'active', 400);
     INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES ('s1', 1);`
  );
  for (const [code, name, type] of COA)
    raw.exec(
      `INSERT INTO accounts (id, store_id, code, name_en, type, is_system) VALUES ('a${code}', 's1', '${code}', '${name}', '${type}', 1)`
    );
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  const op = (name: string, args: Record<string, unknown>, key?: string, store = S) =>
    runMoneyOp(db, store, name, args, key) as any;
  const code = (name: string, args: Record<string, unknown>): string => {
    try {
      op(name, args);
    } catch (e) {
      return `${(e as MoneyError).code}/${(e as MoneyError).status}`;
    }
    return 'no error';
  };
  let n = 0;
  const order = (provider = 'paymob') => {
    n++;
    const o = op('createOrder', {
      lines: [{ productId: 'sku', quantity: 2 }],
      shippingAddress: { phone: `010${String(n).padStart(8, '0')}` },
    });
    const { paymentId } = op('paymentCreate', {
      orderId: o.orderId,
      provider,
      amount: o.total,
      transactionId: `tx-${n}`,
    });
    return { ...o, paymentId, ref: `tx-${n}`, provider };
  };
  return { raw, db, q, op, code, order };
}

describe('non-money job operations on the DO (Ruling CF-JOBS-4)', () => {
  it('are registered', () => {
    expect(MONEY_OP_NAMES).toEqual(expect.arrayContaining(['accountTotals', 'ciOrderStamp']));
  });

  const paid = (r: ReturnType<typeof rig>, ev: string) => {
    const o = r.order();
    r.op('paymentWebhook', {
      input: {
        provider: 'paymob',
        eventId: ev,
        providerRef: o.ref,
        kind: 'payment',
        status: 'completed',
        amount: o.total,
        currency: 'EGP',
      },
      confirmed: null,
    });
    r.op('journalSale', { orderId: o.orderId });
    return o;
  };

  it('accountTotals lists every account, sums the counted entries, and honours the posted-at window', () => {
    const r = rig();
    paid(r, 'e1');
    const all = r.op('accountTotals', {}).rows as Array<any>;
    expect(all.map(a => a.code)).toEqual(COA.map(c => c[0]).sort()); // every account, even without lines, by code
    const sum = (k: 'debit' | 'credit') => all.reduce((s, a) => s + a[k], 0);
    expect(sum('debit')).toBeGreaterThan(0);
    expect(sum('debit')).toBe(sum('credit')); // a balanced ledger
    const revenue = all
      .filter(a => a.type === 'revenue')
      .reduce((s, a) => s + a.credit - a.debit, 0);
    expect(revenue).toBeGreaterThan(0);
    // a window that excludes the entry: the accounts are still listed, with zero totals
    const later = r.op('accountTotals', { fromMs: Date.now() + 60_000 }).rows as Array<any>;
    expect(later).toHaveLength(all.length);
    expect(later.every(a => a.debit === 0 && a.credit === 0)).toBe(true);
    const upTo = r.op('accountTotals', { toMs: Date.now() + 60_000 }).rows as Array<any>;
    expect(upTo.reduce((s, a) => s + a.debit, 0)).toBe(sum('debit'));
  });

  it('accountTotals never counts a draft entry and never reads another store', () => {
    const r = rig();
    paid(r, 'e2');
    r.raw.exec("UPDATE journal_entries SET status = 'draft'");
    const draft = r.op('accountTotals', {}).rows as Array<any>;
    expect(draft.every(a => a.debit === 0 && a.credit === 0)).toBe(true);
    r.raw.exec("UPDATE journal_entries SET status = 'posted'");
    expect(r.op('accountTotals', {}, undefined, 'other').rows as Array<any>).toEqual([]);
    expect(r.code('accountTotals', { fromMs: 'x' })).toBe('BAD_ARGS/400');
  });

  it('ciOrderStamp stamps area and buyer once; the second delivery and a stamped order change nothing', () => {
    const r = rig();
    const o = r.order();
    const stamp = { orderId: o.orderId, areaKey: 'EG-CAIRO', buyerKey: 'a'.repeat(64) };
    expect(r.op('ciOrderStamp', stamp)).toEqual({ stamped: true });
    expect(r.op('ciOrderStamp', stamp)).toEqual({ stamped: false });
    expect(
      r.op('ciOrderStamp', { ...stamp, areaKey: 'EG-GIZA', buyerKey: 'b'.repeat(64) })
    ).toEqual({
      stamped: false,
    });
    expect(r.q('SELECT area_key a, buyer_key b FROM orders WHERE id = ?', o.orderId)[0]).toEqual({
      a: 'EG-CAIRO',
      b: 'a'.repeat(64),
    });
  });

  it('ciOrderStamp is scoped to the store and refuses a missing order id', () => {
    const r = rig();
    const o = r.order();
    expect(
      r.op(
        'ciOrderStamp',
        { orderId: o.orderId, areaKey: 'x', buyerKey: 'c'.repeat(64) },
        undefined,
        'other'
      )
    ).toEqual({ stamped: false });
    expect(r.code('ciOrderStamp', { areaKey: 'x', buyerKey: 'c'.repeat(64) })).toBe('BAD_ARGS/400');
  });
});
