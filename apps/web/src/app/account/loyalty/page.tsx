import { Metadata } from 'next';
import LoyaltyClient from './LoyaltyClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Loyalty Program',
  robots: { index: false, follow: false },
};

export default function LoyaltyPage() {
  return <LoyaltyClient />;
}
