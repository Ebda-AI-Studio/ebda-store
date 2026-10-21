import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import LoyaltyClient from './LoyaltyClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Loyalty Program', 'برنامج الولاء'],
    robots: { index: false, follow: false },
  });
}

export default function LoyaltyPage() {
  return <LoyaltyClient />;
}
