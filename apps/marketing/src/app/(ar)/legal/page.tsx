import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';
import { COPY } from '@/lib/content';
import { pageMetadata } from '@/lib/seo';

const doc = COPY['ar'].legalPages.legal;

export const metadata: Metadata = pageMetadata(
  'ar',
  'legal',
  doc.title,
  doc.sections[0].p[0].slice(0, 160)
);

export default function Page() {
  return <LegalPage locale="ar" page="legal" />;
}
