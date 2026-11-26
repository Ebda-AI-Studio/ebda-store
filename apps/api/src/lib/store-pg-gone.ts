/**
 * NEON-ZERO (Ruling NZ-D23): a store still flagged `pg` in the D1 directory (the soft-deleted `qa-merchant-test`) has its rows
 * only in Postgres, and a Worker without a Postgres binding has no Postgres. A retention/sweep job that visits "every
 * store" can read nothing for it and used to fail the whole daily run on it (search-log-purge-daily, webhook-delivery-purge-daily,
 * 2026-11-09). Node (Railway, tests, scripts) keeps Postgres, so it is never skipped there.
 */
import { postgresRemovedOnThisWorker } from './postgres-present';
import { backendFor } from './store-backend';
import { isStoreGoneError } from './jobs/store-gone';

export async function storeHasNoDataHere(storeId: string): Promise<boolean> {
  if (!postgresRemovedOnThisWorker()) return false;
  try {
    return (await backendFor(storeId)) !== 'do';
  } catch (err) {
    // On a Worker `backendFor` itself answers 410 STORE_STORAGE_REMOVED for a `pg` row (NZ-D23), so the comparison above is
    // never reached for exactly the store this guard exists for (search-log-purge-daily failed on qa-merchant-test again,
    // 2026-11-11). A store that is gone (410 / 404) has no data here either.
    if (isStoreGoneError(err)) return true;
    throw err;
  }
}
