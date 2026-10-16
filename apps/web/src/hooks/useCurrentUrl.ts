'use client';

import { useSyncExternalStore } from 'react';

/**
 * Re-read on back/forward (`popstate`) and fragment changes. `history.pushState` /
 * `replaceState` fire no event and are deliberately NOT wrapped: patching the global
 * History API from a hook would collide with Next's router. It does not matter here:
 * React calls `getSnapshot` on every render, so a Next navigation (which re-renders the
 * page) picks up the new URL, and no storefront surface pushes state without rendering.
 */
function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener('hashchange', onChange);
  };
}

/**
 * The current page URL, hydration-safe: '' on the server AND on the client's hydrating
 * render (React uses the server snapshot there), the real URL right after. Reading
 * `window.location.href` at render instead is a hydration mismatch (B0-46).
 */
export function useCurrentUrl(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.href,
    () => ''
  );
}
