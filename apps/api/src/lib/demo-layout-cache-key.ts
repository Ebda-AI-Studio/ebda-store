// A dependency-free module on purpose: store.service imports it, and many tests mock lib/public-cache wholesale.
/**
 * Cache key of a DEMO store's public layout response (`public-store-layout.routes.ts`). Cleared by `bustStoreCaches`
 * on every publish path (Ruling DEMO-LAYOUT-PURGE-1). v2: the value is `{ isDemo, body }` (a v1 entry held the bare
 * body), so the bump makes an old entry a clean miss.
 */
export function demoLayoutCacheKey(storeId: string): string {
  return `public:layout-demo:v2:${storeId}`;
}
