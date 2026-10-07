import type { Metadata } from 'next';
import { AboutPage } from '@/components/AboutPage';
import { COPY } from '@/lib/content';
import { pageMetadata } from '@/lib/seo';

const p = COPY['en'].aboutPage;

export const metadata: Metadata = pageMetadata('en', 'about', p.title, p.desc);

export default function Page() {
  return <AboutPage locale="en" />;
}
