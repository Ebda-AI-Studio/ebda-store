'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * One "now" for a whole render, read once on the server and handed to the
 * client as a prop, so the server HTML and the hydrating client agree on every
 * time-based decision (the card "New" badge: `isProductNew(product, now)`).
 * Reading `Date.now()` during render made a card that crossed the 14-day
 * boundary between the cached render and hydration mismatch (W1c review M9).
 */
const RenderClock = createContext<number | null>(null);

export function RenderClockProvider({ now, children }: { now: number; children: ReactNode }) {
  return <RenderClock.Provider value={now}>{children}</RenderClock.Provider>;
}

/** Outside a provider (isolated component tests) the module's load time stands in. */
const FALLBACK_NOW = Date.now();

export function useRenderNow(): number {
  return useContext(RenderClock) ?? FALLBACK_NOW;
}
