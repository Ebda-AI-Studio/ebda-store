// Merchant analytics reads on the StoreDO (Ruling NZ-AN-1 follow-up, NZ-INTEG-1). The Postgres twins in
// apps/api/src/services/analytics.service.ts are raw SQL aggregates (distinct customer keys, profit lines, date_trunc buckets,
// the on-hand twin); each op here is the SQLite spelling of ONE of them, scoped by the `store_id` the DO holds. All are reads.
import { MoneyError, type SyncSql } from './sync-sql';
import {
  netLinesInnerSql,
  netLinesWrapSql,
  orderNetRevenueSql,
  refundJoinsSql,
  revenueOrderPredicateSql,
} from '../revenue';

const intArg = (v: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new MoneyError('BAD_ARGS', what, 400);
  return v;
};
const statuses = (v: unknown): string[] => {
  if (!Array.isArray(v) || v.length > 20 || v.some(x => typeof x !== 'string' || x.length > 64))
    throw new MoneyError('BAD_ARGS', 'nonRevenue', 400);
  return v as string[];
};
const marks = (n: number, from = 1): string =>
  Array.from({ length: n }, (_, i) => `?${from + i}`).join(', ');

const num = (v: unknown): number => Number(v ?? 0);

/** getPeriodStats: revenue + order count + profit lines (distinct customers: `analyticsBuyerIdentities`, grouped by the API) for [start, end]. */
export function analyticsPeriodOp(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const start = intArg(a.startMs, 'startMs');
  const end = intArg(a.endMs, 'endMs');
  statuses(a.nonRevenue); // validated, not trusted: the population is the ONE revenue definition (../revenue.ts)
  const win = [storeId, start, end];
  const counts = revenueOrderPredicateSql('o', 'sqlite');
  const agg = db.all(
    `SELECT COALESCE(SUM(${orderNetRevenueSql('o', 'sqlite')}), 0) AS revenue, COUNT(*) AS orders FROM orders o
      ${refundJoinsSql('o', 'sqlite')}
      WHERE o.store_id = ?1 AND o.deleted_at IS NULL AND o.created_at >= ?2 AND o.created_at <= ?3
        AND ${counts}`,
    win
  )[0] as Record<string, unknown>;
  const p = db.all(
    `SELECT
        SUM(CASE WHEN oi.cost_price IS NOT NULL THEN (oi.price - oi.cost_price) * oi.quantity END) AS profit,
        SUM(CASE WHEN oi.cost_price IS NOT NULL THEN 1 ELSE 0 END) AS costed_lines,
        SUM(CASE WHEN oi.cost_price IS NULL THEN 1 ELSE 0 END) AS missing_lines,
        SUM(CASE WHEN oi.cost_price IS NULL THEN oi.price * oi.quantity END) AS missing_revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.store_id = ?1 AND o.deleted_at IS NULL AND o.created_at >= ?2 AND o.created_at <= ?3
        AND ${counts}`,
    win
  )[0] as Record<string, unknown>;
  return {
    revenue: num(agg.revenue),
    orders: num(agg.orders),
    profit: p.profit === null || p.profit === undefined ? null : num(p.profit),
    costedLines: num(p.costed_lines),
    missingLines: num(p.missing_lines),
    missingRevenue: num(p.missing_revenue),
  };
}

/** getSalesChart: revenue + order count per bucket in the viewer's shifted clock. Keys are YYYY-MM-DD (day, week = Monday) or YYYY-MM. */
export function analyticsSalesOp(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const start = intArg(a.startMs, 'startMs');
  const end = intArg(a.endMs, 'endMs');
  const offset = intArg(a.offsetMinutes, 'offsetMinutes', -840, 840);
  const g = a.granularity;
  if (g !== 'day' && g !== 'week' && g !== 'month')
    throw new MoneyError('BAD_ARGS', 'granularity', 400);
  const sec = `((o.created_at + ?4 * 60000) / 1000)`;
  const key =
    g === 'day'
      ? `strftime('%Y-%m-%d', ${sec}, 'unixepoch')`
      : g === 'month'
        ? `strftime('%Y-%m', ${sec}, 'unixepoch')`
        : `date(${sec}, 'unixepoch', '-' || ((CAST(strftime('%w', ${sec}, 'unixepoch') AS INTEGER) + 6) % 7) || ' days')`;
  const rows = db.all(
    `SELECT ${key} AS k, COALESCE(SUM(${orderNetRevenueSql('o', 'sqlite')}), 0) AS revenue, COUNT(*) AS orders FROM orders o
      ${refundJoinsSql('o', 'sqlite')}
      WHERE o.store_id = ?1 AND o.created_at >= ?2 AND o.created_at <= ?3
        AND ${revenueOrderPredicateSql('o', 'sqlite')}
      GROUP BY k ORDER BY k ASC`,
    [storeId, start, end, offset]
  );
  return rows.map(r => ({ key: String(r.k), revenue: num(r.revenue), orders: num(r.orders) }));
}

/** Order lines of revenue-population orders grouped by product (top products / categories) or by price source. */
export function analyticsItemsOp(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const start = intArg(a.startMs, 'startMs');
  const end = intArg(a.endMs, 'endMs');
  statuses(a.nonRevenue);
  // Line revenue (REVENUE-DEF-1): whole-order exclusions, and a partial refund allocated to the lines pro rata (revenue.ts).
  const wrap = netLinesWrapSql('sqlite');
  const base = `FROM ${wrap.head}${netLinesInnerSql('sqlite')}
      WHERE o.store_id = ?1 AND o.created_at >= ?2 AND o.created_at <= ?3
        AND ${revenueOrderPredicateSql('o', 'sqlite')}${wrap.tail}`;
  const params = [storeId, start, end];
  if (a.by === 'priceSource') {
    return db
      .all(
        `SELECT l.price_source AS priceSource, l.price_group_applied AS priceGroupApplied,
                COALESCE(SUM(l.quantity), 0) AS quantity, COALESCE(SUM(l.net_total), 0) AS total ${base}
          GROUP BY l.price_source, l.price_group_applied`,
        params
      )
      .map(r => ({
        priceSource: (r.priceSource as string | null) ?? null,
        priceGroupApplied: r.priceGroupApplied === null ? null : Boolean(r.priceGroupApplied),
        quantity: num(r.quantity),
        total: num(r.total),
      }));
  }
  if (a.by !== 'product') throw new MoneyError('BAD_ARGS', 'by', 400);
  const limit = a.limit === undefined ? null : intArg(a.limit, 'limit', 1, 1000);
  return db
    .all(
      `SELECT l.product_id AS productId, COALESCE(SUM(l.quantity), 0) AS quantity, COALESCE(SUM(l.net_total), 0) AS total ${base}
        GROUP BY l.product_id ORDER BY total DESC, l.product_id ASC${limit ? ` LIMIT ${limit}` : ''}`,
      params
    )
    .map(r => ({ productId: String(r.productId), quantity: num(r.quantity), total: num(r.total) }));
}

/** Orders grouped by `status` (not deleted, window) or by `paymentStatus` (revenue statuses only, failed payments included). */
export function analyticsOrdersByOp(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const start = intArg(a.startMs, 'startMs');
  const end = intArg(a.endMs, 'endMs');
  if (a.by === 'status')
    return db
      .all(
        `SELECT status AS k, COUNT(*) AS count, 0 AS total FROM orders
          WHERE store_id = ?1 AND deleted_at IS NULL AND created_at >= ?2 AND created_at <= ?3 GROUP BY status`,
        [storeId, start, end]
      )
      .map(r => ({ key: String(r.k), count: num(r.count), total: 0 }));
  if (a.by !== 'paymentStatus') throw new MoneyError('BAD_ARGS', 'by', 400);
  const nonRev = statuses(a.nonRevenue);
  return db
    .all(
      `SELECT payment_status AS k, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total FROM orders
        WHERE store_id = ?1 AND deleted_at IS NULL AND created_at >= ?2 AND created_at <= ?3
          AND status NOT IN (${marks(nonRev.length, 4)}) GROUP BY payment_status`,
      [storeId, start, end, ...nonRev]
    )
    .map(r => ({ key: String(r.k), count: num(r.count), total: num(r.total) }));
}

/** getCustomerStats: first-time and returning buyers of the window, and the top spenders by customer id. */
export function analyticsCustomersOp(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const start = intArg(a.startMs, 'startMs');
  const end = intArg(a.endMs, 'endMs');
  statuses(a.nonRevenue);
  const one = (sql: string, p: unknown[]): number =>
    num((db.all(sql, p)[0] as Record<string, unknown>).n);
  // A DO order's `customer_id` is the platform user id (the same id the Postgres `users` row had), so first-time / returning
  // buyers are counted over the orders, exactly as the Postgres query counts users that have orders.
  const inWindow = `o.store_id = ?1 AND o.customer_id IS NOT NULL AND o.created_at >= ?2 AND o.created_at <= ?3`;
  const earlier = `EXISTS (SELECT 1 FROM orders e WHERE e.store_id = ?1 AND e.customer_id = o.customer_id AND e.created_at < ?2)`;
  const newCustomers = one(
    `SELECT COUNT(DISTINCT o.customer_id) AS n FROM orders o WHERE ${inWindow} AND NOT ${earlier}`,
    [storeId, start, end]
  );
  const returningCustomers = one(
    `SELECT COUNT(DISTINCT o.customer_id) AS n FROM orders o WHERE ${inWindow} AND ${earlier}`,
    [storeId, start, end]
  );
  const top = db
    .all(
      `SELECT o.customer_id AS customerId, COALESCE(SUM(${orderNetRevenueSql('o', 'sqlite')}), 0) AS total, COUNT(*) AS count FROM orders o
      ${refundJoinsSql('o', 'sqlite')}
        WHERE o.store_id = ?1 AND o.deleted_at IS NULL AND ${revenueOrderPredicateSql('o', 'sqlite')}
        GROUP BY o.customer_id ORDER BY total DESC LIMIT 10`,
      [storeId]
    )
    .map(r => ({
      customerId: (r.customerId as string | null) ?? null,
      total: num(r.total),
      count: num(r.count),
    }));
  return { newCustomers, returningCustomers, top };
}

/**
 * Buyer identities (QA98-ALIAS-1): orders grouped by (customer id, lowercased shipping email, shipping phone) with a count each,
 * so the API can fold guests into the ONE customer grouping (`CustomerGroups`) and count customers the way the list does.
 * `all` = not deleted, created in [startMs, endMs] (distinct customers); `paid` = paid since `sinceMs` (repeat buyers, the
 * the repeat-buyer population). Returns identity rows, never order rows.
 */
export function analyticsBuyerIdentitiesOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
) {
  const email = `LOWER(CASE WHEN json_type(o.shipping_address, '$.email') = 'text' THEN json_extract(o.shipping_address, '$.email') END)`;
  const phone = `CASE WHEN json_type(o.shipping_address, '$.phone') = 'text' THEN json_extract(o.shipping_address, '$.phone') END`;
  let where: string;
  let params: unknown[];
  if (a.mode === 'paid') {
    where = `o.store_id = ?1 AND o.payment_status = 'paid' AND o.created_at >= ?2`;
    params = [storeId, intArg(a.sinceMs, 'sinceMs')];
  } else if (a.mode === 'all') {
    where = `o.store_id = ?1 AND o.deleted_at IS NULL AND o.created_at >= ?2 AND o.created_at <= ?3`;
    params = [storeId, intArg(a.startMs, 'startMs'), intArg(a.endMs, 'endMs')];
  } else throw new MoneyError('BAD_ARGS', 'mode', 400);
  return db
    .all(
      `SELECT NULLIF(o.customer_id, '') AS customerId, ${email} AS email, ${phone} AS phone, COUNT(*) AS n
         FROM orders o WHERE ${where} GROUP BY 1, 2, 3`,
      params
    )
    .map(r => ({
      customerId: (r.customerId as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      n: num(r.n),
    }));
}

/** getLowStockProducts: active, inventory-tracked products whose on-hand (variant-aware, active variants only) is <= threshold. */
export function analyticsLowStockOp(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const threshold = intArg(a.threshold, 'threshold', -1_000_000, 1_000_000);
  const onHand = `CASE
      WHEN EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id)
      THEN COALESCE((SELECT SUM(pv.inventory) FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1), 0)
      ELSE p.inventory END`;
  return db
    .all(
      `SELECT p.id AS id, p.name AS name, p.slug AS slug, p.sku AS sku, ${onHand} AS inventory,
              (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.position ASC LIMIT 1) AS imageUrl
         FROM products p
        WHERE p.store_id = ?1 AND p.status = 'active' AND p.track_inventory = 1
          AND ${onHand} <= ?2
        ORDER BY inventory ASC, p.id ASC LIMIT 20`,
      [storeId, threshold]
    )
    .map(r => ({
      id: String(r.id),
      name: String(r.name),
      slug: String(r.slug),
      sku: (r.sku as string | null) ?? null,
      inventory: num(r.inventory),
      imageUrl: (r.imageUrl as string | null) ?? null,
    }));
}

/** stockSnapshot: on-hand stock value (STOCK_VALUE_SQL twin) and the open backorder count + demand value (cost of the backordered qty). */
export function analyticsStockOp(db: SyncSql, storeId: string) {
  const value = db.all(
    `SELECT COALESCE(SUM(CASE
        WHEN EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id)
        THEN COALESCE((SELECT SUM(pv.inventory * COALESCE(pv.cost_price, p.cost_price, 0))
                         FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1), 0)
        ELSE p.inventory * COALESCE(p.cost_price, 0) END), 0) AS total
       FROM products p WHERE p.store_id = ? AND p.deleted_at IS NULL`,
    [storeId]
  )[0] as Record<string, unknown>;
  const bo = db.all(
    `SELECT COUNT(*) AS count, COALESCE(SUM(bl.qty * COALESCE(pv.cost_price, p.cost_price, 0)), 0) AS value
       FROM backorder_lines bl
       JOIN products p ON p.id = bl.product_id
       LEFT JOIN product_variants pv ON pv.id = bl.variant_id
      WHERE bl.store_id = ? AND bl.fulfilled_at IS NULL AND bl.cancelled_at IS NULL`,
    [storeId]
  )[0] as Record<string, unknown>;
  return {
    stockValue: num(value.total),
    backorderCount: num(bo.count),
    backorderValue: num(bo.value),
  };
}

/** cashflowTrend: daily (UTC day) net movement of the cash accounts 1000/1010/1020/1030, posted and reversed entries. */
export function analyticsCashflowOp(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const from = intArg(a.fromMs, 'fromMs');
  const to = intArg(a.toMs, 'toMs');
  return db
    .all(
      `SELECT (e.posted_at / 86400000) * 86400000 AS day, COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS net
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE e.store_id = ?1 AND e.status IN ('posted', 'reversed') AND e.posted_at BETWEEN ?2 AND ?3
          AND a.code IN ('1000', '1010', '1020', '1030')
        GROUP BY day ORDER BY day ASC`,
      [storeId, from, to]
    )
    .map(r => ({ dayMs: num(r.day), net: num(r.net) }));
}

/**
 * taxReportLines (NZ-ACCT-1): SQLite twin of the raw query in accounting/tax-report.service.ts. One row per posted /
 * reversed `order` journal entry in [fromMs, toMs] that moved account 2100 (tax); base = account 4000 of the SAME entry.
 * Order id = the source_id prefix before the first ':' (sale, reversal and partial-return adjustments share it).
 * Customer name: the store's `customers` row of the order's customer (id or user_id), else the shipping-address
 * snapshot (`json_type`-guarded), since `users` is not on the DO. Read-only; every table is filtered by `store_id`.
 */
export function taxReportLinesOp(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const from = intArg(a.fromMs, 'fromMs');
  const to = intArg(a.toMs, 'toMs');
  if (to < from) throw new MoneyError('BAD_ARGS', 'toMs', 400);
  const snap = (key: string): string =>
    `CASE WHEN json_type(o.shipping_address, '$.${key}') = 'text' THEN json_extract(o.shipping_address, '$.${key}') END`;
  return db
    .all(
      `SELECT e.posted_at AS posted_at,
              o.order_number AS order_number,
              COALESCE(
                (SELECT NULLIF(TRIM(c.first_name || ' ' || c.last_name), '') FROM customers c
                  WHERE c.store_id = ?1 AND o.customer_id IS NOT NULL AND (c.id = o.customer_id OR c.user_id = o.customer_id)
                  ORDER BY c.created_at ASC, c.id ASC LIMIT 1),
                NULLIF(TRIM(COALESCE(${snap('firstName')}, '') || ' ' || COALESCE(${snap('lastName')}, '')), '')
              ) AS customer_name,
              COALESCE(SUM(CASE WHEN a.code = '2100' THEN l.credit - l.debit ELSE 0 END), 0) AS tax_delta,
              COALESCE(SUM(CASE WHEN a.code = '4000' THEN l.credit - l.debit ELSE 0 END), 0) AS base_delta,
              o.total AS order_total,
              (e.source_id = o.id) AS is_sale
         FROM journal_entries e
         JOIN journal_lines l ON l.entry_id = e.id
         JOIN accounts a ON a.id = l.account_id AND a.code IN ('2100', '4000') AND a.store_id = ?1
         JOIN orders o ON o.id = substr(e.source_id, 1, instr(e.source_id || ':', ':') - 1) AND o.store_id = ?1
        WHERE e.source = 'order' AND e.status IN ('posted', 'reversed')
          AND e.posted_at >= ?2 AND e.posted_at <= ?3 AND e.store_id = ?1
        GROUP BY e.id, e.posted_at, e.source_id, o.id, o.order_number, o.total, o.customer_id, o.shipping_address
       HAVING SUM(CASE WHEN a.code = '2100' THEN l.credit - l.debit ELSE 0 END) <> 0
        ORDER BY e.posted_at ASC, o.order_number ASC`,
      [storeId, from, to]
    )
    .map(r => ({
      postedAtMs: num(r.posted_at),
      orderNumber: String(r.order_number),
      customerName:
        r.customer_name === null || r.customer_name === undefined ? null : String(r.customer_name),
      taxDelta: num(r.tax_delta),
      baseDelta: num(r.base_delta),
      orderTotal: num(r.order_total),
      isSale: num(r.is_sale) === 1,
    }));
}

/**
 * Net revenue + order count of the ONE revenue definition over an optional [startMs, endMs] window, optionally paid-only
 * (the rollup / usage-snapshot / funnel population). The DO twin of `netRevenue` (apps/api/src/services/revenue.service.ts).
 */
export function analyticsNetRevenueOp(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const start = a.startMs === undefined ? 0 : intArg(a.startMs, 'startMs');
  const end = a.endMs === undefined ? Number.MAX_SAFE_INTEGER : intArg(a.endMs, 'endMs');
  const r = db.all(
    `SELECT COALESCE(SUM(${a.gross === true ? 'o.total' : orderNetRevenueSql('o', 'sqlite')}), 0) AS revenue, COUNT(*) AS orders FROM orders o
      ${refundJoinsSql('o', 'sqlite')}
      WHERE o.store_id = ?1 AND o.deleted_at IS NULL AND o.created_at >= ?2 AND o.created_at <= ?3
        AND ${revenueOrderPredicateSql('o', 'sqlite', { paidOnly: a.paidOnly === true })}`,
    [storeId, start, end]
  )[0] as Record<string, unknown>;
  return { revenue: num(r.revenue), orders: num(r.orders) };
}

/**
 * Net revenue + order count of the ONE revenue definition for MANY [fromMs, toMs) windows in ONE query (the funnel rollup's per-day
 * figures). `windows` is [{ fromMs, toMs }] (at most 400, integers, disjoint); the result is one row per window, in order.
 */
export function analyticsNetRevenueDaysOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
) {
  const raw = Array.isArray(a.windows) ? a.windows : [];
  if (raw.length === 0 || raw.length > 400) throw new MoneyError('BAD_ARGS', 'windows', 400);
  const windows = raw.map((w: Record<string, unknown>, i: number) => ({
    i,
    fromMs: intArg(w.fromMs, 'fromMs'),
    toMs: intArg(w.toMs, 'toMs'),
  }));
  // integers validated above, so inlining them into the VALUES list is injection-safe
  const values = windows.map(w => `(${w.i}, ${w.fromMs}, ${w.toMs})`).join(', ');
  const rows = db.all(
    `WITH w(i, f, t) AS (VALUES ${values})
     SELECT w.i AS i, COALESCE(SUM(${orderNetRevenueSql('o', 'sqlite')}), 0) AS revenue, COUNT(*) AS orders
       FROM w
       JOIN orders o ON o.created_at >= w.f AND o.created_at < w.t
       ${refundJoinsSql('o', 'sqlite')}
      WHERE o.store_id = ?1 AND o.deleted_at IS NULL
        AND ${revenueOrderPredicateSql('o', 'sqlite', { paidOnly: a.paidOnly === true })}
      GROUP BY w.i`,
    [storeId]
  );
  const byI = new Map(rows.map(r => [num(r.i), r]));
  return windows.map(w => ({
    revenue: num(byI.get(w.i)?.revenue),
    orders: num(byI.get(w.i)?.orders),
  }));
}
