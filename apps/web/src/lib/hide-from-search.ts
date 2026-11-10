/**
 * "Hide my store from search engines" (merchant switch, platform-level).
 *
 * The flag is `store.settings.hideFromSearchEngines`, delivered to the storefront through the public store payload
 * (PUBLIC_SETTINGS_KEYS in the API). Every surface that tells a crawler anything (page robots meta, robots.txt,
 * sitemap.xml, llms.txt) asks THIS one predicate, on the platform host and on a custom domain alike.
 *
 * Cache class: NEVER-stale. The write (`PUT /stores/:id/seo`) runs `bustStoreCaches`, which purges the `store-domain:<host>`
 * / `store-slug:<slug>` tags; every storefront fetch that feeds this predicate MUST carry those tags (see {@link hideTags}).
 */
export function hidesFromSearch(
  store: { settings?: Record<string, unknown> | null } | null | undefined
): boolean {
  return store?.settings?.hideFromSearchEngines === true;
}

/** The Next data-cache tags the API purges for a host (revalidateStorefront): a fetch carrying them is purged on the toggle. */
export function hideTags(host: string): string[] {
  return host ? [`store-domain:${host}`] : [];
}
