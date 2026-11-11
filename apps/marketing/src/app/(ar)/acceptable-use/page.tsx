import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';
import { COPY } from '@/lib/content';
import { pageMetadata, snippet } from '@/lib/seo';

const doc = COPY['ar'].legalPages.acceptableUse;

export const metadata: Metadata = pageMetadata(
  'ar',
  'acceptable-use',
  doc.title,
  snippet(doc.sections[0].p[0])
);

export default function Page() {
  return <LegalPage locale="ar" page="acceptable-use" />;
}
