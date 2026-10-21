import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import VerifyEmailClient from './VerifyEmailClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Verify Email', 'تأكيد البريد'],
    description: ['Verify your email address.', 'أكّد عنوان بريدك الإلكتروني.'],
    robots: { index: false, follow: false },
  });
}

export default function VerifyEmailPage() {
  return <VerifyEmailClient />;
}
