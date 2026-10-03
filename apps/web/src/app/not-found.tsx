import { headers } from 'next/headers';
import { PlatformNotFound } from '../components/PlatformNotFound';
import { StoreNotFound } from '../components/StoreNotFound';
import { getStore } from '../lib/store-resolver';

/**
 * 404 served by Next when a server-component calls `notFound()` or an unknown
 * route is hit.
 *
 * HARD multi-tenant rule: a store (its `<slug>.ebda.app` host or a custom
 * domain) must NEVER show the Ebda platform landing or redirect to
 * `ebda.app` — it shows its OWN branded "page not available" so a
 * merchant's customer is never dumped onto the platform pitch / competitor
 * links. Only a host that resolves to NO store (a platform host, or an unknown
 * `<slug>.ebda.app` / custom domain) gets the platform 404, which links out to
 * ebda.app.
 */
export default async function NotFound() {
  const h = await headers();
  const storeDomain = h.get('x-store-domain');
  const store = await getStore();

  // Store context = the Host named a store AND that store actually resolved
  // (the sentinel `demo` chrome means it did not).
  const isStoreContext = !!storeDomain && store.id !== 'demo';

  if (isStoreContext) {
    return <StoreNotFound store={store} />;
  }

  return <PlatformNotFound />;
}
