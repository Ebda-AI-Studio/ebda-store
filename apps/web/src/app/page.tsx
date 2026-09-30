import type { Metadata } from 'next';
import { getStore, getStoreOrNotFound, isResolvedStore } from '../lib/store-resolver';
import { storeAbsoluteUrl } from '../lib/structured-data';
import { HomePageBody } from './HomePageBody';

// The ROOT layout's `generateMetadata` (see `storefront-metadata.ts`) is the
// fallback for every route and deliberately does NOT set `alternates` —
// setting it there once leaked the home canonical onto every other page
// that doesn't set its own (A3 in the 2026-09-22 AEO audit; see that file's
// doc comment for the live-verified regression). This is the one place
// that canonical belongs: the actual home route.
export async function generateMetadata(): Promise<Metadata> {
  const store = await getStore();
  // No canonical for an unresolved store (#1855) — it would name the demo store.
  if (!isResolvedStore(store)) return {};
  return { alternates: { canonical: storeAbsoluteUrl(store, '') } };
}

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const draftToken =
    typeof params._layoutDraft === 'string' && params._layoutDraft.length > 0
      ? params._layoutDraft
      : undefined;
  const store = await getStoreOrNotFound();

  return <HomePageBody store={store} draftToken={draftToken} />;
}
