import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import CheckEmailClient from './CheckEmailClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Check Your Email', 'تحقق من بريدك'],
    description: ['Verification link sent.', 'أرسلنا رابط التحقق.'],
    robots: { index: false, follow: false },
  });
}

export default function CheckEmailPage() {
  return <CheckEmailClient />;
}
