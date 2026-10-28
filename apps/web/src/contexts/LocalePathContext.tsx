'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { PathLocale } from '../lib/locale-paths';

/**
 * The language prefix of the current page (`/ar|/en`) on a store that has language-in-the-URL ON, or null on an
 * ordinary page (LOCALE-PATHS-1). Set once by the root layout from the middleware's `x-locale-path` header, so
 * server and client render the same hrefs (no hydration mismatch). `StoreLink` reads it.
 */
const LocalePathContext = createContext<PathLocale | null>(null);

export function LocalePathProvider({
  locale,
  children,
}: {
  locale: PathLocale | null;
  children: ReactNode;
}) {
  return <LocalePathContext.Provider value={locale}>{children}</LocalePathContext.Provider>;
}

/** The page's language prefix, or null. */
export function useLocalePath(): PathLocale | null {
  return useContext(LocalePathContext);
}
