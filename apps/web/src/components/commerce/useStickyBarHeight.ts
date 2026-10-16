'use client';

import { useEffect, useLayoutEffect, type RefObject } from 'react';

// useLayoutEffect on the client (the tab bar must be gone in the SAME frame the task bar
// appears, or the two stack for one paint); useEffect on the server, where neither runs.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * A phone TASK bar (PDP buy bar, Dahab pinned bar, cart total bar) while `active`:
 *
 * - marks `<html data-task-bar>`: the BottomTabBar hides and the task bar takes its place
 *   at the bottom edge (C-04 — at most one fixed-bottom layer; the two used to stack and
 *   cover the first selector and the promo field);
 * - publishes the bar's real height (safe-area padding included) as `--sticky-bar-h` on
 *   `<html>`, which feeds `html { scroll-padding-bottom }` (focus and scrollIntoView never
 *   land a field under the bar) and the toast/floating-widget lift in globals.css, so none
 *   of them is a hardcoded guess that drifts when a skin's bar is taller (Dahab) or carries
 *   a message line (cart).
 *
 * Both are cleared when the bar hides or unmounts.
 */
export function useStickyBarHeight(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const root = document.documentElement;
    root.dataset.taskBar = '1';
    const publish = () => root.style.setProperty('--sticky-bar-h', `${el.offsetHeight}px`);
    publish();
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(publish);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty('--sticky-bar-h');
      delete root.dataset.taskBar;
    };
  }, [ref, active]);
}
