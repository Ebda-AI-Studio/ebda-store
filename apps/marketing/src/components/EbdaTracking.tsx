'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import type { Tracker } from '@ebda/shared/tracking-browser';

/**
 * Loads the tracker AFTER the page is interactive-ready: the tracking client (consent banner, Meta/PostHog loaders) is a
 * dynamic chunk the static HTML never lists, so it stays out of the up-front JS budget (P14) and off the LCP path.
 * `run` fires when the window has loaded and the browser is idle (or after 2 s at the latest).
 */
function whenIdle(run: () => void): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, o: object) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  const fire = () => {
    if (!cancelled) run();
  };
  const go = () => {
    if (w.requestIdleCallback) idle = w.requestIdleCallback(fire, { timeout: 2000 });
    else timer = setTimeout(fire, 200);
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener('load', go);
    if (idle !== undefined) w.cancelIdleCallback?.(idle);
    if (timer !== undefined) clearTimeout(timer);
  };
}

async function tracker(): Promise<Tracker | null> {
  return (await import('@/lib/tracker')).getTracker();
}

/**
 * Consent-gated acquisition tracking for ebda.app: cookie banner, PageView on every route,
 * ViewContent when the pricing section first scrolls into view. Renders nothing itself.
 * See docs/ebda/ads-tracking.md.
 */
export function EbdaTracking() {
  const pathname = usePathname();

  useEffect(() => {
    return whenIdle(() => {
      void tracker().then(t => {
        if (!t) return;
        t.start();
        t.showBanner();
        t.pageView();
      });
    });
  }, [pathname]);

  useEffect(() => {
    const el = document.getElementById('pricing');
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          io.disconnect();
          void tracker().then(t =>
            t?.track('pricing_viewed', { props: { content_name: 'pricing' } })
          );
        }
      },
      { threshold: 0.3 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [pathname]);

  return null;
}
