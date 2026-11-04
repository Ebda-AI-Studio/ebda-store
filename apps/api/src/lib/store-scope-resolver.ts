/**
 * NEON-ZERO (Ruling NZ-C-3): tells `withStore` / `acrossStores` (packages/database) which stores must NOT open a Postgres
 * transaction. A store served by its Durable Object (D1 `stores.storage_backend = 'do'`) has no Postgres rows to scope to,
 * so a caller outside any request transaction (the super-admin hub, a job step) gets the lazy per-query store scope.
 *
 * Before the platform families move, a store with no directory row (404 STORE_NOT_FOUND from `backendFor`) is treated as a Postgres store: provisioning
 * creates the Postgres row first and syncs the directory after, and `withStore` there must keep working. An unreadable
 * flag (503) propagates: never a guess. Import once at boot (app.ts).
 */
import { setHubStoreLister, setStoreScopeResolver, setUserScopeNoPg } from '@ebda/database';
import { hubFanoutStoreIds, hubOnD1 } from './platform-hub';
import { backendFor } from './store-backend';
import { AppError } from '../middleware/error-handler';

export async function resolveStoreScope(storeId: string): Promise<'pg' | 'no-pg'> {
  try {
    return (await backendFor(storeId)) === 'do' ? 'no-pg' : 'pg';
  } catch (err) {
    // Once the platform families are on D1 the directory holds every store (N-14): an unknown id is a real 404, not Postgres.
    if (err instanceof AppError && err.statusCode === 404 && !(await hubOnD1())) return 'pg';
    throw err;
  }
}

setStoreScopeResolver(resolveStoreScope);

// The hub (user scope, no store) lists its stores from D1 once the platform families moved; otherwise undefined = the definer.
setHubStoreLister(async () => ((await hubOnD1()) ? (await hubFanoutStoreIds()).ids : undefined));
setUserScopeNoPg(() => hubOnD1());
