import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import SearchClient from './SearchClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Search', 'البحث'],
    description: ['Search for products in our store.', 'ابحث عن المنتجات في متجرنا.'],
  });
}

export default function SearchPage() {
  return <SearchClient />;
}
