import type { Metadata } from 'next';
import { AboutPage } from '@/components/AboutPage';
import { COPY } from '@/lib/content';
import { pageMetadata } from '@/lib/seo';

const p = COPY['ar'].aboutPage;

export const metadata: Metadata = pageMetadata('ar', 'about', p.title, p.desc);

export default function Page() {
  return <AboutPage locale="ar" />;
}
