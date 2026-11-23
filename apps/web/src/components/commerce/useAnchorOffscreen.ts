'use client';

import { useEffect, useState, type RefObject } from 'react';

/** Pixels the fixed BottomTabBar covers at the bottom of the viewport: `--bottom-tab-h` plus
 *  the safe-area inset. Measured through a throwaway probe because both are CSS values
 *  (`env()` cannot be read from script any other way). 0 when nothing resolves. */
export function measureBottomObstruction(): number {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;' +
    'height:calc(var(--bottom-tab-h, 0px) + env(safe-area-inset-bottom, 0px))';
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return Number.isFinite(h) ? Math.round(h) : 0;
}

/** True while `ref`'s element is NOT reachable on screen, in EITHER direction (below the
 *  fold or scrolled past). "Reachable" means above the fixed bottom tab bar: the observer's
 *  bottom edge is pulled up by the tab bar + safe-area height, so a button hidden under the
 *  bar counts as off-screen and the sticky bar covers for it (B0-49). It starts false and
 *  only flips on the IntersectionObserver callback, whose first call reports the element's
 *  real position, so a product whose button is already reachable never flashes a bar, and
 *  one whose button is below the fold gets the bar from first paint. The observer is rebuilt
 *  on resize/rotation because the obstruction changes with the safe-area inset. Stays false
 *  without IntersectionObserver. */
export function useAnchorOffscreen(ref: RefObject<Element | null>): boolean {
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let io: IntersectionObserver | undefined;
    const observe = () => {
      io?.disconnect();
      io = new IntersectionObserver(([e]) => setOffscreen(!e.isIntersecting), {
        // 1 = the whole row must be inside the reachable area: a button half-covered by the
        // tab bar (or clipped at the top) is not reachable, so the bar stays up for it.
        threshold: 1,
        rootMargin: `0px 0px ${-measureBottomObstruction()}px 0px`,
      });
      io.observe(el);
    };
    observe();
    window.addEventListener('resize', observe);
    return () => {
      window.removeEventListener('resize', observe);
      io?.disconnect();
    };
  }, [ref]);
  return offscreen;
}
