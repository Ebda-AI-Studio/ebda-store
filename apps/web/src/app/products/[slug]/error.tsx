'use client';

import { ShopChrome, RouteErrorFallback } from '../../../components';

export default function ProductDetailError({
  error: _error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ShopChrome>
      <RouteErrorFallback reset={reset} />
    </ShopChrome>
  );
}
