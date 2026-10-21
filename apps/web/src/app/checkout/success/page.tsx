import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import SuccessClient from './SuccessClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Order confirmed', 'طلبك اتأكد'],
    description: ['Your order has been placed successfully.', 'طلبك وصلنا.'],
    robots: { index: false, follow: false },
  });
}

export default function CheckoutSuccessPage() {
  return <SuccessClient />;
}
