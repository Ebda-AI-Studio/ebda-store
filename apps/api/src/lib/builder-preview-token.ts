/**
 * Redis key of a visual-builder canvas preview token. Dependency-free on purpose:
 * `public.routes.ts` (the store-resolve bypass) and `page-builder.service.ts` (the
 * minter) must agree on this key, and the former must not drag the whole
 * page-builder service graph in just to compute a string.
 */
export const previewTokenKey = (storeId: string, token: string) =>
  `builder-preview:${storeId}:${token}`;
