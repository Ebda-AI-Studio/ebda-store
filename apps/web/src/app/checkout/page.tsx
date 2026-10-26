import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import CheckoutClient from './CheckoutClient';

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
  return <CheckoutClient />;
}
