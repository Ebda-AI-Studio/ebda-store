'use client';

import { MinimalChrome, RouteErrorFallback } from '../../components';
import { useBareErrorFallback } from '../../components/RouteErrorFallback';

// Checkout renders inside MinimalChrome (no nav/footer distraction), not
// the full ShopChrome — matches CheckoutClient.tsx's own chrome choice so
// an error here doesn't suddenly show a header/footer the shopper never
// saw during checkout.
export default function CheckoutError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Forwarded for the same reason as the PLP/PDP boundaries — see cart/error.tsx
  // for why this route cannot show the retry body today.
  const fallback = <RouteErrorFallback error={error} reset={reset} />;
  // Unresolved store during a transient: no chrome, whose links would lead
  // off the store (#1843 — see useBareErrorFallback).
  const bare = useBareErrorFallback(error);
  return bare ? fallback : <MinimalChrome>{fallback}</MinimalChrome>;
}
