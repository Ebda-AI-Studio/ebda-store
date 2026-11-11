import type { Metadata } from 'next';
import { SupportPage } from '@/components/SupportPage';
import { SUPPORT_PAGE } from '@/lib/support-page';
import { pageMetadata } from '@/lib/seo';

const p = SUPPORT_PAGE['ar'];

export const metadata: Metadata = pageMetadata('ar', 'support', p.title, p.desc);

export default function Page() {
  return <SupportPage locale="ar" />;
}
