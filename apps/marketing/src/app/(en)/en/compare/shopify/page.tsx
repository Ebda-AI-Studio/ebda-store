import type { Metadata } from 'next';
import { ComparePage } from '@/components/ComparePage';
import { COMPARE } from '@/lib/compare';
import { pageMetadata } from '@/lib/seo';

const d = COMPARE['shopify']['en'];

export const metadata: Metadata = pageMetadata('en', 'compare/shopify', d.title, d.desc);

export default function Page() {
  return <ComparePage locale="en" slug="shopify" />;
}
