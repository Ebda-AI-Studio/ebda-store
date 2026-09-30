'use client';

import { ShopChrome, RouteErrorFallback } from '../../components';
import { useBareErrorFallback } from '../../components/RouteErrorFallback';

export default function ProductsListError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // `error` MUST be forwarded: this boundary catches before `app/error.tsx`,
  // and RouteErrorFallback selects the "we're busy, try again" body from
  // `error.digest`. Dropping it renders the generic "something went wrong"
  // copy for a store that is merely rate limited.
  const fallback = <RouteErrorFallback error={error} reset={reset} />;
  // Unresolved store during a transient: no chrome, whose links would lead
  // off the store (#1843 — see useBareErrorFallback).
  const bare = useBareErrorFallback(error);
  return bare ? fallback : <ShopChrome>{fallback}</ShopChrome>;
}
