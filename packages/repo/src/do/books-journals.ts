// The expense, stock-adjustment and purchase-order-receive journals on the StoreDO (INFRA-CF-1, Ruling CF-JOBS-4).
// Ports of apps/api/src/services/accounting/posting/{expense,stock-adjustment,po-receive}-posting.ts: each reads its source
// row, resolves the system accounts and posts through the same idempotent `postEntry` as the sale journal, in ONE section.
// A replay posts nothing (`(store_id, source, source_id)` identifies the entry).
import { MoneyError, type SyncSql } from './sync-sql';
import { postEntry, systemAccountId, type JournalLine } from './ledger';

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > 128)
    throw new MoneyError('BAD_ARGS', what, 400);
  return v;
};
const accountingOn = (db: SyncSql, storeId: string): boolean => {
  const cfg = db.all('SELECT accounting_enabled FROM store_config WHERE store_id = ?', [
    storeId,
  ])[0];
  return Boolean(cfg && cfg.accounting_enabled);
};

type Out = { posted: boolean; skipped?: string };

/** ACCT-AUDIT-3: a journal is dated by its document (an expense's own date, an adjustment's / receipt's post date), never
 *  later than now, so a late-posting job cannot move October's cost into November. Absent date -> now (postEntry's default). */
const docDate = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, Date.now()) : undefined;
};

export function journalExpenseOp(db: SyncSql, storeId: string, a: Record<string, unknown>): Out {
  const id = str(a.expenseId, 'expenseId');
  return db.transactionSync((): Out => {
    const e = db.all(
      'SELECT id, expense_number, status, total, expense_date, expense_account_id, paid_from_account_id FROM expenses WHERE id = ? AND store_id = ?',
      [id, storeId]
    )[0];
    if (!e) return { posted: false, skipped: 'expense_not_found' };
    if (!accountingOn(db, storeId)) return { posted: false, skipped: 'accounting_disabled' };
    if (e.status !== 'posted') return { posted: false, skipped: 'not_posted' };
    const total = e.total as number;
    if (total === 0) return { posted: false, skipped: 'zero_total' };
    const num = e.expense_number as string;
    const r = postEntry(db, {
      storeId,
      source: 'expense',
      sourceId: id,
      postedAt: docDate(e.expense_date),
      memo: `Expense — ${num}`,
      memoAr: `مصروف — ${num}`,
      lines: [
        {
          accountId: e.expense_account_id as string,
          debit: total,
          credit: 0,
          lineMemo: `Expense — ${num}`,
          refTable: 'expenses',
          refId: id,
        },
        {
          accountId: e.paid_from_account_id as string,
          debit: 0,
          credit: total,
          lineMemo: `Paid — ${num}`,
          refTable: 'expenses',
          refId: id,
        },
      ],
    });
    return { posted: r.created };
  });
}

const COUNTERPART_CODE: Record<string, string> = {
  cycle_count: '3000',
  damage: '5900',
  theft: '5910',
  loss: '5900',
  write_off: '5920',
  found: '3000',
  return_to_supplier: '2000',
};

export function journalStockAdjustmentOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): Out {
  const id = str(a.adjustmentId, 'adjustmentId');
  return db.transactionSync((): Out => {
    const adj = db.all(
      'SELECT id, adjustment_number, type, status, total_value_impact, posted_at FROM stock_adjustments WHERE id = ? AND store_id = ?',
      [id, storeId]
    )[0];
    if (!adj) return { posted: false, skipped: 'adjustment_not_found' };
    if (!accountingOn(db, storeId)) return { posted: false, skipped: 'accounting_disabled' };
    if (adj.status !== 'posted') return { posted: false, skipped: 'not_posted' };
    const impact = adj.total_value_impact as number;
    if (impact === 0) return { posted: false, skipped: 'zero_impact' };
    const type = adj.type as string;
    const num = adj.adjustment_number as string;
    const inventory = systemAccountId(db, storeId, '1200');
    const counterpart = systemAccountId(db, storeId, COUNTERPART_CODE[type] ?? '5990');
    const abs = Math.abs(impact);
    const line = (
      accountId: string,
      debit: number,
      credit: number,
      lineMemo: string
    ): JournalLine => ({
      accountId,
      debit,
      credit,
      lineMemo,
      refTable: 'stock_adjustments',
      refId: id,
    });
    const lines =
      impact > 0
        ? [
            line(inventory, abs, 0, `Inventory up — ${num}`),
            line(counterpart, 0, abs, `${type} — ${num}`),
          ]
        : [
            line(counterpart, abs, 0, `${type} — ${num}`),
            line(inventory, 0, abs, `Inventory down — ${num}`),
          ];
    const r = postEntry(db, {
      storeId,
      source: 'stock_adjustment',
      sourceId: id,
      postedAt: docDate(adj.posted_at),
      memo: `Stock adjustment — ${num}`,
      memoAr: `تسوية مخزون — ${num}`,
      lines,
    });
    return { posted: r.created };
  });
}

interface Cleared {
  backorderLineId: string;
  orderItemId: string;
  qty: number;
  actualUnitCost: number;
  estimateUnitCost: number;
  variance: number;
}

export function journalPoReceiveOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { posted: boolean; skipped?: string; entries: number } {
  const poId = str(a.poId, 'poId');
  const cleared = Array.isArray(a.clearedBackorders) ? (a.clearedBackorders as Cleared[]) : [];
  return db.transactionSync(() => {
    const po = db.all(
      'SELECT id, po_number, ap_account_id, received_at FROM purchase_orders WHERE id = ? AND store_id = ?',
      [poId, storeId]
    )[0];
    if (!po) return { posted: false, skipped: 'po_not_found', entries: 0 };
    if (!accountingOn(db, storeId))
      return { posted: false, skipped: 'accounting_disabled', entries: 0 };
    const inventory = systemAccountId(db, storeId, '1200');
    const ap = (po.ap_account_id as string | null) ?? systemAccountId(db, storeId, '2000');
    const cogs = systemAccountId(db, storeId, '5000');
    const cogsVariance = systemAccountId(db, storeId, '5010');
    const poNumber = po.po_number as string;
    let entries = 0;

    const received = Number(
      db.all(
        'SELECT COALESCE(SUM(qty_received * unit_cost), 0) AS t FROM purchase_order_items WHERE po_id = ?',
        [poId]
      )[0].t
    );
    const jl = (
      accountId: string,
      debit: number,
      credit: number,
      lineMemo: string,
      refTable: string,
      refId: string
    ): JournalLine => ({ accountId, debit, credit, lineMemo, refTable, refId });
    // ACCT-AUDIT-1: each receive pass posts only the DELTA over what this PO already booked to Inventory (the old single
    // entry keyed `poId` and the per-pass `poId:recv:<cumulative>` entries are both counted), keyed by the cumulative value so
    // a replay finds its own entry and a later pass is never dropped.
    const booked = Number(
      db.all(
        `SELECT COALESCE(SUM(l.debit), 0) AS t FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE e.store_id = ? AND e.source = 'purchase_order' AND e.status = 'posted'
           AND (e.source_id = ? OR e.source_id LIKE ?) AND l.account_id = ? AND l.ref_table = 'purchase_orders' AND l.ref_id = ?`,
        [storeId, poId, `${poId}:recv:%`, inventory, poId]
      )[0].t
    );
    const delta = received - booked;
    if (delta > 0) {
      const r = postEntry(db, {
        storeId,
        source: 'purchase_order',
        sourceId: `${poId}:recv:${received}`,
        postedAt: docDate(po.received_at),
        memo: `PO receive — ${poNumber}`,
        memoAr: `استلام أمر شراء — ${poNumber}`,
        lines: [
          jl(inventory, delta, 0, `Inventory in (PO ${poNumber})`, 'purchase_orders', poId),
          jl(ap, 0, delta, 'AP — supplier', 'purchase_orders', poId),
        ],
      });
      if (r.created) entries++;
    }
    for (const c of cleared) {
      const amount = c.actualUnitCost * c.qty;
      if (!(amount > 0)) continue;
      const ref = c.backorderLineId;
      const lines: JournalLine[] = [
        jl(cogs, amount, 0, `Deferred COGS (backorder ${ref.slice(0, 8)})`, 'backorder_lines', ref),
        jl(inventory, 0, amount, 'Inventory out (deferred)', 'backorder_lines', ref),
      ];
      if (c.variance > 0) {
        lines.push(
          jl(
            cogsVariance,
            c.variance,
            0,
            'COGS variance (actual > estimate)',
            'backorder_lines',
            ref
          ),
          jl(inventory, 0, c.variance, 'Variance contra-inventory', 'backorder_lines', ref)
        );
      } else if (c.variance < 0) {
        const p = Math.abs(c.variance);
        lines.push(
          jl(inventory, p, 0, 'Variance contra-inventory', 'backorder_lines', ref),
          jl(cogsVariance, 0, p, 'COGS variance (actual < estimate)', 'backorder_lines', ref)
        );
      }
      const r = postEntry(db, {
        storeId,
        source: 'purchase_order',
        sourceId: `bo:${ref}:cogs`,
        memo: `Deferred COGS — backorder fulfilled by ${poNumber}`,
        memoAr: `تكلفة بضاعة مؤجلة — تم تنفيذ الطلب المعلق بـ ${poNumber}`,
        lines,
      });
      if (r.created) entries++;
    }
    return { posted: entries > 0, entries };
  });
}

/**
 * ACCT-AUDIT-5: the safety net for a lost posting trigger (a swallowed `inngest.send`, a feature switched off then on). Finds
 * the POSTED expenses and stock adjustments with no journal entry and every PO that has received lines, and runs the same
 * idempotent journal ops over them, so a replay (or a second night) posts nothing. `includeExpenses: false` keeps expenses
 * out for a store whose `accounting.expenses` feature is off. Bounded per run.
 */
export function journalRepostMissingOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { expenses: number; stockAdjustments: number; purchaseOrders: number } {
  const LIMIT = 200;
  const out = { expenses: 0, stockAdjustments: 0, purchaseOrders: 0 };
  if (a.includeExpenses !== false) {
    const rows = db.all(
      `SELECT x.id FROM expenses x WHERE x.store_id = ? AND x.status = 'posted' AND x.total <> 0
         AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.store_id = x.store_id AND e.source = 'expense' AND e.source_id = x.id)
       ORDER BY x.expense_date LIMIT ${LIMIT}`,
      [storeId]
    );
    for (const r of rows)
      if (journalExpenseOp(db, storeId, { expenseId: r.id }).posted) out.expenses++;
  }
  const adj = db.all(
    `SELECT s.id FROM stock_adjustments s WHERE s.store_id = ? AND s.status = 'posted' AND s.total_value_impact <> 0
       AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.store_id = s.store_id AND e.source = 'stock_adjustment' AND e.source_id = s.id)
     LIMIT ${LIMIT}`,
    [storeId]
  );
  for (const r of adj)
    if (journalStockAdjustmentOp(db, storeId, { adjustmentId: r.id }).posted)
      out.stockAdjustments++;
  const pos = db.all(
    `SELECT p.id FROM purchase_orders p WHERE p.store_id = ?
       AND EXISTS (SELECT 1 FROM purchase_order_items i WHERE i.po_id = p.id AND i.qty_received > 0) LIMIT ${LIMIT * 5}`,
    [storeId]
  );
  for (const r of pos)
    if (journalPoReceiveOp(db, storeId, { poId: r.id }).posted) out.purchaseOrders++;
  return out;
}
