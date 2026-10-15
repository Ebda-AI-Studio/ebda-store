import { headers } from 'next/headers';
import { UnknownHostNotFound } from '../components/UnknownHostNotFound';
import { StoreNotFound } from '../components/StoreNotFound';
import { getStore } from '../lib/store-resolver';
import { notFoundKind, unknownHostLinks } from '../lib/unknown-store-page';

/**
 * 404 served by Next when a server-component calls `notFound()` or an unknown
 * route is hit.
 *
 * HARD multi-tenant rule: a store (its `<slug>.ebda.app` host or a custom
 * domain) must NEVER show the Ebda platform landing or redirect to
 * `ebda.app` — it shows its OWN branded "page not available" so a
 * merchant's customer is never dumped onto the platform pitch / competitor
 * links. Only a host that resolves to NO store (a platform host, or an unknown
 * or inactive `<slug>.ebda.app` / custom domain) gets the generic Ebda 404
 * (Ruling SUBDOMAIN-404-1), which links out to ebda.app.
 */
export default async function NotFound() {
  const h = await headers();
  const storeDomain = h.get('x-store-domain');
  const store = await getStore();

  if (notFoundKind(storeDomain, store) === 'store') {
    return <StoreNotFound store={store} />;
  }

  return <UnknownHostNotFound links={unknownHostLinks()} />;
}
