/**
 * NEON-ZERO (Ruling NZ-D23): a store still flagged `pg` in the D1 directory (the soft-deleted `qa-merchant-test`) has its rows
 * only in Postgres, and a Worker without the Hyperdrive binding has no Postgres. A retention/sweep job that visits "every
 * store" can read nothing for it and used to fail the whole daily run on it (search-log-purge-daily, webhook-delivery-purge-daily,
 * 2026-11-09). Node (Railway, tests, scripts) keeps Postgres, so it is never skipped there.
 */
import { postgresRemovedOnThisWorker } from './postgres-present';
import { backendFor } from './store-backend';

export async function storeHasNoDataHere(storeId: string): Promise<boolean> {
  if (!postgresRemovedOnThisWorker()) return false;
  return (await backendFor(storeId)) !== 'do';
}
