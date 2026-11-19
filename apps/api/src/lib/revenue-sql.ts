/**
 * THE revenue definition (finding STORE-QA-7). Every revenue / cash-in / AOV / "paid" aggregation over `orders` -
 * Postgres raw SQL, Prisma wheres, and the StoreDO SQLite twins - builds its population and its amount from THIS
 * module, so a refund can never be counted as sales on one screen and removed on another.
 * MONEY: integer piastres.
 * The same file lives in apps/api/src/lib/revenue-sql.ts (the API must not import packages/repo statically);
 * tests/unit/revenue-definition.test.ts keeps the two byte-equal.
 *
 * Definition
 *   - An order COUNTS when its status is not in NON_REVENUE_ORDER_STATUSES (cancelled, refunded, awaiting
 *     InstaPay confirmation) AND its payment_status is not in NON_REVENUE_PAYMENT_STATUSES (failed, refunded).
 *     The payment_status half matters: a full return completed by a manual method leaves the order `delivered`
 *     while its payment is `refunded` (STORE-QA-7: delivered + refunded counted as 4850 revenue).
 *   - An order's NET amount is total - refunded, where refunded = LEAST(total, GREATEST(sum of its COMPLETED
 *     non-exchange returns' refund_amount, sum of its payments.refunded_amount)). GREATEST, not +, because a
 *     return refunded to the original method is mirrored on payments.refunded_amount (one refund, two records).
 *   - "Paid" surfaces (rollups, usage snapshot, funnel) add payment_status = 'paid' on top.
 */

/**
 * Order statuses that are not sales: cancelled, refunded, or InstaPay money not yet confirmed. Canonical here (packages/repo
 * cannot import @ebda/shared); `@ebda/shared` NON_REVENUE_ORDER_STATUSES must equal it - guarded by revenue-definition.test.ts.
 */
export const NON_REVENUE_ORDER_STATUSES = [
  'cancelled',
  'refunded',
  'awaiting_payment_confirmation',
] as const;

/** Payment states whose order money is not (or no longer) sales revenue. */
export const NON_REVENUE_PAYMENT_STATUSES = ['failed', 'refunded'] as const;

export type RevenueSqlDialect = 'pg' | 'sqlite';

const lit = (xs: readonly string[]): string => xs.map(x => `'${x}'`).join(', ');

/** `<a>.status NOT IN (...) AND <a>.payment_status NOT IN (...)`: the order counts as revenue. */
export function revenueOrderPredicateSql(alias = 'o', opts: { paidOnly?: boolean } = {}): string {
  const base = `${alias}.status NOT IN (${lit(NON_REVENUE_ORDER_STATUSES)}) AND ${alias}.payment_status NOT IN (${lit(NON_REVENUE_PAYMENT_STATUSES)})`;
  return opts.paidOnly ? `${base} AND ${alias}.payment_status = 'paid'` : base;
}

/** Scalar SQL: the piastres of order `<alias>` already refunded (partial or full), capped at its total. */
// pq-allow(duplicate-helper): twin of packages/repo/src/revenue.ts; API cannot import packages/repo; equality enforced by tests/unit/revenue-definition.test.ts
export function orderRefundedMinorSql(alias: string, dialect: RevenueSqlDialect): string {
  const t = (n: string) => (dialect === 'pg' ? `public.${n}` : n);
  const [least, greatest] = dialect === 'pg' ? ['LEAST', 'GREATEST'] : ['MIN', 'MAX'];
  return `${least}(${alias}.total, ${greatest}(
    COALESCE((SELECT SUM(rt.refund_amount) FROM ${t('returns')} rt WHERE rt.order_id = ${alias}.id AND rt.status = 'completed' AND rt.type <> 'exchange'), 0),
    COALESCE((SELECT SUM(pm.refunded_amount) FROM ${t('payments')} pm WHERE pm.order_id = ${alias}.id), 0)))`;
}

/** Scalar SQL: order `<alias>`'s net revenue (total minus what was refunded). */
export function orderNetRevenueSql(alias: string, dialect: RevenueSqlDialect): string {
  return `(${alias}.total - ${orderRefundedMinorSql(alias, dialect)})`;
}

/** Pure twin of the SQL above, for code that already holds the rows. */
export function netOrderRevenueMinor(o: {
  total: number;
  status: string;
  paymentStatus: string;
  refundedMinor?: number;
}): number {
  if ((NON_REVENUE_ORDER_STATUSES as readonly string[]).includes(o.status)) return 0;
  if ((NON_REVENUE_PAYMENT_STATUSES as readonly string[]).includes(o.paymentStatus)) return 0;
  return o.total - Math.min(o.total, Math.max(0, o.refundedMinor ?? 0));
}

/**
 * Per-LINE net revenue (top products / categories / price source). A partial refund is order-level money; it is allocated to
 * the order's lines pro rata by line total, with cumulative rounding (largest-remainder style) so the lines' net adds back to
 * the order's net exactly. Integer maths only (works on Postgres and SQLite): alloc_i = round(R*cum_i/T) - round(R*cum_(i-1)/T).
 *
 * Usage: `FROM ${head}${inner} WHERE <order filter, params> ${tail}` where `inner` is `netLinesInnerSql(dialect)`; the result
 * exposes l.id, l.order_id, l.product_id, l.quantity, l.price_source, l.price_group_applied and net_total.
 * The WHERE must select WHOLE orders (it filters on the order, never on a line) so the window sums see every line.
 */
// pq-allow(duplicate-helper): twin of packages/repo/src/revenue.ts; API cannot import packages/repo; equality enforced by tests/unit/revenue-definition.test.ts
export function netLinesInnerSql(dialect: RevenueSqlDialect): string {
  return `SELECT oi.id, oi.order_id, oi.product_id, oi.quantity, oi.price_source, oi.price_group_applied, oi.total,
       ${orderRefundedMinorSql('o', dialect)} AS ref_minor,
       SUM(oi.total) OVER (PARTITION BY oi.order_id) AS line_sum,
       SUM(oi.total) OVER (PARTITION BY oi.order_id ORDER BY oi.id) AS cum
     FROM ${dialect === 'pg' ? 'public.order_items' : 'order_items'} oi
     JOIN ${dialect === 'pg' ? 'public.orders' : 'orders'} o ON o.id = oi.order_id`;
}

export function netLinesWrapSql(dialect: RevenueSqlDialect): { head: string; tail: string } {
  // The refund is capped at orders.total (shipping included, net of discounts) but allocated over the LINES, so cap it at
  // line_sum too: a line's net is never below 0 and the lines never go below 0 in total.
  const cap = dialect === 'pg' ? 'LEAST(l.ref_minor, l.line_sum)' : 'MIN(l.ref_minor, l.line_sum)';
  const alloc = (cum: string) => `(2 * ${cap} * ${cum} + l.line_sum) / (2 * l.line_sum)`;
  return {
    head: `(SELECT l.id, l.order_id, l.product_id, l.quantity, l.price_source, l.price_group_applied,
       l.total - CASE WHEN l.ref_minor = 0 OR l.line_sum = 0 THEN 0
                      ELSE ${alloc('l.cum')} - ${alloc('(l.cum - l.total)')} END AS net_total
     FROM (`,
    tail: `) l) l`,
  };
}

/** Pure twin of the line allocation, for tests and for code that already holds an order's lines. */
// pq-allow(duplicate-helper): twin of packages/repo/src/revenue.ts; API cannot import packages/repo; equality enforced by tests/unit/revenue-definition.test.ts
export function allocateRefundToLines(lineTotals: number[], refundedMinor: number): number[] {
  const sum = lineTotals.reduce((a, b) => a + b, 0);
  if (refundedMinor <= 0 || sum <= 0) return lineTotals.slice();
  refundedMinor = Math.min(refundedMinor, sum); // same cap as the SQL: never below 0 in total
  let cum = 0;
  let prev = 0;
  return lineTotals.map(t => {
    cum += t;
    const at = Math.floor((2 * refundedMinor * cum + sum) / (2 * sum));
    const alloc = at - prev;
    prev = at;
    return t - alloc;
  });
}
