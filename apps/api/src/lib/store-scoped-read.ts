import { currentTenantGucs, runInTenantContext } from '@ebda/database';
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
 */
export async function readInStoreContext<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  if (currentTenantGucs()?.storeId === storeId) return fn();
  // NEON-ZERO-1: a store on its Durable Object has no RLS and no Postgres: `fn` reads through `storeDb`, which routes to the DO.
  // Opening a tenant transaction here would acquire a Postgres connection the request does not need (and cannot get).
  if ((await storeRepo(storeId)).backend === 'do') return fn();
  return runInTenantContext(storeId, fn);
}
