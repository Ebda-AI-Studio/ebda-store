import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import OrdersClient from './OrdersClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['My Orders', 'طلباتي'],
    robots: { index: false, follow: false },
  });
}

export default function OrdersPage() {
  return <OrdersClient />;
}
