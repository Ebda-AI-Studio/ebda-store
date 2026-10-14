'use client';

import { useEffect, useState, type RefObject } from 'react';

/** False only once `ref`'s element has scrolled out of view ABOVE the viewport
 *  (same rule as Dahab's pinned bar: a button still below the fold counts as
 *  not-yet-passed, so a sticky bar never competes with first paint). Starts true
 *  (and stays true without IntersectionObserver). */
export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([e]) => setInView(e.isIntersecting || (e.boundingClientRect?.top ?? -1) > 0),
      { threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}
