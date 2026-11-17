import type { ResolvedStore } from '../../lib/store-resolver';
import { API_URL } from '../../lib/api';
import { publicLayoutUrl } from '../../lib/preview-draft';
import { resolveLayoutSettings, type LocationsPageSettings } from '@ebda/shared';
import LocationsClient from './LocationsClient';

/**
 * Locations page body — extracted 2026-07-12 (tenant-cacheable routing,
 * Phase 1) so the SAME rendering logic serves both
 * `app/locations/page.tsx` (legacy, header-based) and
 * `app/tenant-store/[tenant]/[locale]/locations/page.tsx` (new, params-based,
 * dark-launched). See docs/plans/done/2026-07-12-tenant-cacheable-routing.md
 * §3.6/§9.
 */

/**
 * Fetch the locationsPage layout settings for SSR so bgColor / colorScheme /
 * density / textScale paint on the first server render without a layout-flash.
 * Mirrors the identical pattern on the categories and products pages.
 */
async function fetchLocationsPageSettings(
  store: { id: string },
  draftToken?: string
): Promise<LocationsPageSettings | undefined> {
  if (!store.id || store.id === 'demo') return undefined;
  try {
    const res = await fetch(
      publicLayoutUrl(API_URL, store.id, draftToken),
      draftToken
        ? { cache: 'no-store' }
        : { next: { revalidate: 60, tags: [`layout:${store.id}`] } }
    );
    if (!res.ok) return undefined;
    const json = await res.json();
    const layout = resolveLayoutSettings(json?.data?.layout ?? {});
    return layout.locationsPage ? { ...layout.locationsPage } : undefined;
  } catch {
    return undefined;
  }
}

export async function LocationsPageBody({
  store,
  draftToken,
}: {
  store: ResolvedStore;
  /** Always `undefined` from the new `tenant-store` tree — see HomePageBody's
   *  doc comment for why Track-A never carries a draft token. */
  draftToken?: string;
}) {
  const locationsPage = await fetchLocationsPageSettings(store, draftToken);

  return <LocationsClient locationsPage={locationsPage} />;
}
