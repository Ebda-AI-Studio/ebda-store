import { headers } from 'next/headers';
import { PlatformNotFound } from '../components/PlatformNotFound';
import { StoreNotFound } from '../components/StoreNotFound';
import { getStore } from '../lib/store-resolver';

/**
 * 404 served by Next when a server-component calls `notFound()` or an unknown
 * route is hit.
 *
 * HARD multi-tenant rule: a store (a custom domain, or a real platform
 * `/<slug>` path) must NEVER show the Ebda platform landing or redirect to
 * `ebda.app` — it shows its OWN branded "page not available" so a
 * merchant's customer is never dumped onto the platform pitch / competitor
 * links. Only the bare platform host (`ebda.app` root, or an unknown
 * slug that no merchant owns) gets the platform 404, which links out to
 * ebda.app. The platform landing itself no longer lives on this host.
 */
export default async function NotFound() {
  const h = await headers();
  const storeDomain = h.get('x-store-domain');
  const storeSlug = h.get('x-store-slug');
  const store = await getStore();

  // Store context = a custom domain (always a real store), OR a platform
  // `/<slug>` path whose slug actually resolves to that store. Unknown slugs
  // on the platform host (e.g. `/haha`) fall through to the platform 404.
  const isStoreContext = !!storeDomain || (!!storeSlug && store.slug === storeSlug);

  if (isStoreContext) {
    return <StoreNotFound store={store} />;
  }

  return <PlatformNotFound />;
}
