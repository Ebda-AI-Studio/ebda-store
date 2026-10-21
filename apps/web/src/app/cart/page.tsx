import type { Metadata } from 'next';
import { Suspense } from 'react';
import CartClient from './CartClient';
import CartRestoreHydrator from './CartRestoreHydrator';

// Track-B (personalized, session-bound) — stays outside the new `tenant-store`
// tree by design. Already dynamic today via the root layout's headers()/
// cookies() calls; this makes it explicit and immune to accidentally
// becoming static later. Verified no-op — see
// docs/plans/2026-07-12-tenant-cacheable-routing.md §3.3/§4/§9.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Cart',
  description: 'Review items in your shopping cart.',
  robots: { index: false, follow: false },
};

export default function CartPage() {
  return (
    <>
      {/* The cart-recovery email lands on /cart?restore=<token>; the hydrator re-attaches that
          cart to this browser, then renders null. Suspense because useSearchParams suspends. */}
      <Suspense fallback={null}>
        <CartRestoreHydrator />
      </Suspense>
      <CartClient />
    </>
  );
}
