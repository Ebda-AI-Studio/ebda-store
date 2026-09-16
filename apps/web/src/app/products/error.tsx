'use client';

import { ShopChrome, RouteErrorFallback } from '../../components';

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
  return (
    <ShopChrome>
      <RouteErrorFallback error={error} reset={reset} />
    </ShopChrome>
  );
}
