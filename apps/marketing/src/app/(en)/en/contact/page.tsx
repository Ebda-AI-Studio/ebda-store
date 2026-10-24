import type { Metadata } from 'next';
import { ContactPage } from '@/components/ContactPage';
import { COPY } from '@/lib/content';
import { pageMetadata } from '@/lib/seo';

const p = COPY['en'].contactPage;

export const metadata: Metadata = pageMetadata('en', 'contact', p.title, p.desc);

export default function Page() {
  return <ContactPage locale="en" />;
}
