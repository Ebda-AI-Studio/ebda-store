/**
 * DOM side of the admin search deep link (`?setting=<id>`): find the control a search result points
 * at, open the collapsed sections around it, scroll to it and ring it. Kept apart from the React
 * component so it is testable without rendering a page.
 */

export const HIGHLIGHT_CLASS = 'setting-highlight';
export const HIGHLIGHT_MS = 3200;
/** Pages fetch their data before the control exists: how long and how often to look for it. */
export const LOCATE_TIMEOUT_MS = 8000;
export const LOCATE_INTERVAL_MS = 150;

const escapeId = (id: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(id)
    : id.replace(/[^a-zA-Z0-9_.-]/g, c => `\\${c.charCodeAt(0).toString(16)} `);

export function findSettingElement(root: ParentNode, id: string): HTMLElement | null {
  try {
    const esc = escapeId(id);
    // `data-field-id` marks a section field the visual editor generates from the settings schema
    // (it has no registry anchor of its own), so `?field=typography` finds it too.
    return root.querySelector<HTMLElement>(`[data-setting-id="${esc}"], [data-field-id="${esc}"]`);
  } catch {
    // an id that still is not a valid selector can never match a control
    return null;
  }
}

/** Open every closed <details> around the control, so a setting inside one is visible. */
export function revealAncestors(el: HTMLElement): void {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n instanceof HTMLDetailsElement && !n.open) n.open = true;
  }
}

/** Scroll to the control, ring it for HIGHLIGHT_MS and move focus there for keyboard/screen-reader users. */
export function highlightElement(el: HTMLElement, win: Window = window): () => void {
  revealAncestors(el);
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  el.classList.remove(HIGHLIGHT_CLASS);
  // restart the animation if the same control is highlighted twice in a row
  void el.offsetWidth;
  el.classList.add(HIGHLIGHT_CLASS);
  if (!el.matches('a,button,input,select,textarea,[tabindex]')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  const timer = win.setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
  return () => {
    win.clearTimeout(timer);
    el.classList.remove(HIGHLIGHT_CLASS);
  };
}

/**
 * Look for the control until it renders (or the timeout passes), highlight it once. Returns a
 * cleanup. `onResult` reports whether it was found, for tests.
 */
export function locateAndHighlight(
  id: string,
  root: ParentNode = document,
  win: Window = window,
  onResult?: (found: boolean) => void
): () => void {
  let stop: (() => void) | undefined;
  let waited = 0;
  const attempt = (): boolean => {
    const el = findSettingElement(root, id);
    if (!el) return false;
    stop = highlightElement(el, win);
    onResult?.(true);
    return true;
  };
  if (attempt()) return () => stop?.();
  const poll = win.setInterval(() => {
    waited += LOCATE_INTERVAL_MS;
    if (attempt()) win.clearInterval(poll);
    else if (waited >= LOCATE_TIMEOUT_MS) {
      win.clearInterval(poll);
      onResult?.(false);
    }
  }, LOCATE_INTERVAL_MS);
  return () => {
    win.clearInterval(poll);
    stop?.();
  };
}
