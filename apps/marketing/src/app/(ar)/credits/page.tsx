import type { Metadata } from 'next';
import { CreditsPage } from '@/components/CreditsPage';
import { COPY } from '@/lib/content';
import { pageMetadata } from '@/lib/seo';

const p = COPY['ar'].creditsPage;

export const metadata: Metadata = pageMetadata('ar', 'credits', p.title, p.desc);

export default function Page() {
  return <CreditsPage locale="ar" />;
}
