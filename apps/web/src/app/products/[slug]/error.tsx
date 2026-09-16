'use client';

import { ShopChrome, RouteErrorFallback } from '../../../components';

export default function ProductDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // See products/error.tsx — the error object carries the digest that selects
  // the retry body, so this boundary must not discard it.
  return (
    <ShopChrome>
      <RouteErrorFallback error={error} reset={reset} />
    </ShopChrome>
  );
}
