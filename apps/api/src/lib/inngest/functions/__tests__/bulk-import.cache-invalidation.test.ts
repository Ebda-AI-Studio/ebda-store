import { describe, it, expect } from 'vitest';
import { shouldInvalidateAfterBulkImport } from '../bulk-import';

// M2 (docs/audits/2026-07-13-cache-stampede.md): before this fix,
// `BulkService.importProducts()` wrote products via raw batched Prisma
// calls and the Inngest wrapper never called `invalidateStoreProductCaches`
// afterwards — a merchant who bulk-imported/updated their whole catalog kept
// seeing the pre-import product list/detail/suggest cache for up to the full
// 120s TTL. `shouldInvalidateAfterBulkImport` is the gating logic that now
// decides whether the post-import sweep runs; extracted (matching the
// `webhook-offload.guard.ts` pattern in this same directory) so it's
// unit-testable without standing up the full Inngest handler's
// `$transaction`/RLS-context machinery.
describe('shouldInvalidateAfterBulkImport', () => {
  it('invalidates when the import created new products', () => {
    expect(shouldInvalidateAfterBulkImport({ created: 3, updated: 0 })).toBe(true);
  });

  it('invalidates when the import updated existing products (price/stock corrections via CSV)', () => {
    expect(shouldInvalidateAfterBulkImport({ created: 0, updated: 5 })).toBe(true);
  });

  it('invalidates when a batch both created and updated rows', () => {
    expect(shouldInvalidateAfterBulkImport({ created: 2, updated: 2 })).toBe(true);
  });

  it('does NOT invalidate a no-op import (every row failed / nothing written)', () => {
    expect(shouldInvalidateAfterBulkImport({ created: 0, updated: 0 })).toBe(false);
  });
});
