/**
 * Analytics Rollup Service — Accounting Batch 4 (Insights tier)
 *
 * Materialises three snapshot tables nightly for every store:
 *   • CustomerCohortSnapshot  — cohort retention matrix
 *   • FunnelSnapshot          — checkout funnel per calendar day (KW timezone)
 *   • CustomerRfmSnapshot     — per-customer RFM quintile + segment
 *
 * Designed to be called by the `analytics-daily-rollup` Inngest cron (02:00 KW)
 * or on-demand via `POST /:storeId/insights/rollup/run-now`.
 *
 * Guest handling: orders where customerId IS NULL are keyed by
 * sha256(email + ':' + phone) computed in Node. Orders with neither
 * email nor phone on the shipping address are skipped from cohort + RFM math.
 *
 * Zero-customer stores: every function returns 0 cleanly — no throws.
 */

import crypto from 'crypto';
import { prisma } from '@force/database';
import { RfmSegment } from '@force/database';
import logger from '../../lib/logger';

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

/** Kuwait is UTC+3. We use this to align "day" boundaries. */
const KW_OFFSET_MS = 3 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the floor of a Date to the start of its UTC day,
 * shifted so that "day" boundaries are in Kuwait time (UTC+3).
 * i.e. Kuwait midnight corresponds to UTC 21:00 the prior day.
 */
function kwDayStart(d: Date): Date {
  const kwMs = d.getTime() + KW_OFFSET_MS;
  const dayMs = Math.floor(kwMs / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
  return new Date(dayMs - KW_OFFSET_MS);
}

/** Returns a Date set to N full calendar days before the given date (KW-aligned). */
function kwDaysAgo(n: number, from: Date = new Date()): Date {
  return new Date(kwDayStart(from).getTime() - n * 24 * 60 * 60 * 1000);
}

/** Formats a Date as 'YYYY-MM' based on UTC month (shifted for KW). */
function toYearMonth(d: Date): string {
  const kwDate = new Date(d.getTime() + KW_OFFSET_MS);
  const y = kwDate.getUTCFullYear();
  const m = String(kwDate.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Returns the start of a given YYYY-MM month in UTC (accounting for KW offset). */
function monthStart(ym: string): Date {
  const [y, m] = ym.split('-').map(Number);
  // midnight KW of the 1st of the month = UTC midnight - 3h
  return new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - KW_OFFSET_MS);
}

/** Returns the start of the next month. */
function nextMonthStart(ym: string): Date {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1, 0, 0, 0) - KW_OFFSET_MS); // m (not m-1) = next month
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

/** sha256 hex of a string — used for guest key derivation. */
function sha256hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Derives the guest customer key from a shipping address JSON object. */
function guestKey(shippingAddress: unknown): string | null {
  if (!shippingAddress || typeof shippingAddress !== 'object') return null;
  const addr = shippingAddress as Record<string, unknown>;
  const email = typeof addr.email === 'string' ? addr.email.trim().toLowerCase() : '';
  const phone = typeof addr.phone === 'string' ? addr.phone.trim() : '';
  if (!email && !phone) return null;
  const raw = `${email}:${phone}`;
  const h = sha256hex(raw);
  // Reject the all-zero-input hash (empty email + empty phone) as a safety net.
  // sha256('') = e3b0c44... — if both fields were empty we returned null above,
  // but guard again here.
  if (raw === ':') return null;
  return `GUEST:${h}`;
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

function classifySegment(params: {
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

/**
 * For each cohort month (from store's oldest paid order to current month),
 * computes the retention matrix and writes CustomerCohortSnapshot rows.
 *
 * Returns the total number of snapshot rows written (created + updated).
 */
export async function runCohortRollup(storeId: string): Promise<number> {
  // Step 1: find the oldest paid order for this store (store launch month)
  const oldest = await prisma.order.findFirst({
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

  // Step 2: load ALL paid orders for this store (customerId + guestKey + createdAt + total)
  // We pull the minimum required fields to build cohort memberships in memory.
  type RawOrder = {
    id: string;
    customerId: string | null;
    shippingAddress: unknown;
    createdAt: Date;
    total: number;
  };

  const allOrders = await prisma.order.findMany({
    where: { storeId, paymentStatus: 'paid', deletedAt: null },
    select: {
      id: true,
      customerId: true,
      shippingAddress: true,
      createdAt: true,
      total: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Step 3: derive customer key per order
  type CustomerOrder = {
    key: string; // customerId or GUEST:<hash>
    createdAt: Date;
    total: number;
  };

  const customerOrders: CustomerOrder[] = [];
  for (const o of allOrders as RawOrder[]) {
    const key = o.customerId ?? guestKey(o.shippingAddress);
    if (!key) continue; // guest with no contact info — skip
    customerOrders.push({ key, createdAt: o.createdAt, total: o.total });
  }

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

  // Step 6: iterate cohort months and period offsets
  let rowsWritten = 0;

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
      const customersActive = activeSet.size;
      const ordersInPeriod = windowOrders.length;
      const revenueInPeriod = windowOrders.reduce((sum, o) => sum + o.total, 0);

      // findFirst + create/update (null-safety pattern — same as B3 T3/T4)
      try {
        const existing = await prisma.customerCohortSnapshot.findFirst({
          where: { storeId, cohortMonth: cohortYm, periodOffset: offset },
          select: { id: true },
        });

        const payload = {
          customersTotal,
          customersActive,
          ordersInPeriod,
          revenueInPeriod,
          computedAt: new Date(),
        };

        if (existing) {
          await prisma.customerCohortSnapshot.update({
            where: { id: existing.id },
            data: payload,
          });
        } else {
          await prisma.customerCohortSnapshot.create({
            data: {
              storeId,
              cohortMonth: cohortYm,
              periodOffset: offset,
              ...payload,
            },
          });
        }
        rowsWritten++;
      } catch (err) {
        logger.error(
          { err, storeId, cohortYm, offset },
          'cohort-rollup: failed to write snapshot row'
        );
      }
    }
  }

  logger.info({ storeId, rowsWritten }, 'cohort-rollup completed');
  return rowsWritten;
}

// ---------------------------------------------------------------------------
// Funnel rollup
// ---------------------------------------------------------------------------

/**
 * For each calendar day from `daysBack` days ago to yesterday (KW timezone),
 * counts funnel stages and writes FunnelSnapshot rows.
 *
 * Returns the number of day-rows written.
 */
export async function runFunnelRollup(storeId: string, daysBack = 7): Promise<number> {
  const today = kwDayStart(new Date());
  let rowsWritten = 0;

  for (let d = daysBack; d >= 1; d--) {
    const dayStart = kwDaysAgo(d, new Date(today.getTime() + KW_OFFSET_MS)); // shift back to KW reference
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    // cartsCreated
    const cartsCreated = await prisma.cart.count({
      where: { storeId, createdAt: { gte: dayStart, lt: dayEnd } },
    });

    // cartItemsAdded (CartItem rows created in this day, for this store's carts)
    const cartItemsAdded = await prisma.cartItem.count({
      where: {
        cart: { storeId },
        createdAt: { gte: dayStart, lt: dayEnd },
      },
    });

    // checkoutsStarted (AbandonedCart rows created this day — proxy for checkout initiation)
    const checkoutsStarted = await prisma.abandonedCart.count({
      where: { storeId, createdAt: { gte: dayStart, lt: dayEnd } },
    });

    // ordersCompleted
    const ordersCompletedAgg = await prisma.order.aggregate({
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
    const ordersAbandoned = await prisma.abandonedCart.count({
      where: {
        storeId,
        recoveredAt: null,
        createdAt: { lt: abandonedThreshold },
      },
    });

    // productViews: not available in v1 (no view-count delta column)
    const productViews = 0;

    try {
      const periodDate = dayStart; // store as UTC midnight-aligned KW day start

      const existing = await prisma.funnelSnapshot.findFirst({
        where: { storeId, periodDate },
        select: { id: true },
      });

      const payload = {
        productViews,
        cartsCreated,
        cartItemsAdded,
        checkoutsStarted,
        ordersCompleted,
        ordersAbandoned,
        revenueFils,
        computedAt: new Date(),
      };

      if (existing) {
        await prisma.funnelSnapshot.update({
          where: { id: existing.id },
          data: payload,
        });
      } else {
        await prisma.funnelSnapshot.create({
          data: {
            storeId,
            periodDate,
            ...payload,
          },
        });
      }
      rowsWritten++;
    } catch (err) {
      logger.error({ err, storeId, dayStart }, 'funnel-rollup: failed to write snapshot row');
    }
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
  // Step 1: load all paid orders for this store (same fields as cohort rollup)
  type RawOrder = {
    customerId: string | null;
    shippingAddress: unknown;
    createdAt: Date;
    total: number;
  };

  const allOrders = await prisma.order.findMany({
    where: { storeId, paymentStatus: 'paid', deletedAt: null },
    select: {
      customerId: true,
      shippingAddress: true,
      createdAt: true,
      total: true,
    },
  });

  if (allOrders.length === 0) {
    logger.info({ storeId }, 'rfm-rollup: no paid orders — skip');
    return 0;
  }

  // Step 2: aggregate per customer key
  type CustomerStats = {
    key: string;
    isGuest: boolean;
    lastPaidAt: Date;
    paidCount: number;
    totalPaidFils: number;
  };

  const statsMap = new Map<string, CustomerStats>();

  for (const o of allOrders as RawOrder[]) {
    const key = o.customerId ?? guestKey(o.shippingAddress);
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

  // Step 5: write snapshots
  let rowsWritten = 0;

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

    try {
      // Load previous snapshot for previousSegment field
      const prev = await prisma.customerRfmSnapshot.findFirst({
        where: { storeId, customerId: m.key },
        select: { id: true, segment: true },
      });

      const payload = {
        isGuest: m.isGuest,
        recencyDays: m.recencyDays,
        frequencyOrders: m.paidCount,
        monetaryFils: m.totalPaidFils,
        rfmScore,
        segment,
        previousSegment: prev?.segment ?? null,
        computedAt: new Date(),
      };

      if (prev) {
        await prisma.customerRfmSnapshot.update({
          where: { id: prev.id },
          data: payload,
        });
      } else {
        await prisma.customerRfmSnapshot.create({
          data: {
            storeId,
            customerId: m.key,
            ...payload,
          },
        });
      }
      rowsWritten++;
    } catch (err) {
      logger.error(
        { err, storeId, customerKey: m.key },
        'rfm-rollup: failed to write snapshot row'
      );
    }
  }

  logger.info({ storeId, customers: metrics.length, rowsWritten }, 'rfm-rollup completed');
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
