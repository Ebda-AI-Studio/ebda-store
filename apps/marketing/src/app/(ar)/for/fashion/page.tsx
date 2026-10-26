import type { Metadata } from 'next';
import { VerticalPage } from '@/components/VerticalPage';
import { pageMetadata } from '@/lib/seo';
import { VERTICALS } from '@/lib/verticals';

const d = VERTICALS['fashion']['ar'];

export const metadata: Metadata = pageMetadata('ar', 'for/fashion', d.title, d.desc);

export default function Page() {
  return <VerticalPage locale="ar" slug="fashion" />;
}
