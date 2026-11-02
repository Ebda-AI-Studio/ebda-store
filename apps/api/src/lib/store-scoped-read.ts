import { currentTenantGucs, runInTenantContext } from '@ebda/database';

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
 * It opens the tenant context for a store on its Durable Object TOO (regression 2026-11-02, #382 hotfix): callers that still read
 * Postgres for such a store (raw `$queryRaw` of FAQs / how-tos, tax rates, features, notification config: not ported yet, plan
 * N-3..N-11) are refused by the code-level tenant guard without it, which made GET /public/stores/:slug a 500 for every DO store.
 * Skipping the transaction is each caller's decision, once it reads ONLY through `storeDb`, never this helper's.
 */
export function readInStoreContext<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  if (currentTenantGucs()?.storeId === storeId) return fn();
  return runInTenantContext(storeId, fn);
}
