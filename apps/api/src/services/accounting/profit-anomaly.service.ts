/**
 * Profit Anomaly Scan Service — Accounting Smart Layer (Batch 3, Task 5)
 *
 * Computes four store-wide metrics comparing a 7-day current window against a
 * per-week baseline over the 21 days BEFORE it (the stored column is still
 * named baseline28d), then surfaces significant deviations as ProfitAnomaly
 * rows with Gemini-generated bilingual explanations.
 *
 * Metrics:
 *   margin_drop   — gross margin % (current 7d vs the prior 21d)
 *   cost_spike    — average unit cost shift derived from recent InventoryHistory
 *   revenue_drop  — weekly revenue vs prior-21d/3 per-week baseline
 *   refund_spike  — weekly refund count vs prior-21d/3 per-week baseline
 *
 * Every metric has a thin-data floor (see step 5); none alarms on noise.
 *
 * Severity thresholds (|delta| from baseline):
 *   > 40%  → p0  (wake someone, Telegram alert)
 *   > 20%  → warning
 *   else   → skip
 *
 * P0 deduplication: an alert fires only when no other P0 exists for
 * the same (storeId, metric) in the last 24 hours.
 */

import { AnomalyScope, AnomalyMetric, AnomalySeverity, withStore } from '@ebda/database';
import { storeDb, storeWriter } from '../../lib/repo-factory';
import logger from '../../lib/logger';
import { profitAndLoss } from './reports.service';
import { callGemini } from './gemini-ai.service';
import { sendAlert } from '../alerts.service';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProfitAnomalyScanResult {
  /** Number of anomalies written to DB (warning + p0). */
  detected: number;
  /** Number of those anomalies with severity='p0'. */
  p0Count: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MetricResult {
  metric: AnomalyMetric;
  current7d: number;
  baseline28d: number;
  deltaPercent: number;
  severity: AnomalySeverity | null;
}

interface GeminiExplanation {
  explanationEn: string;
  explanationAr: string;
  likelyCause: 'cost' | 'refund' | 'coupon' | 'demand';
}

// ---------------------------------------------------------------------------
// Algorithm helpers
// ---------------------------------------------------------------------------

/** Percentage change of current vs baseline. Positive = current higher. */
function deltaPercent(current: number, baseline: number): number {
  if (baseline === 0) return current === 0 ? 0 : 1;
  return (current - baseline) / Math.abs(baseline);
}

/**
 * Direction-aware severity. Each metric only alarms in its BAD direction:
 *   'up'   metrics (cost_spike, refund_spike)  — only a RISE is bad; a drop is
 *                                                good news and must NEVER alarm.
 *   'down' metrics (margin_drop, revenue_drop) — only a FALL is bad; a rise is
 *                                                good news and must NEVER alarm.
 * Using Math.abs(delta) previously fired p0 on the harmless direction too —
 * e.g. refunds dropping to 0 read as a −100% "refund spike" P0 (demo store,
 * 2026-06-24..28). A spike metric reacting to a decline is nonsensical.
 */
function classifySeverity(delta: number, direction: 'up' | 'down'): AnomalySeverity | null {
  const bad = direction === 'up' ? delta : -delta; // magnitude in the bad direction
  if (bad > 0.4) return 'p0';
  if (bad > 0.2) return 'warning';
  return null;
}

// ---------------------------------------------------------------------------
// Main service
// ---------------------------------------------------------------------------

export async function runProfitAnomalyScan(storeId: string): Promise<ProfitAnomalyScanResult> {
  // the store's backend (Ruling CF-JOBS-4): Postgres (`prisma`) or its Durable Object
  const db = await storeDb(storeId);
  const sw = await storeWriter(storeId);
  const now = new Date();
  const window7dStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const window28dStart = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

  // ---- 1. Load PnL for current 7d and the PRIOR 21d baseline ----
  // The baseline EXCLUDES the current week (issue 2245): a 28d window that
  // contains the 7d one compares a week against an average that already
  // includes it, so a store whose revenue simply stopped reads the same −100%
  // on every nightly run. 1 week vs the 3 weeks before it.
  const priorEnd = new Date(window7dStart.getTime() - 1);
  const [pnl7d, pnlPrior] = await Promise.all([
    profitAndLoss(storeId, window7dStart, now),
    profitAndLoss(storeId, window28dStart, priorEnd),
  ]);

  // ---- 2. Compute COGS from expense accounts with code starting '50' ----
  function cogsFils(pnl: typeof pnl7d): number {
    return pnl.expenses
      .filter(r => r.code.startsWith('50'))
      .reduce((s, r) => s + r.debitTotal - r.creditTotal, 0);
  }

  const cogs7d = cogsFils(pnl7d);
  const cogsPrior = cogsFils(pnlPrior);

  // Gross margin % = (revenue - cogs) / revenue
  const margin7d = pnl7d.totalRevenue > 0 ? (pnl7d.totalRevenue - cogs7d) / pnl7d.totalRevenue : 0;
  // Prior-21d margin for comparison (same formula, the weeks BEFORE this one)
  const marginPrior =
    pnlPrior.totalRevenue > 0 ? (pnlPrior.totalRevenue - cogsPrior) / pnlPrior.totalRevenue : 0;

  // Revenue: 7d vs prior 21d / 3 (per-week equivalent)
  const revenue7d = pnl7d.totalRevenue;
  const revenueBaseline = pnlPrior.totalRevenue / 3;

  // ---- 3. Refund spike: count refunded payments in each window ----
  const [refunds7dCount, refundsPriorCount] = await Promise.all([
    db.payment.count({
      where: {
        order: { storeId },
        status: 'refunded',
        paidAt: { gte: window7dStart },
      },
    }),
    db.payment.count({
      where: {
        order: { storeId },
        status: 'refunded',
        paidAt: { gte: window28dStart, lt: window7dStart },
      },
    }),
  ]);
  const refundBaseline = refundsPriorCount / 3; // per-week baseline, prior 3 weeks

  // ---- 4. Cost spike: compare average recent inventory moves ----
  // We compare the average unit cost from InventoryHistory in the 7d window
  // vs the prior 21d window (making up the full 28d).
  const [invHistory7d, invHistory21d] = await Promise.all([
    db.inventoryHistory.findMany({
      where: { storeId, createdAt: { gte: window7dStart } },
      select: { quantity: true },
    }),
    db.inventoryHistory.findMany({
      where: { storeId, createdAt: { gte: window28dStart, lt: window7dStart } },
      select: { quantity: true },
    }),
  ]);
  // Use total quantity moved as a proxy for cost-volume activity.
  const costVolume7d = invHistory7d.reduce((s, r) => s + Math.abs(r.quantity), 0);
  const costVolumeBaseline =
    invHistory21d.length > 0
      ? invHistory21d.reduce((s, r) => s + Math.abs(r.quantity), 0) / 3 // per-week
      : costVolume7d; // no prior data → no spike

  // ---- 5. Build metric array ----
  // cost_spike reads InventoryHistory.quantity (movement VOLUME, not cost
  // dollars), so on a thin-data store the percentage delta is pure noise: a
  // near-zero baseline makes ANY small absolute movement explode into a
  // multi-thousand-percent "spike". A single stock count of 12 units against a
  // 0.33-units/week baseline reads as 3500% and pages P0 — that is not signal.
  //
  // The fix: cost_spike is only trustworthy when there is a MEANINGFUL ABSOLUTE
  // movement floor in EITHER the current week OR the baseline. Below the floor in
  // both windows, suppress the metric entirely.
  //   - thin-data store (both windows < floor)  → suppressed (the false positive)
  //   - real spike (current ≥ floor)            → fires
  //   - genuine cost-data outage on a real-volume
  //     store (baseline ≥ floor, current drops) → fires (catches the −100% drop)
  //
  // Threshold history:
  //   v1 (2026-05-25): skip only when current==0 && baseline<10 — too tight.
  //   v2 (2026-05-27): skip only when current==0 && baseline<50 — still missed
  //                    the LOW-but-nonzero current case (Demo Shop: current=12,
  //                    baseline=0.33 → 3500% P0 false positive, 2026-06-17).
  //   v3 (2026-06-17): absolute floor in EITHER window (direction-agnostic).
  const COST_SPIKE_MIN_UNITS = 50;
  const includeCostSpike =
    costVolume7d >= COST_SPIKE_MIN_UNITS || costVolumeBaseline >= COST_SPIKE_MIN_UNITS;
  // refund_spike has the SAME thin-data trap as cost_spike: a near-zero
  // refunds/week baseline turns a single refund into a multi-hundred-percent
  // "spike". Only consider it when the CURRENT week has a meaningful absolute
  // refund count. (Direction-aware severity already stops a DROP from alarming;
  // this floor stops a tiny RISE off a ~0 baseline from paging P0.)
  const REFUND_SPIKE_MIN_COUNT = 3;
  const includeRefundSpike = refunds7dCount >= REFUND_SPIKE_MIN_COUNT;
  // margin_drop is only a measurement when BOTH windows booked COGS. With no
  // cost of goods posted (no cost prices on the sold lines — every prod store
  // as of 2026-09-30) the "margin" is 100% by construction, and the first week
  // cost prices appear it would "drop" from that fake 100% and page. Unknown
  // margin is not a margin.
  const includeMargin = cogs7d > 0 && cogsPrior > 0;
  // revenue_drop was silently dead until the 2026-09-30 P&L fix (every
  // profitAndLoss returned 0, so 0 vs 0 never alarmed). Live, it has the
  // same thin-data trap as its siblings (issues 2245/2268): a store doing a
  // few orders a week reads one quiet week as −67% and pages P0. Only a
  // meaningful absolute revenue in EITHER window makes the percentage a
  // signal — a real drop off a real baseline still fires, including the
  // −100% of a store whose revenue stopped.
  //   v1 (2026-10-01): EGP-scaled weekly floor in either window
  //   to 5,000 EGP / week (500_000 piastres) — product to confirm.
  const REVENUE_DROP_MIN_FILS = 500_000;
  const includeRevenue =
    revenue7d >= REVENUE_DROP_MIN_FILS || revenueBaseline >= REVENUE_DROP_MIN_FILS;
  const rawMetrics: Array<{
    metric: AnomalyMetric;
    current: number;
    baseline: number;
    direction: 'up' | 'down';
  }> = [
    ...(includeMargin
      ? [
          {
            metric: 'margin_drop' as AnomalyMetric,
            current: margin7d,
            baseline: marginPrior,
            direction: 'down' as const,
          },
        ]
      : []),
    ...(includeCostSpike
      ? [
          {
            metric: 'cost_spike' as AnomalyMetric,
            current: costVolume7d,
            baseline: costVolumeBaseline,
            direction: 'up' as const,
          },
        ]
      : []),
    ...(includeRevenue
      ? [
          {
            metric: 'revenue_drop' as AnomalyMetric,
            current: revenue7d,
            baseline: revenueBaseline,
            direction: 'down' as const,
          },
        ]
      : []),
    ...(includeRefundSpike
      ? [
          {
            metric: 'refund_spike' as AnomalyMetric,
            current: refunds7dCount,
            baseline: refundBaseline,
            direction: 'up' as const,
          },
        ]
      : []),
  ];

  const metrics: MetricResult[] = rawMetrics.map(m => {
    const delta = deltaPercent(m.current, m.baseline);
    return {
      metric: m.metric,
      current7d: m.current,
      baseline28d: m.baseline,
      deltaPercent: delta,
      severity: classifySeverity(delta, m.direction),
    };
  });

  const anomalies = metrics.filter(m => m.severity !== null);

  if (anomalies.length === 0) {
    logger.info({ storeId }, 'profit-anomaly-scan: no anomalies detected');
    return { detected: 0, p0Count: 0 };
  }

  // ---- 6. Load store info for alert context ----
  const store = await withStore(storeId, tx =>
    tx.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { id: true, name: true, slug: true },
    })
  );

  // ---- 7. Gather context for Gemini explanations ----
  const [recentInventoryChanges, recentRefunds, topCoupons] = await Promise.all([
    db.inventoryHistory.findMany({
      where: { storeId, createdAt: { gte: window7dStart } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { productId: true, type: true, quantity: true },
    }),
    db.payment.findMany({
      where: {
        order: { storeId },
        status: 'refunded',
        paidAt: { gte: window7dStart },
      },
      orderBy: { paidAt: 'desc' },
      take: 5,
      select: { refundedAmount: true, paidAt: true },
    }),
    db.coupon.findMany({
      where: { storeId },
      orderBy: { usageCount: 'desc' },
      take: 5,
      select: { code: true, usageCount: true },
    }),
  ]);

  const context = { recentInventoryChanges, recentRefunds, topCoupons };

  // ---- 8. Call Gemini for each anomaly ----
  let detected = 0;
  let p0Count = 0;

  for (const anomaly of anomalies) {
    const prompt = `You are a retail finance analyst for an Egypt e-commerce store. A profit anomaly was detected. Given the context, explain in 1-2 sentences (English and Arabic) the LIKELY cause and what the merchant should investigate.

Anomaly: ${JSON.stringify({
      metric: anomaly.metric,
      current7d: anomaly.current7d,
      baseline28d: anomaly.baseline28d,
      deltaPercent: (anomaly.deltaPercent * 100).toFixed(1) + '%',
      severity: anomaly.severity,
    })}
Context: ${JSON.stringify(context)}

Return STRICT JSON: { "explanationEn": "...", "explanationAr": "...", "likelyCause": "cost|refund|coupon|demand" }`;

    let explanation: GeminiExplanation;
    try {
      explanation = await callGemini<GeminiExplanation>({
        prompt,
        feature: 'profit-anomaly',
        storeId,
      });
    } catch (err) {
      logger.warn(
        { err, storeId, metric: anomaly.metric },
        'profit-anomaly-scan: Gemini call failed, using fallback explanation'
      );
      explanation = {
        explanationEn: `A ${anomaly.metric.replace('_', ' ')} was detected (${(anomaly.deltaPercent * 100).toFixed(1)}% change). Please review your recent orders, costs, and refunds.`,
        explanationAr: `تم اكتشاف شذوذ في ${anomaly.metric.replace('_', ' ')} (تغيير ${(anomaly.deltaPercent * 100).toFixed(1)}٪). يرجى مراجعة الطلبات الأخيرة والتكاليف والمبالغ المستردة.`,
        likelyCause: 'demand',
      };
    }

    // ---- 9. Insert ProfitAnomaly row ----
    await sw.profitAnomaly.create({
      data: {
        storeId,
        scope: AnomalyScope.store,
        scopeId: null,
        metric: anomaly.metric,
        current7d: anomaly.current7d,
        baseline28d: anomaly.baseline28d,
        deltaPercent: anomaly.deltaPercent,
        severity: anomaly.severity!,
        explanationEn: explanation.explanationEn,
        explanationAr: explanation.explanationAr,
      },
    });

    detected++;
    if (anomaly.severity === 'p0') p0Count++;

    // ---- 10. P0 alert — deduplicated per (storeId, metric) in last 24h ----
    if (anomaly.severity === 'p0') {
      const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      // Count p0 anomalies for this (storeId, metric) in last 24h.
      // Our just-inserted row counts as 1 — if count > 1 a duplicate already fired.
      const p0Count24h = await db.profitAnomaly.count({
        where: {
          storeId,
          metric: anomaly.metric,
          severity: 'p0',
          detectedAt: { gte: since24h },
        },
      });

      if (p0Count24h <= 1) {
        // Only our new row → fire the alert
        await sendAlert({
          level: 'p0',
          scope: 'store',
          store: { id: store.id, name: store.name, slug: store.slug ?? undefined },
          source: 'cron.profit-anomaly',
          title: `Profit anomaly — ${store.name}`,
          body: explanation.explanationEn,
          context: {
            metric: anomaly.metric,
            current7d: anomaly.current7d,
            baseline28d: anomaly.baseline28d,
            deltaPercent: (anomaly.deltaPercent * 100).toFixed(1) + '%',
            likelyCause: explanation.likelyCause,
          },
        });
      } else {
        logger.info(
          { storeId, metric: anomaly.metric, p0Count24h },
          'profit-anomaly-scan: p0 alert suppressed — already fired in last 24h'
        );
      }
    }
  }

  logger.info({ storeId, detected, p0Count }, 'profit-anomaly-scan completed');
  return { detected, p0Count };
}

/** One anomaly of this store (the store filter makes a foreign id simply absent). */
export async function getProfitAnomaly(storeId: string, id: string) {
  const db = await storeDb(storeId);
  return db.profitAnomaly.findFirst({
    where: { id, storeId },
    select: {
      id: true,
      metric: true,
      severity: true,
      deltaPercent: true,
      explanationEn: true,
      explanationAr: true,
      acknowledged: true,
      detectedAt: true,
    },
  });
}

/** Marks one anomaly acknowledged (no-op when it already is). Shared by `POST /finance/anomalies/:id/acknowledge` and the assistant. */
export async function acknowledgeProfitAnomaly(storeId: string, id: string, userId: string | null) {
  const w = await storeWriter(storeId);
  return w.profitAnomaly.updateMany({
    where: { id, storeId, acknowledged: false },
    data: { acknowledged: true, acknowledgedBy: userId, acknowledgedAt: new Date() },
  });
}
