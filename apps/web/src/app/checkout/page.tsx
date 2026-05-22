import { Metadata } from 'next';
import { Suspense } from 'react';
import CheckoutClient from './CheckoutClient';
import WaTokenHydrator from './WaTokenHydrator';

export const metadata: Metadata = {
  title: 'Checkout',
  description: 'Complete your purchase.',
  robots: { index: false, follow: false },
};

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
