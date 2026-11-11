/**
 * Analytics Rollup Service — Accounting Batch 4 (Insights tier)
 *
 * Materialises three snapshot tables nightly for every store:
 *   • CustomerCohortSnapshot  — cohort retention matrix
 *   • FunnelSnapshot          — checkout funnel per calendar day (Cairo timezone)
 *   • CustomerRfmSnapshot     — per-customer RFM quintile + segment
 *
 * Designed to be called by the `analytics-daily-rollup` Inngest cron (02:00 Cairo)
 * or on-demand via `POST /:storeId/insights/rollup/run-now`.
 *
 * Guest handling: orders where customerId IS NULL are keyed by
 * sha256(email + ':' + phone) computed in Node. Orders with neither
 * email nor phone on the shipping address are skipped from cohort + RFM math.
 *
 * Zero-customer stores: every function returns 0 cleanly — no throws.
 */

import { analyticsRead } from '../../lib/analytics-backend';
import { prisma } from '@ebda/database';
import { storeDb, storeWriter } from '../../lib/repo-factory';
import { RfmSegment } from '@ebda/database';
import logger from '../../lib/logger';
import { customerKeyOf, isGuestOrder, rfmKeyFor } from '../../lib/customer-key';
// Every snapshot write below is savepointed (issue 2215's class): the daily
// rollup runs each store inside ONE `runInTenantContext` transaction, and each
// block swallows its own failure — without a savepoint the first failed write
// aborted the transaction and silently doomed every later block's writes.
import { withSavepoint } from '../../lib/savepoint';

import {
  regionDayStart,
  regionDayStartOffset,
  regionMonthStart,
  regionYearMonth,
} from '@ebda/shared';
/**
 * Rows per savepoint on the per-row UPDATE loops (issue 2293). A savepoint
 * per row issued SAVEPOINT + UPDATE + RELEASE — three round trips per row —
 * inside one tenant transaction with a 30s hard timeout, so a store with a
 * few thousand RFM rows could time out the whole rollup. A chunk shares one
 * savepoint; only a chunk that fails is replayed row by row, so one bad row
 * still costs only itself.
 */
const ROLLUP_WRITE_CHUNK = 100;

export async function writeInChunks<T>(
  items: T[],
  write: (item: T) => Promise<unknown>,
  onRowError: (err: unknown, item: T) => void
): Promise<number> {
  let written = 0;
  for (let i = 0; i < items.length; i += ROLLUP_WRITE_CHUNK) {
    const chunk = items.slice(i, i + ROLLUP_WRITE_CHUNK);
    try {
      await withSavepoint(async () => {
        for (const item of chunk) await write(item);
      });
      written += chunk.length;
    } catch {
      for (const item of chunk) {
        try {
          await withSavepoint(() => write(item));
          written++;
        } catch (err) {
          onRowError(err, item);
        }
      }
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export interface RollupResult {
  cohortRows: number;
  funnelDays: number;
  rfmCustomers: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Day/month boundaries are calendar days in REGION.timezone (Africa/Cairo),
// DST-aware (a fixed offset is wrong for half the year). view-ingest.service.ts
// uses the same `regionDayStart`, so its ProductDailyView `date` joins exactly.

/** Start of the Cairo calendar day containing `d`. */
function dayStartOf(d: Date): Date {
  return regionDayStart(d);
}

/** Start of the Cairo day `n` full calendar days before the one containing `from`. */
function daysAgo(n: number, from: Date = new Date()): Date {
  return regionDayStartOffset(from, -n);
}

/** Formats a Date as 'YYYY-MM' (Cairo calendar month). */
function toYearMonth(d: Date): string {
  return regionYearMonth(d);
}

/** Returns the start of a given YYYY-MM month (Cairo midnight of the 1st). */
function monthStart(ym: string): Date {
  return regionMonthStart(ym);
}

/** Generates a sequence of 'YYYY-MM' strings from start to end (inclusive). */
function monthRange(startYm: string, endYm: string): string[] {
  const months: string[] = [];
  let cur = startYm;
  while (cur <= endYm) {
    months.push(cur);
    const [y, m] = cur.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    cur = next;
  }
  return months;
}

/** Number of full months between two YYYY-MM strings (endYm - startYm). */
function monthDiff(startYm: string, endYm: string): number {
  const [sy, sm] = startYm.split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  return (ey - sy) * 12 + (em - sm);
}

/**
 * The customer key an RFM/cohort row is stored under: `customerKeyOf` (the
 * Customers-page grouping — user id, else lowercased email, else phone) with
 * a guest's contact hashed by `rfmKeyFor`. Shared with the Customers list so
 * a segment's members resolve to the rows the merchant sees. `null` = a guest
 * with no contact at all (skipped).
 *
 * Before 2026-09-30 guests were keyed `GUEST:sha256("<email>:<phone>")`,
 * which the list (keyed by plain email/phone) could never join, and which
 * split one guest into two customers when they reused an email with a new
 * phone. Rows in the old format are removed by the stale-row sweep at the end
 * of `runRfmRollup`, so the first nightly run after deploy converges.
 */
function orderCustomerKey(o: {
  customerId: string | null;
  shippingAddress: unknown;
}): string | null {
  const key = customerKeyOf(o);
  return key ? rfmKeyFor(key, isGuestOrder(o)) : null;
}

// ---------------------------------------------------------------------------
// Quintile bucketing
// ---------------------------------------------------------------------------

/**
 * Maps a single value to quintile 1–5 relative to the distribution.
 * `invert=true` flips so that lower values get higher quintiles
 * (used for recencyDays: fewer days since purchase = better = higher quintile).
 */
function quintile(values: number[], v: number, invert = false): number {
  if (values.length === 0) return 3; // degenerate: single-customer store
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.2)];
  const q2 = sorted[Math.floor(sorted.length * 0.4)];
  const q3 = sorted[Math.floor(sorted.length * 0.6)];
  const q4 = sorted[Math.floor(sorted.length * 0.8)];
  let bucket: number;
  if (v <= q1) bucket = 1;
  else if (v <= q2) bucket = 2;
  else if (v <= q3) bucket = 3;
  else if (v <= q4) bucket = 4;
  else bucket = 5;
  return invert ? 6 - bucket : bucket;
}

// ---------------------------------------------------------------------------
// RFM segment classification
// ---------------------------------------------------------------------------

/** Exported for unit testing only. Internal RFM classification logic. */
export function classifySegment(params: {
  recencyDays: number;
  rQ: number; // recency quintile 1-5
  fQ: number; // frequency quintile 1-5
  mQ: number; // monetary quintile 1-5
}): RfmSegment {
  const { recencyDays, rQ, fQ, mQ } = params;

  // Lost overrides all other segments
  if (recencyDays > 365) return RfmSegment.lost;

  // VIP
  if (rQ >= 4 && fQ >= 4 && mQ >= 4) return RfmSegment.vip;

  // Loyal
  if (fQ >= 4 && mQ >= 3) return RfmSegment.loyal;

  // New (single purchase, recent) — checked before Potential so it wins
  if (rQ >= 4 && fQ === 1) return RfmSegment.new_customer;

  // Potential (recent but infrequent)
  if (rQ >= 4 && fQ <= 2) return RfmSegment.potential;

  // At-risk (frequent but lapsed)
  if (fQ >= 3 && rQ <= 2) return RfmSegment.at_risk;

  // Hibernating
  if (rQ <= 2 && fQ <= 2 && mQ <= 2) return RfmSegment.hibernating;

  // Catch-all
  return RfmSegment.potential;
}

// ---------------------------------------------------------------------------
// Cohort rollup
// ---------------------------------------------------------------------------

/** Paid orders read per query by the rollups (was: every paid order in one query — M-048). */
export const ROLLUP_ORDER_PAGE = 1000;

type PagedOrder = {
  id: string;
  customerId: string | null;
  shippingAddress: unknown;
  createdAt: Date;
  total: number;
};

/**
 * Walks the store's paid orders in keyset pages (createdAt, id ascending; `cursor` + `skip: 1`)
 * and hands each page to `onPage`, so memory is bounded by the page, not the order count. Works on
 * Postgres and on a Durable Object store alike (`db` is `storeDb(storeId)`).
 */
export async function forEachPaidOrderPage(
  db: Awaited<ReturnType<typeof storeDb>>,
  storeId: string,
  onPage: (page: PagedOrder[]) => void,
  pageSize = ROLLUP_ORDER_PAGE
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const page = (await db.order.findMany({
      where: { storeId, paymentStatus: 'paid', deletedAt: null },
      select: { id: true, customerId: true, shippingAddress: true, createdAt: true, total: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })) as PagedOrder[];
    if (page.length === 0) return;
    onPage(page);
    if (page.length < pageSize) return;
    cursor = page[page.length - 1]!.id;
  }
}

/**
 * For each cohort month (from store's oldest paid order to current month),
 * computes the retention matrix and writes CustomerCohortSnapshot rows.
 *
 * Returns the total number of snapshot rows written (created + updated).
 */
export async function runCohortRollup(storeId: string): Promise<number> {
  // the store's backend (Ruling CF-JOBS-4): Postgres (`prisma`) or its Durable Object
  const db = await storeDb(storeId);
  const sw = await storeWriter(storeId);
  // Step 1: find the oldest paid order for this store (store launch month)
  const oldest = await db.order.findFirst({
    where: { storeId, paymentStatus: 'paid', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });

  if (!oldest) {
    logger.info({ storeId }, 'cohort-rollup: no paid orders — skip');
    return 0;
  }

  const launchYm = toYearMonth(oldest.createdAt);
  const currentYm = toYearMonth(new Date());
  const cohortMonths = monthRange(launchYm, currentYm);

  // Step 2/3: stream paid orders in pages and keep only what the cohort maths needs per order
  // (customer key + createdAt + total) — never the full order rows (M-048).
  type CustomerOrder = {
    key: string; // customerId or GUEST:<hash>
    createdAt: Date;
    total: number;
  };

  const customerOrders: CustomerOrder[] = [];
  await forEachPaidOrderPage(db, storeId, page => {
    for (const o of page) {
      const key = orderCustomerKey(o);
      if (!key) continue; // guest with no contact info — skip
      customerOrders.push({ key, createdAt: o.createdAt, total: o.total });
    }
  });

  if (customerOrders.length === 0) {
    logger.info({ storeId }, 'cohort-rollup: no keyed orders — skip');
    return 0;
  }

  // Step 4: build first-purchase-month map: key -> cohortYm
  const firstPurchaseMonth = new Map<string, string>();
  for (const co of customerOrders) {
    const ym = toYearMonth(co.createdAt);
    const existing = firstPurchaseMonth.get(co.key);
    if (!existing || ym < existing) {
      firstPurchaseMonth.set(co.key, ym);
    }
  }

  // Step 5: group customers by cohort month
  const cohortCustomers = new Map<string, Set<string>>(); // cohortYm -> Set<key>
  for (const [key, ym] of firstPurchaseMonth) {
    if (!cohortCustomers.has(ym)) cohortCustomers.set(ym, new Set());
    cohortCustomers.get(ym)!.add(key);
  }

  // Step 6: compute every cohort/offset row first (pure — no DB I/O), then
  // batch-write: one createMany for brand-new rows, individual updates only
  // for rows a prior run already wrote (reruns of the same period). This
  // replaces one findFirst + create/update round-trip per row with a single
  // batched query for the common (fresh) case.
  type CohortRow = {
    cohortMonth: string;
    periodOffset: number;
    customersTotal: number;
    customersActive: number;
    ordersInPeriod: number;
    revenueInPeriod: number;
  };
  const computedRows: CohortRow[] = [];

  for (const cohortYm of cohortMonths) {
    const cohortSet = cohortCustomers.get(cohortYm);
    if (!cohortSet || cohortSet.size === 0) continue;

    const customersTotal = cohortSet.size;
    const maxOffset = monthDiff(cohortYm, currentYm);

    for (let offset = 0; offset <= maxOffset; offset++) {
      // Window: [cohortYm + offset months, cohortYm + (offset+1) months)
      const windowStart = monthStart(
        (() => {
          const [y, m] = cohortYm.split('-').map(Number);
          const totalM = m - 1 + offset;
          return `${y + Math.floor(totalM / 12)}-${String((totalM % 12) + 1).padStart(2, '0')}`;
        })()
      );
      const windowEnd = new Date(windowStart.getTime());
      windowEnd.setUTCMonth(windowEnd.getUTCMonth() + 1);

      // Cohort orders in this window
      const windowOrders = customerOrders.filter(
        co => cohortSet.has(co.key) && co.createdAt >= windowStart && co.createdAt < windowEnd
      );

      const activeSet = new Set(windowOrders.map(o => o.key));

      computedRows.push({
        cohortMonth: cohortYm,
        periodOffset: offset,
        customersTotal,
        customersActive: activeSet.size,
        ordersInPeriod: windowOrders.length,
        revenueInPeriod: windowOrders.reduce((sum, o) => sum + o.total, 0),
      });
    }
  }

  let rowsWritten = 0;

  if (computedRows.length > 0) {
    const existing = await db.customerCohortSnapshot.findMany({
      where: { storeId, cohortMonth: { in: cohortMonths } },
      select: { id: true, cohortMonth: true, periodOffset: true },
    });
    const existingIdByKey = new Map(
      existing.map(e => [`${e.cohortMonth}::${e.periodOffset}`, e.id])
    );

    const toCreate: Array<CohortRow & { storeId: string; computedAt: Date }> = [];
    const toUpdate: Array<{ id: string; row: CohortRow }> = [];
    for (const row of computedRows) {
      const existingId = existingIdByKey.get(`${row.cohortMonth}::${row.periodOffset}`);
      if (existingId) {
        toUpdate.push({ id: existingId, row });
      } else {
        toCreate.push({ storeId, ...row, computedAt: new Date() });
      }
    }

    if (toCreate.length > 0) {
      try {
        await withSavepoint(() => sw.customerCohortSnapshot.createMany({ data: toCreate }));
        rowsWritten += toCreate.length;
      } catch (err) {
        logger.error(
          { err, storeId, count: toCreate.length },
          'cohort-rollup: batched create failed'
        );
      }
    }

    rowsWritten += await writeInChunks(
      toUpdate,
      ({ id, row }) =>
        sw.customerCohortSnapshot.update({
          where: { id, storeId },
          data: {
            customersTotal: row.customersTotal,
            customersActive: row.customersActive,
            ordersInPeriod: row.ordersInPeriod,
            revenueInPeriod: row.revenueInPeriod,
            computedAt: new Date(),
          },
        }),
      (err, { row }) =>
        logger.error(
          { err, storeId, cohortYm: row.cohortMonth, offset: row.periodOffset },
          'cohort-rollup: failed to write snapshot row'
        )
    );
  }

  logger.info({ storeId, rowsWritten }, 'cohort-rollup completed');
  return rowsWritten;
}

// ---------------------------------------------------------------------------
// Funnel rollup
// ---------------------------------------------------------------------------

/**
 * For each calendar day from `daysBack` days ago to yesterday (Cairo timezone),
 * counts funnel stages and writes FunnelSnapshot rows.
 *
 * Returns the number of day-rows written.
 */
export async function runFunnelRollup(storeId: string, daysBack = 7): Promise<number> {
  // the store's backend (Ruling CF-JOBS-4): Postgres (`prisma`) or its Durable Object
  const db = await storeDb(storeId);
  const sw = await storeWriter(storeId);
  const today = dayStartOf(new Date());

  type FunnelRow = {
    periodDate: Date;
    productViews: number;
    cartsCreated: number;
    cartItemsAdded: number;
    checkoutsStarted: number;
    ordersCompleted: number;
    ordersAbandoned: number;
    revenueFils: number;
  };
  const computedRows: FunnelRow[] = [];

  for (let d = daysBack; d >= 1; d--) {
    const dayStart = daysAgo(d, today);
    const dayEnd = regionDayStartOffset(dayStart, 1); // next Cairo midnight (DST-safe, not +24h)

    // cartsCreated
    const cartsCreated = await db.cart.count({
      where: { storeId, createdAt: { gte: dayStart, lt: dayEnd } },
    });

    // cartItemsAdded (CartItem rows created in this day, for this store's carts)
    const cartItemsAdded = await db.cartItem.count({
      where: {
        cart: { storeId },
        createdAt: { gte: dayStart, lt: dayEnd },
      },
    });

    // checkoutsStarted (AbandonedCart rows created this day — proxy for checkout initiation)
    const checkoutsStarted = await db.abandonedCart.count({
      where: { storeId, createdAt: { gte: dayStart, lt: dayEnd } },
    });

    // ordersCompleted
    const ordersCompletedAgg = await db.order.aggregate({
      where: {
        storeId,
        paymentStatus: 'paid',
        deletedAt: null,
        createdAt: { gte: dayStart, lt: dayEnd },
      },
      _count: { id: true },
      _sum: { total: true },
    });
    const ordersCompleted = ordersCompletedAgg._count.id;
    const revenueFils = ordersCompletedAgg._sum.total ?? 0;

    // ordersAbandoned: AbandonedCart created before (dayStart - 7d) with recoveredAt IS NULL
    // These are carts that had 7+ days to convert and did not.
    const abandonedThreshold = new Date(dayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const ordersAbandoned = await db.abandonedCart.count({
      where: {
        storeId,
        recoveredAt: null,
        createdAt: { lt: abandonedThreshold },
      },
    });

    // productViews: sum of ProductDailyView.count for this store on this calendar day.
    // `date` in product_daily_views is a DATE stored at UTC midnight (regionDayStart output),
    // so an exact equality match on dayStart gives the right rows.
    const viewsArgs = {
      where: {
        storeId,
        date: dayStart, // exact match — DATE column stored as Cairo-day-start instant
      },
      _sum: { count: true as const },
    };
    // Ruling NZ-AN-1: the store's DO once its analytics moved, else Postgres
    const productViewsAgg = await analyticsRead(
      storeId,
      r => r.productDailyView.aggregate(viewsArgs),
      () => prisma.productDailyView.aggregate(viewsArgs)
    );
    const productViews = productViewsAgg._sum.count ?? 0;

    computedRows.push({
      periodDate: dayStart, // store as the Cairo day-start instant
      productViews,
      cartsCreated,
      cartItemsAdded,
      checkoutsStarted,
      ordersCompleted,
      ordersAbandoned,
      revenueFils,
    });
  }

  // Batch-write: one createMany for brand-new days, individual updates only
  // for days a prior run already wrote (reruns of the same window).
  let rowsWritten = 0;

  if (computedRows.length > 0) {
    const existing = await db.funnelSnapshot.findMany({
      where: { storeId, periodDate: { in: computedRows.map(r => r.periodDate) } },
      select: { id: true, periodDate: true },
    });
    const existingIdByDate = new Map(existing.map(e => [e.periodDate.getTime(), e.id]));

    const toCreate: Array<FunnelRow & { storeId: string; computedAt: Date }> = [];
    const toUpdate: Array<{ id: string; row: FunnelRow }> = [];
    for (const row of computedRows) {
      const existingId = existingIdByDate.get(row.periodDate.getTime());
      if (existingId) {
        toUpdate.push({ id: existingId, row });
      } else {
        toCreate.push({ storeId, ...row, computedAt: new Date() });
      }
    }

    if (toCreate.length > 0) {
      try {
        await withSavepoint(() => sw.funnelSnapshot.createMany({ data: toCreate }));
        rowsWritten += toCreate.length;
      } catch (err) {
        logger.error(
          { err, storeId, count: toCreate.length },
          'funnel-rollup: batched create failed'
        );
      }
    }

    rowsWritten += await writeInChunks(
      toUpdate,
      ({ id, row }) =>
        sw.funnelSnapshot.update({
          where: { id, storeId },
          data: {
            productViews: row.productViews,
            cartsCreated: row.cartsCreated,
            cartItemsAdded: row.cartItemsAdded,
            checkoutsStarted: row.checkoutsStarted,
            ordersCompleted: row.ordersCompleted,
            ordersAbandoned: row.ordersAbandoned,
            revenueFils: row.revenueFils,
            computedAt: new Date(),
          },
        }),
      (err, { row }) =>
        logger.error(
          { err, storeId, dayStart: row.periodDate },
          'funnel-rollup: failed to write snapshot row'
        )
    );
  }

  logger.info({ storeId, daysBack, rowsWritten }, 'funnel-rollup completed');
  return rowsWritten;
}

// ---------------------------------------------------------------------------
// RFM rollup
// ---------------------------------------------------------------------------

/**
 * Computes RFM quintile scores + segments for every customer (registered +
 * guest) with ≥1 paid order in this store. Writes CustomerRfmSnapshot rows.
 *
 * Returns the number of customers segmented.
 */
export async function runRfmRollup(storeId: string): Promise<number> {
  // the store's backend (Ruling CF-JOBS-4): Postgres (`prisma`) or its Durable Object
  const db = await storeDb(storeId);
  const sw = await storeWriter(storeId);
  // Step 2: aggregate per customer key
  type CustomerStats = {
    key: string;
    isGuest: boolean;
    lastPaidAt: Date;
    paidCount: number;
    totalPaidFils: number;
  };

  const statsMap = new Map<string, CustomerStats>();

  await forEachPaidOrderPage(db, storeId, page => {
    for (const o of page) {
      const key = orderCustomerKey(o);
      if (!key) continue;

      const isGuest = !o.customerId;
      const existing = statsMap.get(key);
      if (existing) {
        if (o.createdAt > existing.lastPaidAt) existing.lastPaidAt = o.createdAt;
        existing.paidCount++;
        existing.totalPaidFils += o.total;
      } else {
        statsMap.set(key, {
          key,
          isGuest,
          lastPaidAt: o.createdAt,
          paidCount: 1,
          totalPaidFils: o.total,
        });
      }
    }
  });

  if (statsMap.size === 0) {
    logger.info({ storeId }, 'rfm-rollup: no paid orders — skip');
    return 0;
  }

  const customers = Array.from(statsMap.values());

  if (customers.length === 0) {
    logger.info({ storeId }, 'rfm-rollup: no keyed customers — skip');
    return 0;
  }

  // Step 3: compute raw R/F/M values
  const now = Date.now();
  type CustomerMetrics = CustomerStats & {
    recencyDays: number;
  };

  const metrics: CustomerMetrics[] = customers.map(c => ({
    ...c,
    recencyDays: Math.floor((now - c.lastPaidAt.getTime()) / (24 * 60 * 60 * 1000)),
  }));

  // Step 4: compute store-wide quintile boundaries
  const recencyArr = metrics.map(m => m.recencyDays);
  const freqArr = metrics.map(m => m.paidCount);
  const monArr = metrics.map(m => m.totalPaidFils);

  // Step 5: compute every customer's row first (pure), then batch-write: one
  // createMany for customers with no prior snapshot, individual updates only
  // for customers a prior run already segmented (need their previousSegment).
  type RfmRow = {
    customerId: string;
    isGuest: boolean;
    recencyDays: number;
    frequencyOrders: number;
    monetaryFils: number;
    rfmScore: number;
    segment: RfmSegment;
  };
  const computedRows: RfmRow[] = [];

  for (const m of metrics) {
    const rQ = quintile(recencyArr, m.recencyDays, true); // invert: lower days = better
    const fQ = quintile(freqArr, m.paidCount, false);
    const mQ = quintile(monArr, m.totalPaidFils, false);

    const rfmScore = rQ * 100 + fQ * 10 + mQ;
    const segment = classifySegment({
      recencyDays: m.recencyDays,
      rQ,
      fQ,
      mQ,
    });

    computedRows.push({
      customerId: m.key,
      isGuest: m.isGuest,
      recencyDays: m.recencyDays,
      frequencyOrders: m.paidCount,
      monetaryFils: m.totalPaidFils,
      rfmScore,
      segment,
    });
  }

  let rowsWritten = 0;

  if (computedRows.length > 0) {
    const existing = await db.customerRfmSnapshot.findMany({
      where: { storeId, customerId: { in: computedRows.map(r => r.customerId) } },
      select: { id: true, customerId: true, segment: true },
    });
    const existingByCustomerId = new Map(existing.map(e => [e.customerId, e]));

    const toCreate: Array<RfmRow & { storeId: string; previousSegment: null; computedAt: Date }> =
      [];
    const toUpdate: Array<{ id: string; row: RfmRow; previousSegment: RfmSegment }> = [];
    for (const row of computedRows) {
      const prev = existingByCustomerId.get(row.customerId);
      if (prev) {
        toUpdate.push({ id: prev.id, row, previousSegment: prev.segment });
      } else {
        toCreate.push({ storeId, ...row, previousSegment: null, computedAt: new Date() });
      }
    }

    if (toCreate.length > 0) {
      try {
        await withSavepoint(() => sw.customerRfmSnapshot.createMany({ data: toCreate }));
        rowsWritten += toCreate.length;
      } catch (err) {
        logger.error({ err, storeId, count: toCreate.length }, 'rfm-rollup: batched create failed');
      }
    }

    rowsWritten += await writeInChunks(
      toUpdate,
      ({ id, row, previousSegment }) =>
        sw.customerRfmSnapshot.update({
          where: { id, storeId },
          data: {
            isGuest: row.isGuest,
            recencyDays: row.recencyDays,
            frequencyOrders: row.frequencyOrders,
            monetaryFils: row.monetaryFils,
            rfmScore: row.rfmScore,
            segment: row.segment,
            previousSegment,
            computedAt: new Date(),
          },
        }),
      (err, { row }) =>
        logger.error(
          { err, storeId, customerKey: row.customerId },
          'rfm-rollup: failed to write snapshot row'
        )
    );
  }

  // Stale-row sweep. A snapshot whose key no paid order produces any more —
  // the customer's paid orders were all refunded/deleted, or the row was
  // written under the pre-2026-09-30 guest key format — would otherwise keep
  // counting in the segment totals forever (the unique key means no later
  // run ever touches it). Only runs when this run computed a full set, and
  // scoped to this store.
  let staleRemoved = 0;
  try {
    const removed = await withSavepoint(() =>
      sw.customerRfmSnapshot.deleteMany({
        where: { storeId, customerId: { notIn: computedRows.map(r => r.customerId) } },
      })
    );
    staleRemoved = removed.count;
  } catch (err) {
    logger.error({ err, storeId }, 'rfm-rollup: stale snapshot sweep failed');
  }

  logger.info(
    { storeId, customers: metrics.length, rowsWritten, staleRemoved },
    'rfm-rollup completed'
  );
  return rowsWritten;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs all three rollups in sequence for a store.
 * Returns a summary of rows written per rollup type.
 */
export async function runDailyRollup(storeId: string): Promise<RollupResult> {
  logger.info({ storeId }, 'analytics-daily-rollup: start');

  const cohortRows = await runCohortRollup(storeId);
  const funnelDays = await runFunnelRollup(storeId);
  const rfmCustomers = await runRfmRollup(storeId);

  logger.info({ storeId, cohortRows, funnelDays, rfmCustomers }, 'analytics-daily-rollup: done');
  return { cohortRows, funnelDays, rfmCustomers };
}
