'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Reset scroll to the top of the page on every route change.
 *
 * Why this is needed (2026-06-05): the root `<body>` carries `overflow-x-hidden`
 * (layout.tsx — prevents horizontal scroll from wide hero/section content).
 * Per the CSS overflow spec, setting one axis to a non-`visible` value computes
 * the other axis to `auto`, so `<body>` becomes the actual scroll container
 * instead of the viewport. Next.js App Router's built-in scroll-to-top targets
 * `window` / `document.documentElement`, which is NOT the body scroller — so
 * navigations kept the previous scroll position and pages "loaded into the
 * middle" instead of the start.
 *
 * Fix: on every `pathname` change, force all three candidate scrollers to 0 so
 * the new page always starts at the top regardless of which element scrolls.
 * Hash links (`#section`) are left alone so in-page anchors still work.
 */
export function ScrollToTop() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Skip when navigating to an in-page hash target (preserve anchor jumps).
    if (window.location.hash) return;
    // Reset every possible scroller: the viewport, the documentElement, and
    // the body (the real scroller here because of `overflow-x-hidden`).
    window.scrollTo(0, 0);
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  }, [pathname]);

  return null;
}
