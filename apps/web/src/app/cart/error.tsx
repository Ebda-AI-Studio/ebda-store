'use client';

import { ShopChrome, RouteErrorFallback } from '../../components';
import { useBareErrorFallback } from '../../components/RouteErrorFallback';

export default function CartError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Forwarded for the same reason as the PLP/PDP boundaries. This page does
  // not call getStoreOrNotFound() today, so the retry body is unreachable
  // here — wiring it now means the next page that does is already covered.
  const fallback = <RouteErrorFallback error={error} reset={reset} />;
  // Unresolved store during a transient: no chrome, whose links would lead
  // off the store (#1843 — see useBareErrorFallback).
  const bare = useBareErrorFallback(error);
  return bare ? fallback : <ShopChrome>{fallback}</ShopChrome>;
}
