'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { getEbdaTracker, isFunnelPath } from '../lib/ebda-tracker';

/** Consent banner + PageView for Ebda's own funnel pages. Renders nothing. */
export function EbdaFunnelTracking() {
  const pathname = usePathname();
  useEffect(() => {
    if (!isFunnelPath(pathname)) return;
    const t = getEbdaTracker();
    if (!t) return;
    t.start();
    t.showBanner();
    t.pageView();
  }, [pathname]);
  return null;
}
