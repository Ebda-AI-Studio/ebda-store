/**
 * STORE-QA-64: the key a base row's variant rows use as their `parentSku`. A product WITHOUT a sku cannot be linked by sku, so the
 * export writes `slug:<slug>` for its variant rows and the importer resolves that against the base row / the store's slug.
 */
export const PARENT_SLUG_PREFIX = 'slug:';
export const parentKeyFor = (sku: string | null | undefined, slug: string): string =>
  sku && String(sku).trim() ? String(sku).trim() : `${PARENT_SLUG_PREFIX}${slug}`;
