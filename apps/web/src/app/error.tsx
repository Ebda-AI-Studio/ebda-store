'use client';

import { RouteErrorFallback } from '../components';

/**
 * Root error boundary.
 *
 * It renders the SAME body as every segment-level `error.tsx`
 * (`RouteErrorFallback`), rather than keeping a second copy of the same two
 * messages. The PLP, PDP and bundle PDP each have their own boundary that
 * catches BEFORE this one, so copy that lives only here never reaches the
 * three routes a shopper is most likely to land on — which is exactly how the
 * "we're a little busy" retry body went missing on the highest-traffic pages
 * in the first draft of docs/plans/done/2026-09-16-store-resolve-transient-not-404.md.
 *
 * `error` is forwarded, never discarded: RouteErrorFallback picks the retry
 * body off `error.digest`.
 *
 * This renders inside the root layout's provider tree (LanguageProvider /
 * StoreProvider are mounted around `{children}`), so the shared body's
 * `useLanguage()` / `useStoreUrl()` hooks resolve. An error in the LAYOUT
 * itself goes to `global-error.tsx`, which deliberately uses no hooks.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} />;
}
