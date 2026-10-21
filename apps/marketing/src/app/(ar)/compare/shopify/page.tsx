import type { Metadata } from 'next';
import { ComparePage } from '@/components/ComparePage';
import { COMPARE } from '@/lib/compare';
import { pageMetadata } from '@/lib/seo';

const d = COMPARE['shopify']['ar'];

export const metadata: Metadata = pageMetadata('ar', 'compare/shopify', d.title, d.desc);

export default function Page() {
  return <ComparePage locale="ar" slug="shopify" />;
}
