import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';
import { COPY } from '@/lib/content';
import { pageMetadata } from '@/lib/seo';

const doc = COPY['ar'].legalPages.privacy;

export const metadata: Metadata = pageMetadata(
  'ar',
  'privacy',
  `${doc.title} (${COPY['ar'].legalPages.draftBadge})`,
  COPY['ar'].legalPages.draftBody
);

export default function Page() {
  return <LegalPage locale="ar" page="privacy" />;
}
