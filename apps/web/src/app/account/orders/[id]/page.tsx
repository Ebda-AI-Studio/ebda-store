import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import OrderDetailClient from './OrderDetailClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Order Details', 'تفاصيل الطلب'],
    robots: { index: false, follow: false },
  });
}

export default function OrderDetailPage() {
  return <OrderDetailClient />;
}
