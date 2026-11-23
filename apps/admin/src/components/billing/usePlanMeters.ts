'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '../../lib/api';
import { limitLevel, worstLevel, type LimitLevel } from '../../lib/plan-limits';

export type MeterKey = 'maxProducts' | 'maxStaff' | 'maxOrdersPerMonth' | 'maxStorageMb' | 'ai';

export interface PlanMeter {
  key: MeterKey;
  used: number;
  /** null never reaches a caller: unlimited meters are always `ok` and filtered out. */
  limit: number;
  level: Exclude<LimitLevel, 'ok'>;
  /** AI only: which cap is the tighter one. */
  window?: 'daily' | 'monthly';
}

interface BillingSlice {
  limits: Record<string, number | null | boolean | string>;
  usage: Record<string, number | null>;
}

interface AiSlice {
  today: number;
  thisMonth: number;
  dailyCap: number;
  monthlyCap: number;
}

/** Pure: billing `limits` + `usage` (the same payload the billing page meters) -> the meters at >= 80%. */
export function billingMeters(data: BillingSlice, keys: readonly MeterKey[]): PlanMeter[] {
  const out: PlanMeter[] = [];
  for (const key of keys) {
    if (key === 'ai') continue;
    const limit = data.limits[key];
    const used = data.usage[key];
    // unlimited (null) or an unreadable counter (null) never warns: unknown is not "full"
    if (typeof limit !== 'number' || typeof used !== 'number') continue;
    const level = limitLevel(used, limit);
    if (level !== 'ok') out.push({ key, used, limit, level });
  }
  return out;
}

/** Pure: the AI quota summary (the same payload AiUsageSummaryCard meters) -> a meter when either cap is >= 80%. */
export function aiMeter(s: AiSlice): PlanMeter | null {
  const caps: Array<['daily' | 'monthly', number, number]> = [];
  if (s.dailyCap > 0) caps.push(['daily', s.today, s.dailyCap]);
  if (s.monthlyCap > 0) caps.push(['monthly', s.thisMonth, s.monthlyCap]);
  let best: PlanMeter | null = null;
  for (const [window, used, limit] of caps) {
    const level = limitLevel(used, limit);
    if (level === 'ok') continue;
    if (!best || worstLevel(best.level, level) !== best.level) {
      best = { key: 'ai', used, limit, level, window };
    }
  }
  return best;
}

/** Fetches only the sources the requested keys need. Any failure (e.g. staff 403) yields no meters, never an error. */
export function usePlanMeters(storeId: string, keys: readonly MeterKey[]): PlanMeter[] {
  const [meters, setMeters] = useState<PlanMeter[]>([]);
  const dep = keys.join(',');
  useEffect(() => {
    let cancelled = false;
    const wanted = dep.split(',') as MeterKey[];
    (async () => {
      const found: PlanMeter[] = [];
      const jobs: Promise<void>[] = [];
      if (wanted.some(k => k !== 'ai')) {
        jobs.push(
          apiGet<BillingSlice>(`/api/v1/stores/${storeId}/billing`).then(({ data }) => {
            if (data?.limits && data.usage) found.push(...billingMeters(data, wanted));
          })
        );
      }
      if (wanted.includes('ai')) {
        jobs.push(
          apiGet<AiSlice>(`/api/v1/stores/${storeId}/ai/usage/summary`).then(({ data }) => {
            const m = data ? aiMeter(data) : null;
            if (m) found.push(m);
          })
        );
      }
      await Promise.all(jobs).catch(() => undefined);
      if (!cancelled) setMeters(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, dep]);
  return meters;
}
