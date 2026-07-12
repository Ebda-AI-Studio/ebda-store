import { Metadata } from 'next';
import AddressesClient from './AddressesClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'My Addresses',
  robots: { index: false, follow: false },
};

export default function AddressesPage() {
  return <AddressesClient />;
}
