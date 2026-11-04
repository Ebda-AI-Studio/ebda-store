/**
 * Single serializer for every API response that carries a Store row.
 *
 * The Store row holds server-only secrets (today: `marketingPixels.*.accessToken`,
 * the Meta CAPI / TikTok Events tokens). Every route that returns a store MUST
 * pass it through `toSafeStoreResponse` so a write handler can't echo a secret
 * the GET path would have masked (STORE-RESP-SECRETS-1). A guard test
 * (tests/unit/store-response-secrets.test.ts) fails if a response skips it.
 * Other credentials live in `StoreCredential` (R-EBDA-005), never on this row.
 */
import { maskMarketingPixelSecrets } from './marketing-pixels-secrets';

export function toSafeStoreResponse<T>(store: T): T {
  if (!store || typeof store !== 'object') return store;
  const row = store as Record<string, unknown>;
  if (!('marketingPixels' in row)) return store;
  return { ...row, marketingPixels: maskMarketingPixelSecrets(row.marketingPixels) } as T;
}
