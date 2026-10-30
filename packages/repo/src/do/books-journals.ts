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

export function journalExpenseOp(db: SyncSql, storeId: string, a: Record<string, unknown>): Out {
  const id = str(a.expenseId, 'expenseId');
  return db.transactionSync((): Out => {
    const e = db.all(
      'SELECT id, expense_number, status, total, expense_account_id, paid_from_account_id FROM expenses WHERE id = ? AND store_id = ?',
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
      'SELECT id, adjustment_number, type, status, total_value_impact FROM stock_adjustments WHERE id = ? AND store_id = ?',
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
      'SELECT id, po_number, ap_account_id FROM purchase_orders WHERE id = ? AND store_id = ?',
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
    if (received > 0) {
      const r = postEntry(db, {
        storeId,
        source: 'purchase_order',
        sourceId: poId,
        memo: `PO receive — ${poNumber}`,
        memoAr: `استلام أمر شراء — ${poNumber}`,
        lines: [
          jl(inventory, received, 0, `Inventory in (PO ${poNumber})`, 'purchase_orders', poId),
          jl(ap, 0, received, 'AP — supplier', 'purchase_orders', poId),
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
