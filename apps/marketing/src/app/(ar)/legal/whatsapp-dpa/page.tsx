import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';
import { COPY } from '@/lib/content';
import { pageMetadata, snippet } from '@/lib/seo';

const doc = COPY['ar'].legalPages.waDpa;

export const metadata: Metadata = pageMetadata(
  'ar',
  'legal/whatsapp-dpa',
  // P2-1: the page title names the product in Arabic; the vendored document keeps its source heading
  doc.title.replace('Ebda Chat', 'ابدأ شات'),
  snippet(doc.sections[0].p[0])
);

export default function Page() {
  return <LegalPage locale="ar" page="legal/whatsapp-dpa" />;
}
