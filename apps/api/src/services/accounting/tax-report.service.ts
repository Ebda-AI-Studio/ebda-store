import { prisma } from '@force/database';

/**
 * One transaction-level tax row.
 * All money fields are in FILS (integer — smallest KWD unit = 1/1000 KWD).
 */
export interface TaxReportRow {
  /** ISO date string of the journal posting (= order payment date) */
  date: string;
  orderNumber: string;
  /** Customer display name, or null for guest orders */
  customerName: string | null;
  /** Taxable base (subtotal − discount) in fils */
  subtotal: number;
  /** Applied tax rate as a percentage string, e.g. "5.00" */
  taxRate: string;
  /** Tax collected in fils — comes directly from account 2100 GL credits */
  taxCollected: number;
  /** Order total in fils */
  total: number;
}

export interface TaxRateSummary {
  /** Tax rate percentage string, e.g. "5.00" */
  taxRate: string;
  /** Number of transactions at this rate */
  transactionCount: number;
  /** Sum of taxable bases in fils */
  totalSubtotal: number;
  /** Sum of tax collected in fils */
  totalTaxCollected: number;
}

export interface TaxReportResult {
  from: Date;
  to: Date;
  /** Per-transaction rows, ordered by posting date */
  rows: TaxReportRow[];
  /** Totals */
  summary: {
    transactionCount: number;
    totalTaxableSales: number; // fils
    totalTaxCollected: number; // fils
    byRate: TaxRateSummary[];
  };
}

/**
 * Generate a transaction-level VAT / sales-tax report for a store.
 *
 * Data source:
 *   - `journal_lines` WHERE account.code = '2100' (Tax Payable)
 *     and the parent `journal_entry` was posted in [from, to]
 *   - Joined back to `orders` via journal_entry.source_id = order.id
 *     (order-posting sets source='order', sourceId=orderId)
 *   - Order fields used: orderNumber, subtotal, discount, tax (rate
 *     is back-computed as tax/taxable_base × 100 since the raw percentage
 *     is not stored on the order — mirrors what was stored in the journal).
 *
 * Read-only, tenant-scoped (storeId filter on both accounts and journal_entries).
 * Uses $queryRawUnsafe with explicit parameter binding — same pattern as
 * reports.service.ts trialBalance().
 *
 * Note: "taxRate" is derived from the order row rather than a TaxRate record
 * because (a) the journal only stores the computed fils amount, not the rate,
 * and (b) rate records can be edited/deleted after the fact. We derive the
 * effective rate as Math.round(taxCollected / taxableBase * 10000) / 100 and
 * represent as a fixed-2 string ("5.00", "0.00"). This is what appears on the
 * transaction rows and the by-rate breakdown.
 */
export async function generateTaxReport(
  storeId: string,
  { from, to }: { from: Date; to: Date }
): Promise<TaxReportResult> {
  /**
   * The query:
   *   - Finds all journal_lines whose account has code='2100' and belongs to this store
   *   - Joins the parent journal_entry (must be status='posted', postedAt in [from, to])
   *   - Joins orders via journal_entry.source_id = orders.id
   *     (only 'order'-source entries have an order reference)
   *   - Left-joins customers for display name
   * Returns one row per order that had tax posted in the period.
   * Filters out entries where source != 'order' (manual entries) — those
   * could have manual 2100 debits (reversals/adjustments) which are not
   * tax-collection events.
   */
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      posted_at: Date;
      order_number: string;
      customer_name: string | null;
      subtotal: bigint;
      discount: bigint;
      tax_collected: bigint;
      order_total: bigint;
    }>
  >(
    `
    SELECT
      e.posted_at,
      o.order_number,
      NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), '') AS customer_name,
      o.subtotal::bigint,
      o.discount::bigint,
      l.credit::bigint   AS tax_collected,
      o.total::bigint    AS order_total
    FROM public.journal_lines l
    JOIN public.accounts a
      ON a.id = l.account_id
      AND a.code = '2100'
      AND a.store_id = $1
    JOIN public.journal_entries e
      ON e.id = l.entry_id
      AND e.status = 'posted'
      AND e.source = 'order'
      AND e.posted_at >= $2
      AND e.posted_at <= $3
      AND e.store_id = $1
    JOIN public.orders o
      ON o.id = e.source_id
      AND o.store_id = $1
    LEFT JOIN public.customers c
      ON c.id = o.customer_id
    WHERE l.credit > 0
    ORDER BY e.posted_at ASC, o.order_number ASC
    `,
    storeId,
    from,
    to
  );

  // ─── Build per-transaction rows ──────────────────────────────────────────────
  const txRows: TaxReportRow[] = rows.map(r => {
    const taxCollected = Number(r.tax_collected);
    const subtotal = Number(r.subtotal);
    const discount = Number(r.discount);
    const taxableBase = subtotal - discount;

    // Derive effective rate. Avoid divide-by-zero: if taxableBase = 0 but
    // tax was somehow collected, show 0.00%.
    const effectiveRatePct =
      taxableBase > 0 ? Math.round((taxCollected / taxableBase) * 10000) / 100 : 0;

    return {
      date: r.posted_at.toISOString().slice(0, 10),
      orderNumber: r.order_number,
      customerName: r.customer_name ?? null,
      subtotal: taxableBase, // taxable base = subtotal - discount
      taxRate: effectiveRatePct.toFixed(2),
      taxCollected,
      total: Number(r.order_total),
    };
  });

  // ─── Build summary ───────────────────────────────────────────────────────────
  const totalTaxCollected = txRows.reduce((s, r) => s + r.taxCollected, 0);
  const totalTaxableSales = txRows.reduce((s, r) => s + r.subtotal, 0);

  // Group by effective tax rate
  const byRateMap = new Map<string, TaxRateSummary>();
  for (const row of txRows) {
    const existing = byRateMap.get(row.taxRate);
    if (existing) {
      existing.transactionCount += 1;
      existing.totalSubtotal += row.subtotal;
      existing.totalTaxCollected += row.taxCollected;
    } else {
      byRateMap.set(row.taxRate, {
        taxRate: row.taxRate,
        transactionCount: 1,
        totalSubtotal: row.subtotal,
        totalTaxCollected: row.taxCollected,
      });
    }
  }

  const byRate = Array.from(byRateMap.values()).sort(
    (a, b) => Number(b.taxRate) - Number(a.taxRate)
  );

  return {
    from,
    to,
    rows: txRows,
    summary: {
      transactionCount: txRows.length,
      totalTaxableSales,
      totalTaxCollected,
      byRate,
    },
  };
}
