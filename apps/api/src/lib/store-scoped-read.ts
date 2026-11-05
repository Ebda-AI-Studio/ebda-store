import { currentTenantGucs, runInStoreScope, runInTenantContext } from '@ebda/database';
import { storeRepo } from './repo-factory';

/**
 * Run `fn` scoped to `storeId` under RLS, whether or not the caller already
 * has a tenant context.
 *
 * Why: 24 tables carry STRICT RLS policies (`store_id = app.current_store_id
 * OR app.bypass_rls`) with no allowance for a query that sets no context —
 * store_faqs, store_howtos, ai_recommendation, blog_posts, the accounting
 * tables, … (the full list is asserted by tests/integration/rls-ebda-app.test.ts).
 * Under the non-bypass `ebda_app` role a contextless read of one of them does
 * not error: it returns zero rows. That is how the 2026-09-25 cutover attempt
 * shipped `faqs: []` to every storefront.
 *
 * Public/storefront routes run outside `tenantContext`. Once such a route has
 * resolved its store, its reads of a strict table go through here.
 *
 *  - Already inside a tenant transaction scoped to THIS store (the request is
 *    under `tenantContext` for it, or a caller already wrapped it): just run
 *    `fn` on that transaction. Opening a second one would put the read on
 *    another connection — see `hasTenantContext` in packages/database for why
 *    that is wrong for writes, and it is pointless for reads.
 *  - Anything else — no context, OR a tenant transaction scoped to a
 *    DIFFERENT store or to NO store (issue 2041: `userContext` opens
 *    `runInTenantContext(undefined, …, userId)` for /addresses and a
 *    header-less /wishlist, and a strict-table read on that transaction
 *    returns `[]`): open a short `runInTenantContext(storeId, …)` for `fn`.
 *    A separate connection is correct for a READ; this helper is read-only by
 *    contract.
 *
 * Identical result on the owner role (policies ignored), so this is inert
 * until the cutover and correct after it. Never use it for work that spans
 * stores — that is `withRlsBypass`.
 *
 * A store on its Durable Object gets a bare store scope (no Postgres transaction): the code-level tenant guard still sees the
 * store (regression 2026-11-02, #382 hotfix), and a caller that still reads Postgres for it (not ported yet) fails at that
 * read, not here (NEON-ZERO-1 N-2).
 */
export async function readInStoreContext<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  if (currentTenantGucs()?.storeId === storeId) return fn();
  // A store on its Durable Object opens NO Postgres transaction (NEON-ZERO-1): a bare store scope keeps the tenant guard
  // satisfied, and anything `fn` still reads from Postgres fails loudly there instead of leasing a connection up front.
  if ((await storeRepo(storeId)).backend === 'do') return runInStoreScope(storeId, fn);
  return runInTenantContext(storeId, fn);
}

/**
 * A bare store scope for a store on its Durable Object, nothing for a Postgres store (NEON-ZERO-1). For a handler that
 * resolved its store and then makes several reads (settings, features, entitlements, tax): on a DO store `withStore` and
 * the tenant guard see the store without a Postgres transaction being opened for it; a Postgres store keeps its existing
 * per-read transactions byte for byte.
 */
export async function inDoStoreScope<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  if ((await storeRepo(storeId)).backend === 'do') return runInStoreScope(storeId, fn);
  return fn();
}

/**
 * `runInTenantContext(storeId, fn)` for a handler that WRITES (NEON-ZERO-1 N-11): a Postgres store opens its tenant transaction
 * exactly as before; a store on its Durable Object gets the bare store scope (no Postgres transaction, so a dead Postgres cannot
 * fail the request before the handler runs). Unlike `readInStoreContext` this never reuses or splits a transaction on Postgres.
 */
export async function runInStoreTenantContext<T>(
  storeId: string,
  fn: () => Promise<T>
): Promise<T> {
  if ((await storeRepo(storeId)).backend === 'do') return runInStoreScope(storeId, fn);
  return runInTenantContext(storeId, fn);
}
