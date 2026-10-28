import type { Metadata } from 'next';
import { VerticalPage } from '@/components/VerticalPage';
import { pageMetadata } from '@/lib/seo';
import { VERTICALS } from '@/lib/verticals';

const d = VERTICALS['jewellery']['en'];

export const metadata: Metadata = pageMetadata('en', 'for/jewellery', d.title, d.desc);

export default function Page() {
  return <VerticalPage locale="en" slug="jewellery" />;
}
