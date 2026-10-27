import { buildIdentity } from './build-identity';
import { buyerKeyVector } from './wa/health-vector';

/**
 * The public GET /health body: status, time, which build is running and, when the suite buyer-key secret is
 * set, `buyerKeyVector` (proof both Workers hold the same secret, WA-HEALTH-VECTOR-1). Never anything
 * derived from a phone, an order or a customer; the field is omitted, never a placeholder, without the secret.
 */
export async function healthPayload(
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, unknown>> {
  const vector = await buyerKeyVector(env.SUITE_BUYER_KEY_SECRET).catch(() => null);
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    ...buildIdentity(),
    ...(vector ? { buyerKeyVector: vector } : {}),
  };
}
