'use client';

import { useEffect } from 'react';

/**
 * WCAG 2.4.11 Focus Not Obscured (STOP-2 a11y audit P1-1, re-audit R1). A header that sticks is
 * opaque, so a keyboard user walking backwards (Shift+Tab) used to land on elements parked under
 * it. This measures whichever element actually sticks and publishes its height as `--header-h` on
 * <html>; `html { scroll-padding-top }` (globals.css) then keeps the browser's focus scroll clear
 * of it. The sticky element is either ShopChrome's zone wrapper (the merchant's "Sticky header"
 * setting, any skin) or the skin's own `<header>` (a skin that sticks by its own class), so it
 * holds for every template, Dahab included. Renders nothing. The auto-hiding minimal header also
 * re-shows itself when focus enters it (its own onFocus).
 */
export function StickyHeaderOffset() {
  useEffect(() => {
    const wrapper = document.querySelector<HTMLElement>('[data-zone="header"]');
    const header =
      wrapper?.querySelector<HTMLElement>('header') ??
      document.querySelector<HTMLElement>('header');
    const nodes = [wrapper, header].filter((n): n is HTMLElement => !!n);
    if (nodes.length === 0) return;
    const root = document.documentElement;
    const apply = () => {
      // the wrapper wins: when it sticks, its box is the whole header region
      const sticky = nodes.find(n => getComputedStyle(n).position === 'sticky');
      root.style.setProperty('--header-h', sticky ? `${Math.ceil(sticky.offsetHeight)}px` : '0px');
    };
    apply();
    const ro = new ResizeObserver(apply);
    for (const n of nodes) ro.observe(n);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--header-h');
    };
  }, []);
  return null;
}
