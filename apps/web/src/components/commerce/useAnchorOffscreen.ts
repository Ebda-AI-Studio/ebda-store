'use client';

import { useEffect, useState, type RefObject } from 'react';

/** True while `ref`'s element is NOT in the viewport, in EITHER direction (below the
 *  fold or scrolled past). It starts false and only flips on the IntersectionObserver
 *  callback, whose first call reports the element's real position, so a product whose
 *  button is already in view never flashes a bar, and one whose button is below the
 *  fold gets the bar from first paint. Stays false without IntersectionObserver. */
export function useAnchorOffscreen(ref: RefObject<Element | null>): boolean {
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setOffscreen(!e.isIntersecting), {
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return offscreen;
}
