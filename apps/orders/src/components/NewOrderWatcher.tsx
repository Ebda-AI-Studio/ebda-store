'use client';

import { useEffect, useRef } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { useLanguage } from '@/contexts/LanguageContext';

/**
 * New-order alert for v1: a lightweight in-app watcher. The parent (orders
 * list) polls and passes the newest pending-order id + a monotonically
 * increasing snapshot. When a NEW pending order id appears that we haven't seen
 * before, we beep (Web Audio) + toast.
 *
 * v2 will add real push delivery (the service worker already has a `push`
 * handler) once an OneSignal/VAPID app is provisioned for this PWA — at which
 * point this in-app watcher becomes the in-foreground complement to background
 * push. Documented as deferred in the plan.
 */
export function NewOrderWatcher({ latestPendingId }: { latestPendingId: string | null }) {
  const { notify } = useToast();
  const { t } = useLanguage();
  const seenRef = useRef<string | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!latestPendingId) return;

    // First observation establishes the baseline silently — we don't beep for
    // orders that already existed when the app opened.
    if (!initializedRef.current) {
      seenRef.current = latestPendingId;
      initializedRef.current = true;
      return;
    }

    if (latestPendingId !== seenRef.current) {
      seenRef.current = latestPendingId;
      notify(t.orders.newOrderToast, 'success');
      beep();
    }
  }, [latestPendingId, notify, t.orders.newOrderToast]);

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
