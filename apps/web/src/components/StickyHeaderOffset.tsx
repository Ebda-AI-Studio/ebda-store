'use client';

import { useEffect } from 'react';

/**
 * WCAG 2.4.11 Focus Not Obscured (STOP-2 a11y audit P1-1). Every template's header is `sticky top-0`
 * and opaque, so a keyboard user walking backwards (Shift+Tab) used to land on elements parked
 * under it. This measures the header and publishes its height as `--header-h` on <html>;
 * `html { scroll-padding-top }` (globals.css) then keeps the browser's own focus scroll clear of it.
 * Platform-wide (one component in ShopChrome, no per-template code); renders nothing. The
 * auto-hiding minimal header also re-shows itself when focus enters it (its own onFocus).
 */
export function StickyHeaderOffset() {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>('header');
    if (!header) return;
    const root = document.documentElement;
    const apply = () => {
      const sticky = getComputedStyle(header).position === 'sticky';
      root.style.setProperty('--header-h', sticky ? `${Math.ceil(header.offsetHeight)}px` : '0px');
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(header);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--header-h');
    };
  }, []);
  return null;
}
