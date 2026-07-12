import type { Metadata } from 'next';
import CartClient from './CartClient';

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
  return <CartClient />;
}
