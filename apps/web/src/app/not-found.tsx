import { headers } from 'next/headers';
import { PlatformLanding } from '../components/PlatformLanding';
import { StoreNotFound } from '../components/StoreNotFound';
import { getStore } from '../lib/store-resolver';

/**
 * 404 served by Next when a server-component calls `notFound()` or an unknown
 * route is hit.
 *
 * HARD multi-tenant rule: a store (a custom domain, or a real platform
 * `/<slug>` path) must NEVER show the Force AI platform landing or redirect to
 * `store.force-ai.co` — it shows its OWN branded "page not available" so a
 * merchant's customer is never dumped onto the platform pitch / competitor
 * links. Only the bare platform host (`store.force-ai.co` root, or an unknown
 * slug that no merchant owns) shows the platform landing.
 */
export default async function NotFound() {
  const h = await headers();
  const storeDomain = h.get('x-store-domain');
  const storeSlug = h.get('x-store-slug');
  const store = await getStore();

  // Store context = a custom domain (always a real store), OR a platform
  // `/<slug>` path whose slug actually resolves to that store. Unknown slugs
  // on the platform host (e.g. `/haha`) fall through to the platform landing.
  const isStoreContext = !!storeDomain || (!!storeSlug && store.slug === storeSlug);

  if (isStoreContext) {
    return <StoreNotFound store={store} />;
  }

  return <PlatformLanding notFoundBanner />;
}
