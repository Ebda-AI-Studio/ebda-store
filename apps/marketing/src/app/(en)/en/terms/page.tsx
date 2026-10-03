import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';
import { COPY } from '@/lib/content';
import { pageMetadata } from '@/lib/seo';

const doc = COPY['en'].legalPages.terms;

export const metadata: Metadata = pageMetadata(
  'en',
  'terms',
  `${doc.title} (${COPY['en'].legalPages.draftBadge})`,
  COPY['en'].legalPages.draftBody
);

export default function Page() {
  return <LegalPage locale="en" page="terms" />;
}
