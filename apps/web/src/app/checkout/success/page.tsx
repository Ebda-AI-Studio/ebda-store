import { Metadata } from 'next';
import SuccessClient from './SuccessClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Order Confirmed',
  description: 'Your order has been placed successfully.',
  robots: { index: false, follow: false },
};

export default function CheckoutSuccessPage() {
  return <SuccessClient />;
}
