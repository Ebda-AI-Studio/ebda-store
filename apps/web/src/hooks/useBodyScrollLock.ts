import { useEffect } from 'react';

/**
 * Lock background scrolling while a modal surface (e.g. the products filter
 * bottom-sheet) is open, and restore the previous values on close.
 *
 * `overflow: hidden` on <body> alone does NOT stop mobile pull-to-refresh — a
 * downward drag near the top still reloads the page, which is the "scroll the
 * whole page and refresh it" bug. `overscroll-behavior: none` on the root element
 * kills pull-to-refresh and scroll-chaining, so taps and drags inside the open
 * sheet cannot refresh the page.
 *
 * Both previous values are captured and restored rather than reset to a constant,
 * so this composes with any other code that has set them.
 */
export function useBodyScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    const body = document.body;
    const root = document.documentElement;
    const prevOverflow = body.style.overflow;
    const prevOverscroll = root.style.overscrollBehavior;
    body.style.overflow = 'hidden';
    root.style.overscrollBehavior = 'none';
    return () => {
      body.style.overflow = prevOverflow;
      root.style.overscrollBehavior = prevOverscroll;
    };
  }, [locked]);
}
