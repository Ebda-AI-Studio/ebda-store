'use client';

import { ShopChrome, RouteErrorFallback } from '../../components';

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
  return (
    <ShopChrome>
      <RouteErrorFallback error={error} reset={reset} />
    </ShopChrome>
  );
}
