// Ruling CF-JOBS-4: the store-side statements background jobs need on a store that lives on its Durable Object, run on the
// real DO schema (node:sqlite): payment-timeline rows, the abandonment stamp once, the ledger totals, cancel-only-if-unpaid.
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

describe('job operations on the DO (Ruling CF-JOBS-4)', () => {
  it('are registered', () => {
    expect(MONEY_OP_NAMES).toEqual(
      expect.arrayContaining([
        'paymentEventRecord',
        'abandonStamp',
        'trialBalance',
        'periodGlCredits',
      ])
    );
  });

  it('paymentEventRecord appends a reconciliation row; another store or another order cannot', () => {
    const r = rig();
    const o = r.order();
    r.op('paymentEventRecord', {
      paymentId: o.paymentId,
      orderId: o.orderId,
      eventType: 'reconciliation',
      fromStatus: 'completed',
      provider: 'paymob',
      details: { reason: 'completed_payment_on_cancelled_order' },
    });
    const rows = r.q(
      "SELECT details, from_status, store_id FROM payment_events WHERE event_type = 'reconciliation'"
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details)).toEqual({ reason: 'completed_payment_on_cancelled_order' });
    expect(rows[0].store_id).toBe('s1');
    expect(
      r.code('paymentEventRecord', { paymentId: o.paymentId, orderId: 'nope', eventType: 'x' })
    ).toBe('PAYMENT_NOT_FOUND/404');
    expect(
      (() => {
        try {
          r.op(
            'paymentEventRecord',
            { paymentId: o.paymentId, orderId: o.orderId, eventType: 'x' },
            undefined,
            'other'
          );
          return 'no error';
        } catch (e) {
          return (e as MoneyError).code;
        }
      })()
    ).toBe('PAYMENT_NOT_FOUND');
  });

  it('abandonStamp stamps an unpaid order once, and never a paid one', () => {
    const r = rig();
    const o = r.order();
    expect(r.op('abandonStamp', { orderId: o.orderId })).toEqual({ stamped: true });
    expect(r.op('abandonStamp', { orderId: o.orderId })).toEqual({ stamped: false });
    const paid = r.order();
    r.op('paymentWebhook', {
      input: {
        provider: 'paymob',
        eventId: 'e1',
        providerRef: paid.ref,
        kind: 'payment',
        status: 'completed',
        amount: paid.total,
        currency: 'EGP',
      },
      confirmed: null,
    });
    expect(r.op('abandonStamp', { orderId: paid.orderId })).toEqual({ stamped: false });
    expect(
      r.q('SELECT payment_gateway_abandoned_at a FROM orders WHERE id = ?', paid.orderId)[0].a
    ).toBeNull();
  });

  it('trialBalance and periodGlCredits read the posted ledger of this store only', () => {
    const r = rig();
    const o = r.order();
    r.op('paymentWebhook', {
      input: {
        provider: 'paymob',
        eventId: 'e2',
        providerRef: o.ref,
        kind: 'payment',
        status: 'completed',
        amount: o.total,
        currency: 'EGP',
      },
      confirmed: null,
    });
    r.op('journalSale', { orderId: o.orderId });
    const tb = r.op('trialBalance', {});
    expect(tb.debit).toBeGreaterThan(0);
    expect(tb.debit).toBe(tb.credit);
    const since = r.op('periodGlCredits', { sinceMs: 0 });
    expect(since.total).toBeGreaterThan(0);
    expect(r.op('periodGlCredits', { sinceMs: Date.now() + 60_000 }).total).toBe(0);
    expect(r.op('trialBalance', {}, undefined, 'other')).toEqual({ debit: 0, credit: 0 });
  });

  it('cancel with unpaidOnly cancels an unpaid order and refuses a paid one without changing it', () => {
    const r = rig();
    const u = r.order();
    expect(r.op('cancel', { orderId: u.orderId, unpaidOnly: true }).status).toBe('cancelled');
    const p = r.order();
    r.op('paymentWebhook', {
      input: {
        provider: 'paymob',
        eventId: 'e3',
        providerRef: p.ref,
        kind: 'payment',
        status: 'completed',
        amount: p.total,
        currency: 'EGP',
      },
      confirmed: null,
    });
    expect(r.code('cancel', { orderId: p.orderId, unpaidOnly: true })).toBe(
      'ORDER_ALREADY_PAID/409'
    );
    expect(r.q('SELECT status FROM orders WHERE id = ?', p.orderId)[0].status).not.toBe(
      'cancelled'
    );
  });
});

describe('reorder scan ops (Ruling CF-JOBS-4)', () => {
  it('reorderExpire expires stale and unit-gone suggestions only', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO product_variants (id, product_id, title, price, inventory, is_active) VALUES ('v1', 'sku', 'M', 1, 1, 1)`
    );
    const ins = (id: string, vid: string | null, at: number) =>
      r.raw.exec(
        `INSERT INTO reorder_suggestions (id, store_id, product_id, variant_id, suggested_qty, velocity_7d, velocity_28d, on_hand, on_order, open_backlog, urgency_days, reasoning_en, status, scanned_at) VALUES ('${id}', 's1', 'sku', ${vid ? `'${vid}'` : 'NULL'}, 1, 0, 0, 0, 0, 0, 1, 'x', 'open', ${at})`
      );
    const now = Date.now();
    ins('old', 'v1', now - 40 * 86400_000); // stale
    ins('legacy', null, now); // product-level row of a product that has variants
    ins('fresh', 'v1', now - 1000 + 1); // kept
    r.raw.exec(`UPDATE reorder_suggestions SET scanned_at = ${now - 500} WHERE id = 'fresh'`);
    const out = r.op('reorderExpire', { thresholdMs: now - 30 * 86400_000 });
    expect(out.expired).toBe(2);
    expect(r.q(`SELECT id FROM reorder_suggestions WHERE status = 'open'`).map(x => x.id)).toEqual([
      'fresh',
    ]);
  });

  it('reorderUpsert keeps one open row per unit: update the latest, else insert; a bad unit is skipped', () => {
    const r = rig();
    const item = (qty: number, productId = 'sku') => ({
      productId,
      variantId: null,
      suggestedQty: qty,
      velocity7d: 1,
      velocity28d: 1,
      onHand: 0,
      onOrder: 0,
      openBacklog: 0,
      urgencyDays: 1,
      supplierId: null,
      reasoningEn: 'why',
      reasoningAr: null,
    });
    expect(r.op('reorderUpsert', { scannedAtMs: 1000, items: [item(5)] })).toEqual({ upserted: 1 });
    expect(r.op('reorderUpsert', { scannedAtMs: 2000, items: [item(9)] })).toEqual({ upserted: 1 });
    const rows = r.q(`SELECT suggested_qty q, scanned_at a FROM reorder_suggestions`);
    expect(rows).toEqual([{ q: 9, a: 2000 }]);
    // a product that does not exist violates the FK: skipped, nothing thrown, the others still land
    expect(r.op('reorderUpsert', { scannedAtMs: 3000, items: [item(1, 'nope'), item(4)] })).toEqual(
      {
        upserted: 1,
      }
    );
  });
});

describe('expense / stock-adjustment / PO-receive journals (Ruling CF-JOBS-4)', () => {
  function books() {
    const r = rig();
    for (const [code, name, type] of [
      ['2000', 'AP', 'liability'],
      ['3000', 'Equity', 'equity'],
      ['5010', 'COGS variance', 'expense'],
      ['5200', 'Rent', 'expense'],
      ['5900', 'Damage', 'expense'],
    ])
      r.raw.exec(
        `INSERT INTO accounts (id, store_id, code, name_en, type, is_system) VALUES ('a${code}', 's1', '${code}', '${name}', '${type}', 1)`
      );
    return r;
  }
  const tb = (r: ReturnType<typeof rig>) => r.op('trialBalance', {});

  it('journalExpense posts DR expense / CR paid-from once, skips a draft, and a replay posts nothing', () => {
    const r = books();
    r.raw.exec(
      `INSERT INTO expenses (id, store_id, expense_number, expense_account_id, paid_from_account_id, amount, total, expense_date, status) VALUES ('e1', 's1', 'EXP-1', 'a5200', 'a1000', 500, 500, 1, 'posted'), ('e2', 's1', 'EXP-2', 'a5200', 'a1000', 700, 700, 1, 'draft')`
    );
    expect(r.op('journalExpense', { expenseId: 'e1' })).toEqual({ posted: true });
    expect(r.op('journalExpense', { expenseId: 'e1' })).toEqual({ posted: false });
    expect(r.op('journalExpense', { expenseId: 'e2' })).toEqual({
      posted: false,
      skipped: 'not_posted',
    });
    expect(r.op('journalExpense', { expenseId: 'nope' }).skipped).toBe('expense_not_found');
    expect(tb(r)).toEqual({ debit: 500, credit: 500 });
  });

  it('journalStockAdjustment: a loss debits damage and credits inventory; a gain the reverse; a replay is a no-op', () => {
    const r = books();
    r.raw.exec(
      `INSERT INTO stock_adjustments (id, store_id, adjustment_number, type, status, total_value_impact) VALUES ('s1', 's1', 'ADJ-1', 'damage', 'posted', -300), ('s2', 's1', 'ADJ-2', 'found', 'posted', 200)`
    );
    expect(r.op('journalStockAdjustment', { adjustmentId: 's1' })).toEqual({ posted: true });
    expect(r.op('journalStockAdjustment', { adjustmentId: 's2' })).toEqual({ posted: true });
    expect(r.op('journalStockAdjustment', { adjustmentId: 's1' })).toEqual({ posted: false });
    const dr = r.q(
      `SELECT a.code, l.debit d, l.credit c FROM journal_lines l JOIN accounts a ON a.id = l.account_id ORDER BY a.code, l.debit`
    );
    expect(dr).toEqual(
      expect.arrayContaining([
        { code: '5900', d: 300, c: 0 },
        { code: '1200', d: 0, c: 300 },
        { code: '1200', d: 200, c: 0 },
        { code: '3000', d: 0, c: 200 },
      ])
    );
    expect(tb(r).debit).toBe(tb(r).credit);
  });

  it('journalPoReceive books the received value, then each cleared backorder once; a missing account fails and writes nothing', () => {
    const r = books();
    r.raw.exec(
      `INSERT INTO suppliers (id, store_id, name) VALUES ('sup', 's1', 'Acme');
       INSERT INTO purchase_orders (id, store_id, supplier_id, po_number, status) VALUES ('po1', 's1', 'sup', 'PO-1', 'received');
       INSERT INTO purchase_order_items (id, po_id, product_id, qty, qty_received, unit_cost, total) VALUES ('i1', 'po1', 'sku', 10, 10, 100, 1000);`
    );
    const cleared = [
      {
        backorderLineId: 'bo-12345678',
        orderItemId: 'oi',
        qty: 2,
        actualUnitCost: 120,
        estimateUnitCost: 100,
        variance: 40,
      },
    ];
    const a = r.op('journalPoReceive', { poId: 'po1', clearedBackorders: cleared });
    expect(a).toMatchObject({ posted: true, entries: 2 });
    expect(r.op('journalPoReceive', { poId: 'po1', clearedBackorders: cleared })).toMatchObject({
      posted: false,
      entries: 0,
    });
    expect(tb(r).debit).toBe(tb(r).credit);
    const r2 = rig(); // no AP / COGS-variance accounts seeded
    r2.raw.exec(
      `INSERT INTO suppliers (id, store_id, name) VALUES ('sup', 's1', 'Acme');
       INSERT INTO purchase_orders (id, store_id, supplier_id, po_number, status) VALUES ('po1', 's1', 'sup', 'PO-1', 'received');
       INSERT INTO purchase_order_items (id, po_id, product_id, qty, qty_received, unit_cost, total) VALUES ('i1', 'po1', 'sku', 1, 1, 100, 100);`
    );
    expect(r2.code('journalPoReceive', { poId: 'po1', clearedBackorders: [] })).toBe(
      'ACCOUNT_NOT_FOUND/409'
    );
    expect(r2.q('SELECT count(*) n FROM journal_entries')[0].n).toBe(0);
  });

  describe('journals are dated by the document, not by the posting job (ACCT-AUDIT-3)', () => {
    const postedAt = (r: ReturnType<typeof rig>) =>
      r.q('SELECT posted_at p FROM journal_entries ORDER BY created_at').map(x => Number(x.p));
    const OCT28 = Date.UTC(2026, 9, 28, 9, 0, 0);

    it('an expense dated 28 Oct that is posted on 3 Nov lands in October', () => {
      const r = books();
      r.raw.exec(
        `INSERT INTO expenses (id, store_id, expense_number, expense_account_id, paid_from_account_id, amount, total, expense_date, status) VALUES ('e1', 's1', 'EXP-1', 'a5200', 'a1000', 500, 500, ${OCT28}, 'posted')`
      );
      r.op('journalExpense', { expenseId: 'e1' });
      expect(postedAt(r)).toEqual([OCT28]);
    });

    it('a future-dated expense is clamped to now, never posted into the future', () => {
      const r = books();
      const future = Date.now() + 40 * 86_400_000;
      r.raw.exec(
        `INSERT INTO expenses (id, store_id, expense_number, expense_account_id, paid_from_account_id, amount, total, expense_date, status) VALUES ('e1', 's1', 'EXP-1', 'a5200', 'a1000', 500, 500, ${future}, 'posted')`
      );
      r.op('journalExpense', { expenseId: 'e1' });
      expect(postedAt(r)[0]).toBeLessThanOrEqual(Date.now());
    });

    it('a stock adjustment keeps the date it was posted on', () => {
      const r = books();
      r.raw.exec(
        `INSERT INTO stock_adjustments (id, store_id, adjustment_number, type, status, total_value_impact, posted_at) VALUES ('s1', 's1', 'ADJ-1', 'damage', 'posted', -300, ${OCT28})`
      );
      r.op('journalStockAdjustment', { adjustmentId: 's1' });
      expect(postedAt(r)).toEqual([OCT28]);
    });

    it('a PO receipt keeps the date it was received on', () => {
      const r = books();
      r.raw.exec(
        `INSERT INTO suppliers (id, store_id, name) VALUES ('sup', 's1', 'Acme');
       INSERT INTO purchase_orders (id, store_id, supplier_id, po_number, status, received_at) VALUES ('po1', 's1', 'sup', 'PO-1', 'received', ${OCT28});
       INSERT INTO purchase_order_items (id, po_id, product_id, qty, qty_received, unit_cost, total) VALUES ('i1', 'po1', 'sku', 1, 1, 100, 100);`
      );
      r.op('journalPoReceive', { poId: 'po1' });
      expect(postedAt(r)).toEqual([OCT28]);
    });
  });

  describe('partial PO receipts (ACCT-AUDIT-1)', () => {
    const seed = (r: ReturnType<typeof rig>) =>
      r.raw.exec(
        `INSERT INTO suppliers (id, store_id, name) VALUES ('sup', 's1', 'Acme');
       INSERT INTO purchase_orders (id, store_id, supplier_id, po_number, status) VALUES ('po1', 's1', 'sup', 'PO-1', 'partial');
       INSERT INTO purchase_order_items (id, po_id, product_id, qty, qty_received, unit_cost, total) VALUES ('i1', 'po1', 'sku', 10, 4, 100, 1000);`
      );
    const invDebit = (r: ReturnType<typeof rig>) =>
      Number(
        r.q(
          `SELECT COALESCE(SUM(l.debit),0) t FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = '1200' AND l.ref_table = 'purchase_orders'`
        )[0].t
      );
    const apCredit = (r: ReturnType<typeof rig>) =>
      Number(
        r.q(
          `SELECT COALESCE(SUM(l.credit),0) t FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = '2000'`
        )[0].t
      );

    it('10 units x 100 received 4 then 6 post Inventory 1000 and AP 1000 (the later receipt is not dropped)', () => {
      const r = books();
      seed(r);
      expect(r.op('journalPoReceive', { poId: 'po1' })).toMatchObject({ posted: true, entries: 1 });
      expect(invDebit(r)).toBe(400);
      r.raw.exec(`UPDATE purchase_order_items SET qty_received = 10 WHERE id = 'i1'`);
      expect(r.op('journalPoReceive', { poId: 'po1' })).toMatchObject({ posted: true, entries: 1 });
      expect(invDebit(r)).toBe(1000);
      expect(apCredit(r)).toBe(1000);
      expect(tb(r).debit).toBe(tb(r).credit);
    });

    it('a replay of each pass posts nothing; three passes net to the received value', () => {
      const r = books();
      seed(r);
      r.op('journalPoReceive', { poId: 'po1' });
      expect(r.op('journalPoReceive', { poId: 'po1' })).toMatchObject({
        posted: false,
        entries: 0,
      });
      r.raw.exec(`UPDATE purchase_order_items SET qty_received = 7 WHERE id = 'i1'`);
      r.op('journalPoReceive', { poId: 'po1' });
      r.raw.exec(`UPDATE purchase_order_items SET qty_received = 10 WHERE id = 'i1'`);
      r.op('journalPoReceive', { poId: 'po1' });
      expect(r.op('journalPoReceive', { poId: 'po1' })).toMatchObject({
        posted: false,
        entries: 0,
      });
      expect(invDebit(r)).toBe(1000);
    });

    it('an old single-entry journal (sourceId = poId, cumulative) is counted: only the remainder posts', () => {
      const r = books();
      seed(r);
      r.raw.exec(
        `INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, source_id, status, created_at) VALUES ('je0', 's1', 'JE-0', 1, 'purchase_order', 'po1', 'posted', 1);
       INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, ref_table, ref_id, created_at) VALUES ('l1', 'je0', 'a1200', 400, 0, 'purchase_orders', 'po1', 1), ('l2', 'je0', 'a2000', 0, 400, 'purchase_orders', 'po1', 1);
       UPDATE purchase_order_items SET qty_received = 10 WHERE id = 'i1';`
      );
      expect(r.op('journalPoReceive', { poId: 'po1' })).toMatchObject({ posted: true, entries: 1 });
      expect(invDebit(r)).toBe(1000);
      expect(r.op('journalPoReceive', { poId: 'po1' })).toMatchObject({
        posted: false,
        entries: 0,
      });
    });
  });
});

describe('fan-out claims, markers and affiliate writes (Ruling CF-JOBS-4)', () => {
  function placed() {
    const r = rig();
    const o = r.order('cod');
    return { r, o };
  }

  it('orderNotifyClaim claims once', () => {
    const { r, o } = placed();
    expect(r.op('orderNotifyClaim', { orderId: o.orderId })).toEqual({ claimed: true });
    expect(r.op('orderNotifyClaim', { orderId: o.orderId })).toEqual({ claimed: false });
  });

  it('statusFanoutClaim / Complete: only the current status, only once, complete only after a claim', () => {
    const { r, o } = placed();
    r.raw.exec(
      `UPDATE orders SET status_fanout_requested_status = 'pending', status_fanout_requested_at = 5 WHERE id = '${o.orderId}'`
    );
    expect(r.op('statusFanoutComplete', { orderId: o.orderId, status: 'pending' })).toEqual({
      completed: false,
    });
    expect(r.op('statusFanoutClaim', { orderId: o.orderId, status: 'shipped' })).toEqual({
      claimed: false,
    });
    expect(r.op('statusFanoutClaim', { orderId: o.orderId, status: 'pending' })).toEqual({
      claimed: true,
    });
    expect(r.op('statusFanoutClaim', { orderId: o.orderId, status: 'pending' })).toEqual({
      claimed: false,
    });
    expect(r.op('statusFanoutComplete', { orderId: o.orderId, status: 'pending' })).toEqual({
      completed: true,
    });
    expect(r.op('statusFanoutComplete', { orderId: o.orderId, status: 'pending' })).toEqual({
      completed: false,
    });
  });

  it('markerClaim takes a marker once, markerRelease gives it back, a bad marker is refused', () => {
    const { r, o } = placed();
    expect(r.op('markerClaim', { orderId: o.orderId, marker: 'cancel_notified' })).toEqual({
      claimed: true,
    });
    expect(r.op('markerClaim', { orderId: o.orderId, marker: 'cancel_notified' })).toEqual({
      claimed: false,
    });
    expect(r.op('markerRelease', { orderId: o.orderId, marker: 'cancel_notified' })).toEqual({
      released: 1,
    });
    expect(r.op('markerClaim', { orderId: o.orderId, marker: 'cancel_notified' })).toEqual({
      claimed: true,
    });
    expect(r.code('markerClaim', { orderId: o.orderId, marker: "x'; DROP" })).toBe('BAD_ARGS/400');
  });

  it('refund notification: the first call takes every channel, a repeat none, a released e-mail comes back once', () => {
    const { r, o } = placed();
    expect(r.op('refundNotifyClaim', { orderId: o.orderId }).channels).toEqual([
      'email',
      'dispatch',
      'push',
    ]);
    expect(r.op('refundNotifyClaim', { orderId: o.orderId }).channels).toEqual([]);
    expect(r.op('refundNotifyRelease', { orderId: o.orderId, channel: 'email' }).released).toEqual([
      'email',
    ]);
    expect(r.op('refundNotifyClaim', { orderId: o.orderId }).channels).toEqual(['email']);
    expect(r.op('refundNotifyClaim', { orderId: o.orderId }).channels).toEqual([]);
  });

  it('reversalClaim stamps the order once (armed unless stock is restored); a return stamps its own row once', () => {
    const { r, o } = placed();
    expect(r.op('reversalClaim', { orderId: o.orderId, restoreInventory: false })).toEqual({
      claimed: true,
    });
    expect(r.op('reversalClaim', { orderId: o.orderId, restoreInventory: false })).toEqual({
      claimed: false,
    });
    expect(r.op('reversalClaim', { orderId: 'nope' })).toEqual({ claimed: false });
  });

  it('affiliate commission is claimed once, moves the balances, and its reversal puts them back once', () => {
    const { r, o } = placed();
    r.raw.exec(
      `INSERT INTO affiliates (id, store_id, name, email, referral_code, status) VALUES ('af1', 's1', 'Aff', 'a@example.test', 'CODE', 'active')`
    );
    r.raw.exec(
      `INSERT INTO affiliate_referrals (id, store_id, affiliate_id, order_id, referral_code, status, cookie_expires_at) VALUES ('rf1', 's1', 'af1', '${o.orderId}', 'CODE', 'converted', 9999999999999)`
    );
    expect(
      r.op('affiliateCommission', { referralId: 'rf1', commissionAmount: 250, rate: 10 })
    ).toEqual({ claimed: true });
    expect(
      r.op('affiliateCommission', { referralId: 'rf1', commissionAmount: 250, rate: 10 })
    ).toEqual({ claimed: false });
    expect(r.q('SELECT total_earned t, pending_balance p FROM affiliates')[0]).toEqual({
      t: 250,
      p: 250,
    });
    expect(r.op('affiliateReverse', { orderId: o.orderId })).toEqual({ amount: 250 });
    expect(r.op('affiliateReverse', { orderId: o.orderId })).toEqual({ amount: null });
    expect(r.q('SELECT total_earned t, pending_balance p FROM affiliates')[0]).toEqual({
      t: 0,
      p: 0,
    });
    expect(
      r.q('SELECT event_type e FROM affiliate_events ORDER BY occurred_at').map(x => x.e)
    ).toEqual(['commission_recorded', 'commission_reversed']);
  });
});
