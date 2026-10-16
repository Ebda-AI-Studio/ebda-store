'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useStore } from '../contexts/StoreContext';
import { api } from '../lib/api';
import type { PaymentConfigResponse } from '../lib/accepted-payment-badges';

const manualMethod = z
  .object({
    displayName: z.string().nullable().optional(),
    displayNameAr: z.string().nullable().optional(),
  })
  .nullable()
  .optional();
const paymentConfig = z.object({
  methods: z.record(z.string(), z.array(z.object({ code: z.string() }))).optional(),
  cod: manualMethod,
  instapay: manualMethod,
});

/**
 * What this store accepts, from its ACTUAL `/payments/config` (the checkout's own
 * source): fresh per mount and per store, one retry after 1.5s. Unknown (loading,
 * failed, demo store, another tenant's stale answer) is `null`, and a caller must
 * render NOTHING for null: no cross-page cache or default may claim a payment
 * capability (the "We accept" badges, the Dahab footer marks, the PDP trust line).
 */
export function useStorePaymentConfig(): PaymentConfigResponse | null {
  const { store } = useStore();
  const storeId = store.id;
  const [loaded, setLoaded] = useState<{ storeId: string; config: PaymentConfigResponse } | null>(
    null
  );

  useEffect(() => {
    if (!storeId || storeId === 'demo') return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setLoaded(null);
    async function attempt(canRetry: boolean) {
      try {
        const result = await api.get<PaymentConfigResponse>('/payments/config');
        if (cancelled) return;
        const parsed = result.success ? paymentConfig.safeParse(result.data) : null;
        if (parsed?.success) {
          setLoaded({ storeId, config: parsed.data });
          return;
        }
      } catch {
        // Unknown availability must never render a guessed payment method.
      }
      if (!cancelled && canRetry) retry = setTimeout(() => void attempt(false), 1500);
    }
    void attempt(true);
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [storeId]);

  // A tenant change must hide the old tenant's answer before effects run.
  return loaded?.storeId === storeId ? loaded.config : null;
}
