'use client';

import { useEffect, type RefObject } from 'react';

/** Publishes the sticky bar's real height as `--sticky-bar-h` on <body> while `active`, so
 *  the toast region and floating widget (globals.css) lift by exactly the bar they must
 *  clear instead of a hardcoded guess that drifts when a skin's bar is taller (Dahab) or
 *  carries a message line (cart). Without the var, globals.css falls back to the default
 *  bar's height. */
export function useStickyBarHeight(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const publish = () => document.body.style.setProperty('--sticky-bar-h', `${el.offsetHeight}px`);
    publish();
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(publish);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      document.body.style.removeProperty('--sticky-bar-h');
    };
  }, [ref, active]);
}
