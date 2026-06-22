'use client';

import { useEffect, useRef } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { useLanguage } from '@/contexts/LanguageContext';

/**
 * In-app new-order alert (foreground complement to background VAPID push).
 *
 * The parent passes the id of the NEWEST order in the confirmed-only list.
 * When a new order id appears that wasn't there on the previous poll tick, we
 * beep (Web Audio API) and show a toast. The first observation after mount
 * establishes a silent baseline so we don't alert on orders that already
 * existed when the app opened.
 *
 * Why latestOrderId (not latestPendingId): with the confirmed-only filter
 * active on the orders PWA, unconfirmed pending+unpaid online orders are
 * excluded from the list. Tracking the newest order in the response (which
 * is sorted newest-first) catches both:
 *   - COD orders landing as status=pending (no online Payment row — included)
 *   - Online orders arriving as status=confirmed after payment succeeds
 *
 * Background push (VAPID, `orders_app` audience) is the primary out-of-band
 * delivery path when the app is closed/backgrounded — see lib/push.ts and
 * the order-created Inngest fanout. This component is the in-foreground layer.
 */
export function NewOrderWatcher({ latestOrderId }: { latestOrderId: string | null }) {
  const { notify } = useToast();
  const { t } = useLanguage();
  const seenRef = useRef<string | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!latestOrderId) return;

    // First observation after mount — establish baseline silently.
    if (!initializedRef.current) {
      seenRef.current = latestOrderId;
      initializedRef.current = true;
      return;
    }

    if (latestOrderId !== seenRef.current) {
      seenRef.current = latestOrderId;
      notify(t.orders.newOrderToast, 'success');
      beep();
    }
  }, [latestOrderId, notify, t.orders.newOrderToast]);

  return null;
}

function beep() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.42);
    osc.onended = () => ctx.close().catch(() => undefined);
  } catch {
    // Audio may be blocked until the user interacts — non-fatal.
  }
}
