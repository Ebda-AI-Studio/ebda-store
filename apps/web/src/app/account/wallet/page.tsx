import { Metadata } from 'next';
import WalletClient from './WalletClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Wallet',
  robots: { index: false, follow: false },
};

export default function WalletPage() {
  return <WalletClient />;
}
