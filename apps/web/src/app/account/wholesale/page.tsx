import { Metadata } from 'next';
import WholesaleClient from './WholesaleClient';

// Buyer-specific and signed-in only: never prerendered / cached (same rationale as the wallet page).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Wholesale account',
  robots: { index: false, follow: false },
};

export default function WholesalePage() {
  return <WholesaleClient />;
}
