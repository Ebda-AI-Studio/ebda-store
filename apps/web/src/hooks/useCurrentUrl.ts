'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

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
