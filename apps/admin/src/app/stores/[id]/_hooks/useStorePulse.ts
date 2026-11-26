'use client';

import { useCallback, useEffect, useState } from 'react';
import { reportRangeQueryString } from '@ebda/shared';
import { apiGet } from '../../../../lib/api';
import { useLatestRequest } from '../../../../hooks/useLatestRequest';
import { resolveDateRange, type Period } from '../analytics/_components/types';

/** The four presets the dashboard offers; the full picker lives on the analytics page. */
export const PULSE_PERIODS = [
  'today',
  'last_7',
  'last_30',
  'this_month',
] as const satisfies readonly Period[];
export type PulsePeriod = (typeof PULSE_PERIODS)[number];

const PERIOD_KEY = 'ebda.dashboard.pulsePeriod';

function readStoredPeriod(): PulsePeriod {
  try {
    const v = window.sessionStorage.getItem(PERIOD_KEY);
    return (PULSE_PERIODS as readonly string[]).includes(v ?? '') ? (v as PulsePeriod) : 'last_7';
  } catch {
    return 'last_7';
  }
}

/** The selected period survives a language switch (a reload) for the tab's session; defaults to 7 days. */
export function usePulsePeriod(): [PulsePeriod, (p: PulsePeriod) => void] {
  const [period, setPeriodState] = useState<PulsePeriod>(() =>
    typeof window === 'undefined' ? 'last_7' : readStoredPeriod()
  );
  const setPeriod = useCallback((p: PulsePeriod) => {
    setPeriodState(p);
    try {
      window.sessionStorage.setItem(PERIOD_KEY, p);
    } catch {
      /* storage unavailable: the choice just lasts until reload */
    }
  }, []);
  return [period, setPeriod];
}

export interface PulseStats {
  totalRevenue: number;
  totalOrders: number;
  totalCustomers: number;
  averageOrderValue: number;
  /** Orders per product view, percent. `null` = no visit data yet (never a fabricated 0). */
  conversionRate: number | null;
  revenueChange: number;
  ordersChange: number;
  customersChange: number;
  /** Absent on an older cached API response; 0 means the change is not a percentage. */
  previousRevenue?: number;
  previousOrders?: number;
}

export interface PulseSalesPoint {
  date: string;
  revenue: number;
  orders: number;
}

export interface PulseTopProduct {
  id: string;
  name: string;
  nameAr?: string | null;
  revenue: number;
  quantity: number;
  image?: string;
}

export interface PulseUnpaid {
  orders: number;
  revenue: number;
}

/** `null` = still loading, `'error'` = could not be read (never rendered as zero). */
export type Slice<T> = T | null | 'error';

export interface StorePulse {
  stats: Slice<PulseStats>;
  sales: Slice<PulseSalesPoint[]>;
  topProducts: Slice<PulseTopProduct[]>;
  unpaid: Slice<PulseUnpaid>;
}

const LOADING: StorePulse = { stats: null, sales: null, topProducts: null, unpaid: null };

/**
 * Period-scoped numbers for the dashboard's "how is the store doing" block. Every endpoint already exists
 * (analytics dashboard / sales / top-products / payment-status). Staleness class: BOUNDED-stale - the API caches
 * the dashboard aggregate for 120 s (`getDashboardStats`), so a sale can take up to two minutes to show here; the
 * merchant's order inbox (NeedsAction) is live and is what to act on. Each slice fails on its own so one broken
 * query never blanks the page, and a switch of period discards the older in-flight response.
 */
export function useStorePulse(storeId: string, period: PulsePeriod) {
  const [pulse, setPulse] = useState<StorePulse>(LOADING);
  const [tick, setTick] = useState(0);
  const beginRequest = useLatestRequest();
  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!storeId) return;
    const isLatest = beginRequest();
    const base = `/api/v1/stores/${storeId}/analytics`;
    const rangeQs = reportRangeQueryString(resolveDateRange(period));
    const tzOffset = -new Date().getTimezoneOffset();
    const set = <K extends keyof StorePulse>(key: K, value: StorePulse[K]) => {
      if (isLatest()) setPulse(prev => ({ ...prev, [key]: value }));
    };
    setPulse(LOADING);

    void apiGet<{ stats: PulseStats | null; failed?: string[] }>(
      `${base}/dashboard?${rangeQs}`
    ).then(({ data, error }) =>
      set('stats', error || !data?.stats || data.failed?.includes('stats') ? 'error' : data.stats)
    );
    void apiGet<{ sales: PulseSalesPoint[] }>(
      `${base}/sales?period=${period}&${rangeQs}&tzOffset=${tzOffset}`
    ).then(({ data, error }) => set('sales', error || !data ? 'error' : data.sales));
    void apiGet<{ products: PulseTopProduct[] }>(`${base}/top-products?limit=5&${rangeQs}`).then(
      ({ data, error }) => set('topProducts', error || !data ? 'error' : data.products)
    );
    void apiGet<{ payments: { status: string; revenue: number; orders: number }[] }>(
      `${base}/payment-status?${rangeQs}`
    ).then(({ data, error }) => {
      if (error || !data) return set('unpaid', 'error');
      const row = data.payments.find(p => p.status === 'pending');
      set('unpaid', { orders: row?.orders ?? 0, revenue: row?.revenue ?? 0 });
    });
  }, [storeId, period, tick, beginRequest]);

  return { pulse, reload };
}
