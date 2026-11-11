import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';
import { COPY } from '@/lib/content';
import { pageMetadata, snippet } from '@/lib/seo';

const doc = COPY['en'].legalPages.refund;

export const metadata: Metadata = pageMetadata(
  'en',
  'refund',
  doc.title,
  snippet(doc.sections[0].p[0])
);

export default function Page() {
  return <LegalPage locale="en" page="refund" />;
}
