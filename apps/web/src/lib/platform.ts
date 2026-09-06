/**
 * The Force AI marketing site.
 *
 * The storefront platform host (`store.force-ai.co`) has no root content of its
 * own — its root and its unknown-slug 404 both point here rather than serving a
 * second marketing page that competes with this one in search.
 *
 * Merchant surfaces must never link here: a customer inside a merchant's store
 * who hits a dead URL sees that merchant's own "page not available", never the
 * platform pitch. That rule is enforced in `app/not-found.tsx`.
 */
export const PLATFORM_MARKETING_URL = 'https://force-ai.co';
