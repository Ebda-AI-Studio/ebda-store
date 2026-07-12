import type { Metadata } from 'next';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { getPreviewDraftToken } from '../../lib/preview-draft';
import { LocationsPageBody } from './LocationsPageBody';

export const metadata: Metadata = {
  title: 'Locations',
  description: 'Find our store branches — addresses, hours, and directions.',
};

export default async function LocationsPage() {
  const store = await getStoreOrNotFound();
  const draftToken = await getPreviewDraftToken();

  return <LocationsPageBody store={store} draftToken={draftToken} />;
}
