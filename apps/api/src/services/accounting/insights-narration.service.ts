/**
 * Insights Narration Service — Accounting Batch 4
 *
 * Reads the latest snapshot rows for a store and asks Gemini Flash Lite
 * to produce a 1-2 sentence bilingual narrative (EN + AR).
 *
 * Returns null when:
 *   - Store.aiNarrationEnabled is false
 *   - There is insufficient data (< min required rows)
 *   - Gemini errors out (graceful — callers show raw numbers instead)
 *
 * Narration is intentionally computed on-demand (per page load) rather than
 * cached in a DB table. The rollup runs once a day so the underlying data
 * is stable; HTTP-level caching (5 min max-age on the dashboard endpoint)
 * keeps Gemini call counts low.
 */

import { currentStoreId, prisma, runInStoreScope, withStore } from '@ebda/database';
import { storeDb } from '../../lib/repo-factory';
import { callGemini } from './gemini-ai.service';
import logger from '../../lib/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NarrationScope = 'cohort' | 'funnel' | 'segment';

export interface Narration {
  en: string;
  ar: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generates a bilingual insight narrative for the given scope.
 *
 * Returns null on any of: narration disabled, too few rows, Gemini error.
 * Never throws.
 */
export async function generateInsightNarration(
  storeId: string,
  scope: NarrationScope
): Promise<Narration | null> {
  // The snapshot tables read below (customer_cohort_snapshots,
  // customer_rfm_snapshots, funnel_snapshots) carry STRICT RLS policies, and
  // insights.routes.ts runs this as a sibling of its `runInTenantContext`
  // reads, i.e. with no context: under `ebda_app` every narration came back
  // null. A store scope, not a transaction, because a Gemini call sits
  // between the reads.
  if (!UUID_RE.test(storeId)) return null;
  return runInStoreScope(storeId, () => narrate(storeId, scope));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function narrate(storeId: string, scope: NarrationScope): Promise<Narration | null> {
  // Check store-level opt-in
  let store: { aiNarrationEnabled: boolean; name: string } | null = null;
  try {
    store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { aiNarrationEnabled: true, name: true },
      })
    );
  } catch (err) {
    logger.warn({ err, storeId, scope }, 'insights-narration: failed to load store');
    return null;
  }

  if (!store?.aiNarrationEnabled) return null;

  try {
    if (scope === 'cohort') return await narrateCohort(storeId, store.name);
    if (scope === 'funnel') return await narrateFunnel(storeId, store.name);
    return await narrateSegment(storeId, store.name);
  } catch (err) {
    // Graceful fallback — UI shows raw numbers without narration
    logger.warn({ err, storeId, scope }, 'insights-narration: gemini call failed, returning null');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scope-specific helpers
// ---------------------------------------------------------------------------

async function narrateCohort(storeId: string, storeName: string): Promise<Narration | null> {
  // Top 6 cohorts by month-3 retention (periodOffset = 3)
  const cohorts = await (
    await storeDb(currentStoreId())
  ).customerCohortSnapshot.findMany({
    where: { storeId, periodOffset: 3 },
    orderBy: { cohortMonth: 'desc' },
    take: 6,
  });

  if (cohorts.length < 2) return null;

  const prompt = `Summarize in 1-2 sentences (English + Arabic) any notable retention trend across these monthly cohorts for the store "${storeName}". Each row shows the cohort month, period offset 3 (3 months after first order), active customer count, and cohort total.\n\nData: ${JSON.stringify(
    cohorts.map(c => ({
      month: c.cohortMonth,
      active: c.customersActive,
      total: c.customersTotal,
    }))
  )}\n\nReturn STRICT JSON: { "en": "...", "ar": "..." }`;

  return callGemini<Narration>({ prompt, feature: 'insights-narration-cohort', storeId });
}

async function narrateFunnel(storeId: string, storeName: string): Promise<Narration | null> {
  const funnels = await (
    await storeDb(currentStoreId())
  ).funnelSnapshot.findMany({
    where: { storeId },
    orderBy: { periodDate: 'desc' },
    take: 14,
  });

  if (funnels.length < 3) return null;

  const prompt = `Summarize in 1-2 sentences (English + Arabic) any notable change in the checkout funnel for "${storeName}". Compare yesterday's data vs the 7-day trailing average. Drop-off rates between steps are the most important signal.\n\nData (newest first): ${JSON.stringify(
    funnels.map(f => ({
      date: f.periodDate,
      carts: f.cartsCreated,
      checkouts: f.checkoutsStarted,
      completed: f.ordersCompleted,
      abandoned: f.ordersAbandoned,
    }))
  )}\n\nReturn STRICT JSON: { "en": "...", "ar": "..." }`;

  return callGemini<Narration>({ prompt, feature: 'insights-narration-funnel', storeId });
}

async function narrateSegment(storeId: string, storeName: string): Promise<Narration | null> {
  const segments = await (
    await storeDb(currentStoreId())
  ).customerRfmSnapshot.groupBy({
    by: ['segment'],
    where: { storeId },
    _count: { id: true },
    _sum: { monetaryFils: true },
  });

  if (segments.length === 0) return null;

  // Customers who moved between segments (movers reveal churn/recovery signals)
  const movers = await (
    await storeDb(currentStoreId())
  ).customerRfmSnapshot.findMany({
    where: { storeId, previousSegment: { not: null } },
    select: { segment: true, previousSegment: true },
    take: 100,
  });
  const moves = movers.filter(m => m.previousSegment && m.previousSegment !== m.segment);

  const prompt = `Summarize in 1-2 sentences (English + Arabic) the customer segment health for "${storeName}". Segments: ${JSON.stringify(
    segments.map(s => ({
      segment: s.segment,
      count: s._count.id,
      revenue: Number(s._sum.monetaryFils ?? 0),
    }))
  )}. Notable segment movements (up to 5): ${JSON.stringify(moves.slice(0, 5))}\n\nReturn STRICT JSON: { "en": "...", "ar": "..." }`;

  return callGemini<Narration>({ prompt, feature: 'insights-narration-segment', storeId });
}
