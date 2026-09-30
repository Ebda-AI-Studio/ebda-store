'use client';

import { ShopChrome, RouteErrorFallback } from '../../../components';
import { useBareErrorFallback } from '../../../components/RouteErrorFallback';

export default function ProductDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // See products/error.tsx — the error object carries the digest that selects
  // the retry body, so this boundary must not discard it.
  const fallback = <RouteErrorFallback error={error} reset={reset} />;
  // Unresolved store during a transient: no chrome, whose links would lead
  // off the store (#1843 — see useBareErrorFallback).
  const bare = useBareErrorFallback(error);
  return bare ? fallback : <ShopChrome>{fallback}</ShopChrome>;
}
