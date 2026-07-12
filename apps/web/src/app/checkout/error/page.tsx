import { Metadata } from 'next';
import ErrorClient from './ErrorClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Payment Error',
  description: 'There was an issue processing your payment.',
  robots: { index: false, follow: false },
};

export default function CheckoutErrorPage() {
  return <ErrorClient />;
}
