import { Metadata } from 'next';
import OrdersClient from './OrdersClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'My Orders',
  robots: { index: false, follow: false },
};

export default function OrdersPage() {
  return <OrdersClient />;
}
