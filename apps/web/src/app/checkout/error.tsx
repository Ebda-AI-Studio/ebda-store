'use client';

import { MinimalChrome, RouteErrorFallback } from '../../components';

// Checkout renders inside MinimalChrome (no nav/footer distraction), not
// the full ShopChrome — matches CheckoutClient.tsx's own chrome choice so
// an error here doesn't suddenly show a header/footer the shopper never
// saw during checkout.
export default function CheckoutError({
  error: _error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <MinimalChrome>
      <RouteErrorFallback reset={reset} />
    </MinimalChrome>
  );
}
