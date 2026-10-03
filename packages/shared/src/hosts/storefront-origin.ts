import { brandUrl, storeOrigin } from '../brand';

/**
 * The public origin of a store's storefront: its custom domain when it has
 * one, otherwise its free `<slug>.ebda.app` address. NEVER a path under the
 * apex (`ebda.app/<slug>` is not a store URL). Use this — not string
 * concatenation with a web base URL — wherever an absolute storefront link is
 * built (emails, payment redirects, feeds, sitemaps).
 */
export function storefrontOrigin(store: { slug: string; domain?: string | null }): string {
  const domain = store.domain?.trim().toLowerCase();
  return domain ? brandUrl(domain) : storeOrigin(store.slug);
}
