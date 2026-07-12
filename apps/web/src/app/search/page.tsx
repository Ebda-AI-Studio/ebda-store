import type { Metadata } from 'next';
import SearchClient from './SearchClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search for products in our store.',
};

export default function SearchPage() {
  return <SearchClient />;
}
