import { Metadata } from 'next';
import OrderDetailClient from './OrderDetailClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Order Details',
  robots: { index: false, follow: false },
};

export default function OrderDetailPage() {
  return <OrderDetailClient />;
}
