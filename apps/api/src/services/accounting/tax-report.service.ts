import { prisma } from '@ebda/database';
import { storeMoney } from '../../lib/repo-factory';
import { DEFAULT_STORE_TIME_ZONE, zonedIsoDay } from '@ebda/shared';

/**
 * One transaction-level tax row — one row per order-source journal entry
 * that moved Tax Payable (2100) in the period: the sale, and any
 * refund/return reversal or partial-return adjustment. Reversal rows carry
 * NEGATIVE amounts, so the summary nets to what the merchant actually owes.
 * All money fields are in PIASTRES (integer — 1 piastre = 1/100 EGP).
 */
export interface TaxReportRow {
  /**
   * `sale` — the order's own sale entry (sourceId = the order id).
   * `reversal` — a full refund reversal, a partial-return adjustment, or a
   * reversal of one of those (sourceId = `<orderId>:…`). One order can show
   * several rows with the same order number; this says which is which (#1253).
   */
  kind: 'sale' | 'reversal';
  /**
   * `YYYY-MM-DD` of the journal posting (= order payment / reversal date) as a
   * calendar day in the STORE's time zone — the same day the period bounds
   * were resolved in (owner decision 2026-10-01).
   */
  date: string;
  orderNumber: string;
  /** Customer display name, or null for guest orders */
  customerName: string | null;
  /**
   * Taxable-base movement of this entry in piastres — the entry's net Sales
   * Revenue (4000) credit. Positive on the sale (= subtotal − discount),
   * negative on a refund reversal or partial-return adjustment.
   */
  subtotal: number;
  /** Applied tax rate as a percentage string, e.g. "5.00" */
  taxRate: string;
  /**
   * Tax movement of this entry in piastres — the entry's net Tax Payable (2100)
   * credit. Positive on the sale, negative on a reversal/adjustment.
   */
  taxCollected: number;
  /**
   * Order total in piastres on the SALE row only; null on a reversal row, so the
   * column sums to each order's value once instead of once per entry (#1253).
   */
  total: number | null;
}

export interface TaxRateSummary {
  /** Tax rate percentage string, e.g. "5.00" */
  taxRate: string;
  /** Number of tax-moving journal ENTRIES at this rate (reversals included), not orders */
  transactionCount: number;
  /** Net taxable-base movement in piastres (reversals subtract) */
  totalSubtotal: number;
  /** Net tax collected in piastres (reversals subtract) */
  totalTaxCollected: number;
}

export interface TaxReportResult {
  from: Date;
  to: Date;
  /** Per-transaction rows, ordered by posting date */
  rows: TaxReportRow[];
  /** Totals */
  summary: {
    /** Journal entries in the period (sales + reversals/adjustments), not orders */
    transactionCount: number;
    /** Distinct orders those entries belong to (#1208) */
    orderCount: number;
    /** NET taxable sales in piastres — sales minus refund/return reversals */
    totalTaxableSales: number;
    /** NET tax collected in piastres — sales minus refund/return reversals */
    totalTaxCollected: number;
    /** Input VAT claimed on purchases / expenses in the period (account 1300), piastres (ACCT-AUDIT-10) */
    totalInputTax: number;
    /** What the return owes: output tax collected minus input tax claimed, piastres (negative = refundable) */
    netTaxPayable: number;
    byRate: TaxRateSummary[];
  };
}

/** The standard Egyptian VAT rates a derived rate may snap to (percent). */
const STANDARD_RATES_PCT = [0, 5, 10, 14];

/**
 * Derive the entry's effective rate and snap it to a standard rate when the piastre rounding of the tax explains the gap
 * (a 33.33 base at 14% taxes 4.67, which reads back as 14.01), so rounding never spawns its own bucket. A blended basket
 * (a 14% line with an exempt line) matches no standard rate within one piastre and keeps its blended rate: the order lines
 * carry no per-line rate, so that split needs a schema change (ACCT-AUDIT-10 residual).
 */
function effectiveRatePct(tax: number, base: number): number {
  if (base === 0) return 0;
  for (const r of STANDARD_RATES_PCT) {
    if (Math.abs(tax - Math.round((base * r) / 100)) <= 1) return r;
  }
  return Math.round((tax / base) * 10000) / 100;
}

/**
 * Generate a transaction-level VAT / sales-tax report for a store.
 *
 * Data source — GL movement on Tax Payable (2100), per journal entry:
 *   - Every `source='order'` journal entry in [from, to] whose lines move
 *     account 2100: the sale entry AND every reversal/adjustment — full
 *     refund reversals (`:reversal`) and partial-return pro-rata
 *     adjustments (`:partial:<returnId>`). Reversals DEBIT 2100, so their
 *     rows carry negative amounts and the summary nets to what is actually
 *     owed. Before this (audit issue 1188) the report joined
 *     `source_id = orders.id` and kept only `credit > 0` lines, so refund
 *     and partial-return tax reversals were invisible and the filed VAT
 *     over-declared; a fully-refunded sale even vanished retroactively
 *     (status='posted' filter) instead of showing the reversal in ITS
 *     period.
 *   - Entries with status 'posted' OR 'reversed' both count: a reversal is
 *     modelled by its own mirror entry, so both the original and the mirror
 *     stand, each attributed to the period it posted in — period totals are
 *     immutable once filed.
 *   - The order is resolved by stripping the sourceId suffix
 *     (`split_part(source_id, ':', 1)` — order-posting/refund-posting/
 *     partial-return-posting all prefix sourceId with the order id).
 *   - The taxable-base movement comes from the SAME entry's Sales Revenue
 *     (4000) lines, so a reversal row's rate is computed from its own
 *     netted pair (both negative → positive rate), never a netted figure
 *     against the gross order base.
 *
 * Read-only, tenant-scoped (storeId filter on accounts, journal_entries and
 * orders). Uses $queryRawUnsafe with explicit parameter binding — same
 * pattern as reports.service.ts trialBalance().
 *
 * Note: "taxRate" is derived per entry rather than from a TaxRate record
 * because (a) the journal only stores the computed piastres amount, not the rate,
 * and (b) rate records can be edited/deleted after the fact. We derive the
 * effective rate as Math.round(taxDelta / baseDelta * 10000) / 100 and
 * represent as a fixed-2 string ("5.00", "0.00"). This is what appears on the
 * transaction rows and the by-rate breakdown. (A partial-return adjustment's
 * rate matches the sale's up to piastres-level rounding of the pro-rata split, so
 * rows group under the same rate bucket in practice.)
 */
export async function generateTaxReport(
  storeId: string,
  {
    from,
    to,
    timeZone = DEFAULT_STORE_TIME_ZONE,
  }: { from: Date; to: Date; /** IANA zone row dates are labelled in */ timeZone?: string }
): Promise<TaxReportResult> {
  /**
   * The query:
   *   - Aggregates journal_lines per journal ENTRY over accounts 2100 (tax)
   *     and 4000 (revenue) for this store
   *   - Entry must be source='order', status posted/reversed, postedAt in
   *     [from, to]
   *   - Joins orders via split_part(e.source_id, ':', 1) = orders.id — the
   *     order id prefix shared by the sale, its reversal, and every
   *     partial-return adjustment
   *   - Left-joins users for display name (orders.customer_id references
   *     users.id — the previous join against `customers` never matched)
   *   - HAVING keeps only entries that actually moved 2100
   * Returns one row per tax-moving journal entry in the period.
   * Entries with source != 'order' (manual entries) are excluded — manual
   * 2100 movement is not an order tax-collection event.
   */
  type TaxLine = {
    posted_at: Date;
    order_number: string;
    customer_name: string | null;
    tax_delta: bigint | number;
    base_delta: bigint | number;
    order_total: bigint | number;
    is_sale: boolean;
  };
  // NEON-ZERO (Ruling NZ-ACCT-1): a store on its Durable Object reads the SQLite twin of this query there.
  const money = await storeMoney(storeId);
  const rows: TaxLine[] = money
    ? (await money.taxReportLines({ fromMs: from.getTime(), toMs: to.getTime() })).map(r => ({
        posted_at: new Date(r.postedAtMs),
        order_number: r.orderNumber,
        customer_name: r.customerName,
        tax_delta: r.taxDelta,
        base_delta: r.baseDelta,
        order_total: r.orderTotal,
        is_sale: r.isSale,
      }))
    : await prisma.$queryRawUnsafe<
        Array<{
          posted_at: Date;
          order_number: string;
          customer_name: string | null;
          tax_delta: bigint;
          base_delta: bigint;
          order_total: bigint;
          is_sale: boolean;
        }>
      >(
        `
    SELECT
      e.posted_at,
      o.order_number,
      NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS customer_name,
      COALESCE(SUM(CASE WHEN a.code = '2100' THEN l.credit - l.debit ELSE 0 END), 0)::bigint AS tax_delta,
      COALESCE(SUM(CASE WHEN a.code = '4000' THEN l.credit - l.debit ELSE 0 END), 0)::bigint AS base_delta,
      o.total::bigint AS order_total,
      (e.source_id = o.id) AS is_sale
    FROM public.journal_entries e
    JOIN public.journal_lines l
      ON l.entry_id = e.id
    JOIN public.accounts a
      ON a.id = l.account_id
      AND a.code IN ('2100', '4000')
      AND a.store_id = $1
    JOIN public.orders o
      ON o.id = split_part(e.source_id, ':', 1)
      AND o.store_id = $1
    LEFT JOIN public.users u
      ON u.id = o.customer_id
    WHERE e.source = 'order'
      AND e.status IN ('posted', 'reversed')
      AND e.posted_at >= $2::timestamp
      AND e.posted_at <= $3::timestamp
      AND e.store_id = $1
    GROUP BY e.id, e.posted_at, e.source_id, o.id, o.order_number, o.total, u.first_name, u.last_name
    HAVING SUM(CASE WHEN a.code = '2100' THEN l.credit - l.debit ELSE 0 END) <> 0
    ORDER BY e.posted_at ASC, o.order_number ASC
    `,
        storeId,
        // Prisma 6.19 $queryRawUnsafe rejects JS Date objects — pass ISO strings.
        // `posted_at` is `timestamp without time zone`, so the SQL casts the
        // string params with `$n::timestamp` (no `timestamp >= text` operator).
        from.toISOString(),
        to.toISOString()
      );

  // ─── Build per-transaction rows ──────────────────────────────────────────────
  const txRows: TaxReportRow[] = rows.map(r => {
    const taxCollected = Number(r.tax_delta);
    const taxableBase = Number(r.base_delta);

    // Derive effective rate from the entry's OWN tax/base pair — a reversal
    // row's negatives cancel, giving the same positive rate as its sale.
    // Avoid divide-by-zero: if the base is 0 but tax moved, show 0.00%.
    const ratePct = effectiveRatePct(taxCollected, taxableBase);

    return {
      kind: r.is_sale ? 'sale' : 'reversal',
      date: zonedIsoDay(r.posted_at, timeZone),
      orderNumber: r.order_number,
      customerName: r.customer_name ?? null,
      subtotal: taxableBase,
      taxRate: ratePct.toFixed(2),
      taxCollected,
      total: r.is_sale ? Number(r.order_total) : null,
    };
  });

  // ─── Input VAT claimed on purchases (account 1300) ───────────────────────────
  const inputTax = money
    ? (await money.taxInputTotal({ fromMs: from.getTime(), toMs: to.getTime() })).inputTax
    : Number(
        (
          await prisma.$queryRawUnsafe<Array<{ t: bigint }>>(
            `SELECT COALESCE(SUM(l.debit - l.credit), 0)::bigint AS t
               FROM public.journal_lines l
               JOIN public.journal_entries e ON e.id = l.entry_id
               JOIN public.accounts a ON a.id = l.account_id AND a.store_id = $1
              WHERE e.store_id = $1 AND a.code = '1300' AND e.status IN ('posted', 'reversed')
                AND e.posted_at >= $2::timestamp AND e.posted_at <= $3::timestamp`,
            storeId,
            from.toISOString(),
            to.toISOString()
          )
        )?.[0]?.t ?? 0
      );

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
      orderCount: new Set(txRows.map(r => r.orderNumber)).size,
      totalTaxableSales,
      totalTaxCollected,
      totalInputTax: inputTax,
      netTaxPayable: totalTaxCollected - inputTax,
      byRate,
    },
  };
}
