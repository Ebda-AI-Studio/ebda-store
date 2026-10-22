import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import SearchClient from './SearchClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Search', 'البحث'],
    description: ['Search for products in our store.', 'ابحث عن المنتجات في متجرنا.'],
    // Search results are never indexed (Ruling SEARCH-URL-1): there is one `/search` address now
    // and its content is whatever a visitor typed.
    robots: { index: false, follow: false },
  });
}

export default function SearchPage() {
  return <SearchClient />;
}
