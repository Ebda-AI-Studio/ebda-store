'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { useNotifications } from '../contexts/NotificationContext';

export const WHOLESALE_PENDING_CHANGED = 'ebda:wholesale-pending-changed';
export const WHOLESALE_APPLICATION_RECEIVED = 'wholesale.application.received';

export interface WholesaleSummary {
  pendingCount: number;
  oldestPendingHours: number | null;
  overdue: boolean;
}

/** Tell every badge on the page that a decision was made (the applications page calls this after approve / reject / revoke). */
export function notifyWholesalePendingChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(WHOLESALE_PENDING_CHANGED));
}

/**
 * The number of wholesale applications waiting for the merchant (B2B review I5), for the badge on the "Wholesale
 * applications" tab and the customers tab. Reads `GET .../wholesale-applications/summary` and refreshes when the server pushes
 * a `wholesale.application.received` notification over the store socket, when a decision is made on this page, and on a slow
 * poll. `enabled` false (the store is not on the plan) makes no request at all.
 */
export function useWholesalePending(
  storeId: string | undefined,
  enabled: boolean
): WholesaleSummary | null {
  const [summary, setSummary] = useState<WholesaleSummary | null>(null);
  const { notifications } = useNotifications();
  const lastNotificationId = notifications.find(n => n.type === WHOLESALE_APPLICATION_RECEIVED)?.id;

  const load = useCallback(async () => {
    if (!storeId || !enabled) return;
    const { data } = await apiGet<WholesaleSummary>(
      `/api/v1/stores/${storeId}/wholesale-applications/summary`
    );
    if (data) setSummary(data);
  }, [storeId, enabled]);

  useEffect(() => {
    void load();
  }, [load, lastNotificationId]);

  useEffect(() => {
    if (!enabled) return;
    const onChanged = () => void load();
    window.addEventListener(WHOLESALE_PENDING_CHANGED, onChanged);
    const timer = window.setInterval(() => void load(), 5 * 60_000);
    return () => {
      window.removeEventListener(WHOLESALE_PENDING_CHANGED, onChanged);
      window.clearInterval(timer);
    };
  }, [enabled, load]);

  return enabled ? summary : null;
}
