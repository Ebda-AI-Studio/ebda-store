/**
 * The canvas is INERT: while the storefront runs inside the builder (the overlay is mounted), no
 * storefront action may run. ONE layer, installed once by `EditorOverlay`, so a component added
 * tomorrow is inert without knowing about the editor:
 *
 *  - DOM events: `click` / `auxclick` / `submit` / `change` are stopped in the capture phase on
 *    `document`, before React's root listener, so no `onClick` / `onSubmit` / `onChange` of the
 *    storefront (add to cart, quick add, wishlist, compare, cart drawer, newsletter, search, coupon,
 *    checkout, router.push on a card or a sort select) ever runs; the default action (link
 *    navigation, form submit, checkbox toggle) is prevented. The overlay's own controls
 *    (`OWN`) and text being edited are exempt, and a native `<details>` still toggles.
 *  - The network: `fetch` with any method but GET / HEAD / OPTIONS, and `sendBeacon`, are refused
 *    in the one place every storefront call goes through, whatever started them (an effect, a
 *    timer, a handler that slipped through). The caller gets a normal "not available" error.
 *  - `window.open` does nothing.
 *
 * This layer is installed BEFORE the overlay's own `click` handler (same node, so that handler still runs) and sees the DOM as the tap found it, so a tap
 * still selects and edits. Selection UI of the storefront (variant swatches, tabs) is inert too:
 * its `onClick` cannot be told apart from "add to cart" without per-component knowledge.
 */

/** Controls the overlay itself renders into the page: they must keep working. */
export const EDITOR_OWN =
  '[data-builder-toolbar-root], [data-builder-insert], [data-builder-change-image], [data-builder-drag-ghost]';

const EDITABLE = '[contenteditable]:not([contenteditable="false"])';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const EDITOR_REFUSED = {
  success: false,
  error: { code: 'EDITOR_MODE', message: 'Not available in the editor preview.' },
};

function exempt(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  return !el || !!el.closest(EDITOR_OWN) || !!el.closest(EDITABLE);
}

export function installEditorInert(): () => void {
  const undo: Array<() => void> = [];

  const onClick = (e: Event) => {
    if (exempt(e.target)) return;
    e.stopPropagation();
    // `summary` keeps its native open/close; everything else loses its default (links, submit, toggles).
    if (!(e.target as Element).closest('summary')) e.preventDefault();
  };
  const onSubmit = (e: Event) => {
    if (exempt(e.target)) return;
    e.stopPropagation();
    e.preventDefault();
  };
  const onChange = (e: Event) => {
    if (exempt(e.target)) return;
    e.stopPropagation();
  };
  for (const [type, fn] of [
    ['click', onClick],
    ['auxclick', onClick],
    ['submit', onSubmit],
    ['change', onChange],
  ] as const) {
    document.addEventListener(type, fn, true);
    undo.push(() => document.removeEventListener(type, fn, true));
  }

  const realFetch = window.fetch;
  if (typeof realFetch === 'function') {
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const method = (
        init?.method ??
        (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      if (SAFE_METHODS.has(method)) return realFetch.call(window, input, init);
      return Promise.resolve(
        new Response(JSON.stringify(EDITOR_REFUSED), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })
      );
    } as typeof window.fetch;
    undo.push(() => {
      window.fetch = realFetch;
    });
  }

  const realBeacon = navigator.sendBeacon;
  if (typeof realBeacon === 'function') {
    navigator.sendBeacon = () => true; // analytics and the like: accepted, sent nowhere
    undo.push(() => {
      navigator.sendBeacon = realBeacon;
    });
  }

  const realOpen = window.open;
  window.open = () => null;
  undo.push(() => {
    window.open = realOpen;
  });

  return () => undo.forEach(fn => fn());
}
