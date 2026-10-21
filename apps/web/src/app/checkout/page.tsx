import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { Suspense } from 'react';
import CheckoutClient from './CheckoutClient';
import WaTokenHydrator from './WaTokenHydrator';

// Track-B — see cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Checkout', 'إتمام الطلب'],
    description: ['Complete your purchase.', 'أكمل طلبك.'],
    robots: { index: false, follow: false },
  });
}

export default function CheckoutPage() {
  return (
    <>
      {/* Phase 6 (Option C): when a customer arrives via the WhatsApp
          ordering flow, the URL carries ?waToken=<jwt>. WaTokenHydrator
          redeems the token, hydrates the cart, strips the token from
          the URL, then renders null. Wrapped in Suspense because
          useSearchParams suspends. */}
      <Suspense fallback={null}>
        <WaTokenHydrator />
      </Suspense>
      <CheckoutClient />
    </>
  );
}
