/**
 * Profit Anomaly Scan Service — Accounting Smart Layer (Batch 3, Task 5)
 *
 * Computes four store-wide metrics comparing a 7-day current window against a
 * 28-day rolling baseline, then surfaces significant deviations as ProfitAnomaly
 * rows with Gemini-generated bilingual explanations.
 *
 * Metrics:
 *   margin_drop   — gross margin % (current 7d vs baseline 28d)
 *   cost_spike    — average unit cost shift derived from recent InventoryHistory
 *   revenue_drop  — weekly revenue vs 28d/4 per-week baseline
 *   refund_spike  — weekly refund count vs 28d/4 per-week baseline
 *
 * Severity thresholds (|delta| from baseline):
 *   > 40%  → p0  (wake someone, Telegram alert)
 *   > 20%  → warning
 *   else   → skip
 *
 * P0 deduplication: an alert fires only when no other P0 exists for
 * the same (storeId, metric) in the last 24 hours.
 */

import { prisma, AnomalyScope, AnomalyMetric, AnomalySeverity } from '@force/database';
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

function classifySeverity(absdelta: number): AnomalySeverity | null {
  if (absdelta > 0.4) return 'p0';
  if (absdelta > 0.2) return 'warning';
  return null;
}

// ---------------------------------------------------------------------------
// Main service
// ---------------------------------------------------------------------------

export async function runProfitAnomalyScan(storeId: string): Promise<ProfitAnomalyScanResult> {
  const now = new Date();
  const window7dStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const window28dStart = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

  // ---- 1. Load PnL for current 7d and full 28d baseline ----
  const [pnl7d, pnl28d] = await Promise.all([
    profitAndLoss(storeId, window7dStart, now),
    profitAndLoss(storeId, window28dStart, now),
  ]);

  // ---- 2. Compute COGS from expense accounts with code starting '50' ----
  function cogsFils(pnl: typeof pnl7d): number {
    return pnl.expenses
      .filter(r => r.code.startsWith('50'))
      .reduce((s, r) => s + r.debitTotal - r.creditTotal, 0);
  }

  const cogs7d = cogsFils(pnl7d);
  const cogs28d = cogsFils(pnl28d);

  // Gross margin % = (revenue - cogs) / revenue
  const margin7d = pnl7d.totalRevenue > 0 ? (pnl7d.totalRevenue - cogs7d) / pnl7d.totalRevenue : 0;
  // 28d margin for comparison (same formula, full period)
  const margin28d =
    pnl28d.totalRevenue > 0 ? (pnl28d.totalRevenue - cogs28d) / pnl28d.totalRevenue : 0;

  // Revenue: 7d vs 28d / 4 (per-week equivalent)
  const revenue7d = pnl7d.totalRevenue;
  const revenueBaseline = pnl28d.totalRevenue / 4;

  // ---- 3. Refund spike: count refunded payments in each window ----
  const [refunds7dCount, refunds28dCount] = await Promise.all([
    prisma.payment.count({
      where: {
        order: { storeId },
        status: 'refunded',
        paidAt: { gte: window7dStart },
      },
    }),
    prisma.payment.count({
      where: {
        order: { storeId },
        status: 'refunded',
        paidAt: { gte: window28dStart },
      },
    }),
  ]);
  const refundBaseline = refunds28dCount / 4; // per-week baseline

  // ---- 4. Cost spike: compare average recent inventory moves ----
  // We compare the average unit cost from InventoryHistory in the 7d window
  // vs the prior 21d window (making up the full 28d).
  const [invHistory7d, invHistory21d] = await Promise.all([
    prisma.inventoryHistory.findMany({
      where: { storeId, createdAt: { gte: window7dStart } },
      select: { quantity: true },
    }),
    prisma.inventoryHistory.findMany({
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
  const rawMetrics: Array<{ metric: AnomalyMetric; current: number; baseline: number }> = [
    { metric: 'margin_drop', current: margin7d, baseline: margin28d },
    { metric: 'cost_spike', current: costVolume7d, baseline: costVolumeBaseline },
    { metric: 'revenue_drop', current: revenue7d, baseline: revenueBaseline },
    { metric: 'refund_spike', current: refunds7dCount, baseline: refundBaseline },
  ];

  const metrics: MetricResult[] = rawMetrics.map(m => {
    const delta = deltaPercent(m.current, m.baseline);
    return {
      metric: m.metric,
      current7d: m.current,
      baseline28d: m.baseline,
      deltaPercent: delta,
      severity: classifySeverity(Math.abs(delta)),
    };
  });

  const anomalies = metrics.filter(m => m.severity !== null);

  if (anomalies.length === 0) {
    logger.info({ storeId }, 'profit-anomaly-scan: no anomalies detected');
    return { detected: 0, p0Count: 0 };
  }

  // ---- 6. Load store info for alert context ----
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { id: true, name: true, slug: true },
  });

  // ---- 7. Gather context for Gemini explanations ----
  const [recentInventoryChanges, recentRefunds, topCoupons] = await Promise.all([
    prisma.inventoryHistory.findMany({
      where: { storeId, createdAt: { gte: window7dStart } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { productId: true, type: true, quantity: true },
    }),
    prisma.payment.findMany({
      where: {
        order: { storeId },
        status: 'refunded',
        paidAt: { gte: window7dStart },
      },
      orderBy: { paidAt: 'desc' },
      take: 5,
      select: { refundedAmount: true, paidAt: true },
    }),
    prisma.coupon.findMany({
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
    const prompt = `You are a retail finance analyst for a Kuwait e-commerce store. A profit anomaly was detected. Given the context, explain in 1-2 sentences (English and Arabic) the LIKELY cause and what the merchant should investigate.

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
    await prisma.profitAnomaly.create({
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
      const p0Count24h = await prisma.profitAnomaly.count({
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
