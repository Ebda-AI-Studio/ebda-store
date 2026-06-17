import type { Metadata } from 'next';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { API_URL } from '../../lib/api';
import { getPreviewDraftToken, publicLayoutUrl } from '../../lib/preview-draft';
import { resolveLayoutSettings, type LocationsPageSettings } from '@force/shared';
import LocationsClient from './LocationsClient';

export const metadata: Metadata = {
  title: 'Locations',
  description: 'Find our store branches — addresses, hours, and directions.',
};

/**
 * Fetch the locationsPage layout settings for SSR so bgColor / colorScheme /
 * density / textScale paint on the first server render without a layout-flash.
 * Mirrors the identical pattern on the categories and products pages.
 */
async function fetchLocationsPageSettings(store: {
  id: string;
}): Promise<LocationsPageSettings | undefined> {
  if (!store.id || store.id === 'demo') return undefined;
  try {
    const draftToken = await getPreviewDraftToken();
    const res = await fetch(
      publicLayoutUrl(API_URL, store.id, draftToken),
      draftToken ? { cache: 'no-store' } : { next: { revalidate: 60 } }
    );
    if (!res.ok) return undefined;
    const json = await res.json();
    const layout = resolveLayoutSettings(json?.data?.layout ?? {});
    return layout.locationsPage ? { ...layout.locationsPage } : undefined;
  } catch {
    return undefined;
  }
}

export default async function LocationsPage() {
  const store = await getStoreOrNotFound();
  const locationsPage = await fetchLocationsPageSettings(store);

  return <LocationsClient locationsPage={locationsPage} />;
}
