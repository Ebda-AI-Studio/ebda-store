import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { getPreviewDraftToken } from '../../lib/preview-draft';
import { LocationsPageBody } from './LocationsPageBody';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Locations', 'الفروع'],
    description: [
      'Find our store branches — addresses, hours, and directions.',
      'فروعنا: العناوين ومواعيد العمل والاتجاهات.',
    ],
  });
}

export default async function LocationsPage() {
  const store = await getStoreOrNotFound();
  const draftToken = await getPreviewDraftToken();

  return <LocationsPageBody store={store} draftToken={draftToken} />;
}
