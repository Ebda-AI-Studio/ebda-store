/**
 * R-13 (W3): after a blocked checkout step, move FOCUS to the first error (its first field, else
 * the error itself), so a keyboard or screen-reader shopper lands on it, and scroll it to the centre
 * without animation under prefers-reduced-motion. Returns whether an error was found.
 */
export function focusFirstError(root: ParentNode = document): boolean {
  const el = root.querySelector<HTMLElement>('[data-error="true"]');
  if (!el) return false;
  let reduce = false;
  try {
    reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    /* no matchMedia: animate */
  }
  el.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  const field = el.matches('input, select, textarea, button')
    ? el
    : el.querySelector<HTMLElement>('input, select, textarea, button, [tabindex]');
  const target = field ?? el;
  if (!field && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  return true;
}
