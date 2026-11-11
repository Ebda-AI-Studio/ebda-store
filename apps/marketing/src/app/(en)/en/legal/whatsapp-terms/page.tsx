import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';
import { COPY } from '@/lib/content';
import { pageMetadata, snippet } from '@/lib/seo';

const doc = COPY['en'].legalPages.waTerms;

export const metadata: Metadata = pageMetadata(
  'en',
  'legal/whatsapp-terms',
  doc.title,
  snippet(doc.sections[0].p[0])
);

export default function Page() {
  return <LegalPage locale="en" page="legal/whatsapp-terms" />;
}
