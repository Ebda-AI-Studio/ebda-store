/**
 * Cache invalidation + entitlement guard for the B2B wholesale write paths (docs/plans/done/2026-10-21-b2b-wholesale.md Task 4).
 *
 * Price, MOQ, audience, group membership and approval status are NEVER-stale (cache-invalidate-every-write-path): every
 * writer calls `invalidateB2bPricing` AFTER its transaction commits (it clears the Redis / KV product caches and purges the
 * storefront data cache through `invalidateStoreProductCaches`). There is NO per-buyer cache: group prices are computed per
 * request and sent `private, no-store`, so a membership change needs no per-buyer purge, only the public product payload
 * (public tiers, MOQ, audience) is cached. `tests/unit/b2b-invalidate-callsites.test.ts` is the ledger: it fails if a listed
 * writer stops calling this, and if this function has no caller.
 */
import { deferAfterTenantCommit } from './after-tenant-commit';
import { invalidateStoreProductCaches } from './public-cache';
import { AppError } from '../middleware/error-handler';
import { wholesaleEntitledUncached } from '../services/price-resolver.service';

export function invalidateB2bPricing(storeId: string): void {
  void deferAfterTenantCommit('b2b.invalidate-pricing', () =>
    invalidateStoreProductCaches(storeId)
  );
}

/** 403 FEATURE_DISABLED unless the store has `b2b.wholesale` (read UNCACHED: a just-made downgrade binds the next write). */
export async function assertWholesaleEntitled(storeId: string): Promise<void> {
  if (!(await wholesaleEntitledUncached(storeId))) {
    throw new AppError(
      403,
      'FEATURE_DISABLED',
      "Wholesale pricing is not included in this store's plan.",
      {
        feature: 'b2b.wholesale',
      }
    );
  }
}
