'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { getTracker } from '@/lib/tracker';

/**
 * Consent-gated acquisition tracking for ebda.app: cookie banner, PageView on every route,
 * ViewContent when the pricing section first scrolls into view. Renders nothing itself.
 * See docs/ebda/ads-tracking.md.
 */
export function EbdaTracking() {
  const pathname = usePathname();

  useEffect(() => {
    const t = getTracker();
    if (!t) return;
    t.start();
    t.showBanner();
    t.pageView();
  }, [pathname]);

  useEffect(() => {
    const el = document.getElementById('pricing');
    const t = getTracker();
    if (!el || !t || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          t.track('pricing_viewed', { props: { content_name: 'pricing' } });
          io.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [pathname]);

  return null;
}
