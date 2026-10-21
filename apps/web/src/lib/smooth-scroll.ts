/**
 * Old-browser-safe horizontal scroll helpers.
 *
 * Some ancient / embedded webviews (IE11-class, old in-app browsers, some
 * bots) lack `Element.scrollTo` / `Element.scrollBy` — the smooth-scroll
 * options form — which surfaced as `TypeError: scrollTo is not a function`
 * from the storefront carousel autoplay + PDP gallery once PostHog error
 * autocapture was enabled. When the method is missing we fall back to an
 * instant `scrollLeft` assignment so the UI still moves (just without the
 * smooth animation) instead of throwing.
 */
/** STOP-2 a11y M2: a user who asked for reduced motion gets an instant jump, never a glide. */
const scrollBehavior = (): ScrollBehavior =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';

export function smoothScrollLeftTo(el: HTMLElement, left: number): void {
  if (typeof el.scrollTo === 'function') {
    el.scrollTo({ left, behavior: scrollBehavior() });
  } else {
    el.scrollLeft = left;
  }
}

export function smoothScrollLeftBy(el: HTMLElement, left: number): void {
  if (typeof el.scrollBy === 'function') {
    el.scrollBy({ left, behavior: scrollBehavior() });
  } else {
    el.scrollLeft += left;
  }
}
