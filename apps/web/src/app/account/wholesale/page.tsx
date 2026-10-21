import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import WholesaleClient from './WholesaleClient';

// Buyer-specific and signed-in only: never prerendered / cached (same rationale as the wallet page).
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Wholesale account', 'حساب الجملة'],
    robots: { index: false, follow: false },
  });
}

export default function WholesalePage() {
  return <WholesaleClient />;
}
