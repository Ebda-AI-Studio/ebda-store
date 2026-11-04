// The async-context state that says WHICH tenant the current code runs for.
//
// Two independent layers read it:
//   - RLS (R-EBDA-001): `runInTenantContext` turns it into the transaction-local
//     GUCs `app.current_store_id` / `app.current_user_id` that every policy keys on;
//   - the code-level tenant guard (`tenant-guard.ts`, R-EBDA-003): a Prisma query
//     extension that refuses any query on a tenant model whose where/data is not
//     scoped to the ambient store.
// It lives in its own module so the client factory (`client.ts`) can install the
// guard without importing `index.ts` (which imports the factory).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantGucs } from './tenant-gucs';

/** The open tenant transaction of the current async context (`runInTenantContext`). */
export const tenantStorage = new AsyncLocalStorage<object>();

/** The RLS settings each tenant transaction was opened with. */
export const txGucs = new WeakMap<object, TenantGucs>();

/** A store scope WITHOUT a long-lived transaction (`runInStoreScope`). */
export const storeScope = new AsyncLocalStorage<{ storeId: string; userId?: string }>();

/**
 * The NAMED escape hatches of the code-level tenant guard. A closed list: there is
 * no generic bypass flag, and each entry is entered by exactly one function that
 * first proves it is allowed (see R-EBDA-003 in docs/RULINGS.md):
 *
 *  - 'owner-role-tx'     `withOwnerTx`: a transaction on a connection whose role
 *                         bypasses RLS by itself (superuser / BYPASSRLS), checked
 *                         against `pg_roles` before the hatch opens. It refuses the
 *                         `ebda_app` role, and `apps/api/src` may not import it.
 *  - 'platform-operator' `asPlatformOperator`: an ACTIVE super_admin (checked by
 *                         the `ebda_is_super_admin()` definer inside the same
 *                         transaction) reading the platform directory. Opens ONLY
 *                         the `Store` and identity models (`User`, `StoreStaff`) —
 *                         never a store-scoped tenant table.
 */
export type TenantGuardHatch = 'owner-role-tx' | 'platform-operator';

export const guardHatch = new AsyncLocalStorage<TenantGuardHatch>();

export interface AmbientScope {
  storeId?: string;
  userId?: string;
  hatch?: TenantGuardHatch;
}

/** What the current async context is scoped to (store, user, named hatch). */
export function ambientScope(): AmbientScope {
  const hatch = guardHatch.getStore();
  const tx = tenantStorage.getStore();
  if (tx) {
    const g = txGucs.get(tx);
    return { storeId: g?.storeId, userId: g?.userId, hatch };
  }
  const scope = storeScope.getStore();
  return { storeId: scope?.storeId, userId: scope?.userId, hatch };
}
