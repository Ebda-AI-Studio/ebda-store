'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiPost } from '../../lib/api';

/**
 * Handles the browser coming back from the hosted card-save page
 * (`?card=return`). The return URL is only a hint: success is whatever `poll`
 * says (the signed webhook flips `hasPaymentMethod`), checked up to 6 times,
 * 3s apart. With the local stub provider the URL carries `stub=1` and a
 * `merchantOrderId`; then nothing happens until the dev presses a simulate
 * button, which confirms the stub order and starts polling.
 */
export type CardReturnState = 'idle' | 'pending' | 'ok' | 'failed' | 'later';

const POLLS = 6;
const POLL_MS = 3000;

export interface CardReturn {
  state: CardReturnState;
  /** Set only for the local stub provider (dev). */
  stubOrderId: string | null;
  simulate: (outcome: 'success' | 'failure') => Promise<void>;
  busy: boolean;
}

export function useCardReturn(
  storeId: string | undefined,
  /** Resolves true once the card is saved. Called repeatedly. */
  poll: () => Promise<boolean>
): CardReturn {
  const [state, setState] = useState<CardReturnState>('idle');
  const [stubOrderId, setStubOrderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const cancelled = useRef(false);

  const run = useCallback(async () => {
    setState('pending');
    for (let i = 0; i < POLLS; i++) {
      if (cancelled.current) return;
      if (await pollRef.current()) {
        if (!cancelled.current) setState('ok');
        return;
      }
      if (i < POLLS - 1) await new Promise(res => setTimeout(res, POLL_MS));
    }
    if (!cancelled.current) setState('later');
  }, []);

  useEffect(() => {
    cancelled.current = false;
    if (!storeId || typeof window === 'undefined') return;
    const qs = new URLSearchParams(window.location.search);
    if (qs.get('card') !== 'return') return;
    const orderId = qs.get('stub') === '1' ? qs.get('merchantOrderId') : null;
    if (orderId) {
      setStubOrderId(orderId);
      setState('pending');
    } else {
      void run();
    }
    return () => {
      cancelled.current = true;
    };
  }, [storeId, run]);

  // Once settled, drop the return params so a refresh does not replay the check.
  // (Not on mount: a StrictMode remount would then find nothing to check.)
  useEffect(() => {
    if (state !== 'ok' && state !== 'failed' && state !== 'later') return;
    try {
      const url = new URL(window.location.href);
      for (const k of ['card', 'stub', 'merchantOrderId']) url.searchParams.delete(k);
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    } catch {
      // History API unavailable: harmless, the check may run again on refresh.
    }
  }, [state]);

  const simulate = useCallback(
    async (outcome: 'success' | 'failure') => {
      if (!storeId || !stubOrderId) return;
      setBusy(true);
      const { error } = await apiPost(`/api/v1/stores/${storeId}/billing/checkout/stub-confirm`, {
        merchantOrderId: stubOrderId,
        outcome,
      });
      setBusy(false);
      if (error || outcome === 'failure') {
        setState('failed');
        return;
      }
      await run();
    },
    [storeId, stubOrderId, run]
  );

  return { state, stubOrderId, simulate, busy };
}

/** Start the hosted card-save redirect. Resolves an error code, or never returns on success. */
export async function startCardSetup(
  storeId: string,
  from: 'onboarding' | 'billing'
): Promise<{ code: string } | null> {
  const { data, error } = await apiPost<{ redirectUrl: string }>(
    `/api/v1/stores/${storeId}/billing/card-setup`,
    { from }
  );
  if (error || !data) return { code: error?.code ?? 'ERROR' };
  window.location.href = data.redirectUrl;
  return null;
}
