import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import ErrorClient from './ErrorClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Payment Error', 'الدفع متمش'],
    description: ['There was an issue processing your payment.', 'حدثت مشكلة أثناء معالجة الدفع.'],
    robots: { index: false, follow: false },
  });
}

export default function CheckoutErrorPage() {
  return <ErrorClient />;
}
