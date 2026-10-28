import { buildIdentity } from './build-identity';
import { cfBindings } from '../cf/bindings';
import { storageBackendCounts } from './store-backend';
import { buyerKeyVector } from './wa/health-vector';

/**
 * The public GET /health body: status, time, which build is running and, when the suite buyer-key secret is
 * set, `buyerKeyVector` (proof both Workers hold the same secret, WA-HEALTH-VECTOR-1). Never anything
 * `storage_backend` is the live per-backend store count from D1 (null = D1 unreadable, omitted when unbound), the
 * cutover's evidence (runbook s4 row 1). Never anything
 * derived from a phone, an order or a customer; the field is omitted, never a placeholder, without the secret.
 */
export async function healthPayload(
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, unknown>> {
  const [vector, backends] = await Promise.all([
    buyerKeyVector(env.SUITE_BUYER_KEY_SECRET).catch(() => null),
    storageBackendCounts(cfBindings()?.PLATFORM_DB),
  ]);
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    ...buildIdentity(),
    ...(vector ? { buyerKeyVector: vector } : {}),
    ...(backends !== undefined ? { storage_backend: backends } : {}),
  };
}
