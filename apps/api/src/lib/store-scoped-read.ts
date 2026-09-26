import { hasTenantContext, runInTenantContext } from '@force/database';

/**
 * Run `fn` scoped to `storeId` under RLS, whether or not the caller already
 * has a tenant context.
 *
 * Why: 24 tables carry STRICT RLS policies (`store_id = app.current_store_id
 * OR app.bypass_rls`) with no allowance for a query that sets no context —
 * store_faqs, store_howtos, ai_recommendation, blog_posts, the accounting
 * tables, … (the full list is asserted by tests/integration/rls-force-app.test.ts).
 * Under the non-bypass `force_app` role a contextless read of one of them does
 * not error: it returns zero rows. That is how the 2026-09-25 cutover attempt
 * shipped `faqs: []` to every storefront.
 *
 * Public/storefront routes run outside `tenantContext`. Once such a route has
 * resolved its store, its reads of a strict table go through here.
 *
 *  - Already inside a tenant transaction (the request is under
 *    `tenantContext`, or a caller already wrapped it): just run `fn` on that
 *    transaction. Opening a second one would put the read on another
 *    connection — see `hasTenantContext` in packages/database for why that
 *    is wrong for writes, and it is pointless for reads.
 *  - No context: open a short `runInTenantContext(storeId, …)` for `fn`.
 *
 * Identical result on the owner role (policies ignored), so this is inert
 * until the cutover and correct after it. Never use it for work that spans
 * stores — that is `withRlsBypass`.
 */
export function readInStoreContext<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  if (hasTenantContext()) return fn();
  return runInTenantContext(storeId, fn);
}
