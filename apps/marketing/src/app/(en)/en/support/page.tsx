import type { Metadata } from 'next';
import { SupportPage } from '@/components/SupportPage';
import { SUPPORT_PAGE } from '@/lib/support-page';
import { pageMetadata } from '@/lib/seo';

const p = SUPPORT_PAGE['en'];

export const metadata: Metadata = pageMetadata('en', 'support', p.title, p.desc);

export default function Page() {
  return <SupportPage locale="en" />;
}
