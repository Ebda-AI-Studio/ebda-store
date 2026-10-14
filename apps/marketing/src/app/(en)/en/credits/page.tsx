import type { Metadata } from 'next';
import { CreditsPage } from '@/components/CreditsPage';
import { COPY } from '@/lib/content';
import { pageMetadata } from '@/lib/seo';

const p = COPY['en'].creditsPage;

export const metadata: Metadata = pageMetadata('en', 'credits', p.title, p.desc);

export default function Page() {
  return <CreditsPage locale="en" />;
}
