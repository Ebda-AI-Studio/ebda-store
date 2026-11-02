import { buildIdentity } from './build-identity';
import { cfBindings } from '../cf/bindings';
import { storageBackendCounts } from './store-backend';
import { buyerKeyVector } from './wa/health-vector';
import { isWorkers } from './runtime';

/**
 * The public GET /health body: status, time, which build is running and, when the suite buyer-key secret is
 * set, `buyerKeyVector` (proof both Workers hold the same secret, WA-HEALTH-VECTOR-1), and `platform_db` is "ok" | "unavailable" (D1 reachable; omitted when unbound). Never anything
 * derived from a phone, an order or a customer; the field is omitted, never a placeholder, without the secret.
 */
export async function healthPayload(
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, unknown>> {
  const [vector, backends] = await Promise.all([
    buyerKeyVector(env.SUITE_BUYER_KEY_SECRET).catch(() => null),
    storageBackendCounts(cfBindings()?.PLATFORM_DB),
  ]);
  // Fail loud at boot (multi-service env rule): a DEPLOYED Worker without the platform D1 would silently serve the legacy
  // Postgres paths (backendFor defaults to `pg`, store writes keep the Postgres route). `status: degraded` makes the deploy-guard
  // probe (`status === 'ok'` + commit) fail, so the deploy rolls back instead of degrading.
  const platformUnbound = isWorkers && backends === undefined;
  return {
    status: platformUnbound ? 'degraded' : 'ok',
    timestamp: new Date().toISOString(),
    ...buildIdentity(),
    ...(vector ? { buyerKeyVector: vector } : {}),
    // Public: reachability only. The per-backend store COUNTS disclose the store count, so they are served only by
    // the super_admin GET /api/v1/health (app.ts).
    ...(backends !== undefined
      ? { platform_db: backends === null ? 'unavailable' : 'ok' }
      : platformUnbound
        ? { platform_db: 'unbound' }
        : {}),
  };
}
