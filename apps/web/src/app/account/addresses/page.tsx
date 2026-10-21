import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import AddressesClient from './AddressesClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['My Addresses', 'عناويني'],
    robots: { index: false, follow: false },
  });
}

export default function AddressesPage() {
  return <AddressesClient />;
}
