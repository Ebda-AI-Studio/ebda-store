/**
 * #1214 — the credentialed-CORS custom-domain lookup admitted ANY store row
 * whose `domain` matched: an inactive (archived) or soft-deleted store's domain
 * stayed a `credentials: true` origin indefinitely, so offboarding a merchant
 * never revoked its origin's trust. The lookup now mirrors
 * `/public/store/resolve` (active or suspended, not deleted), and the trust is
 * busted on the same writes that bust the store's public caches.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('@api/lib/public-cache', () => ({
  invalidateCached: vi.fn(async () => undefined),
  invalidateCachedPrefix: vi.fn(async () => undefined),
  getCached: vi.fn(),
}));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));

import { corsCustomDomainWhere, corsDomainCache } from '@api/lib/cors-cache';
import { bustStoreCaches } from '@api/services/store.service';

/** Evaluate the where clause the way Postgres would, against a candidate row. */
function admits(row: { domain: string; status: string; deletedAt: Date | null }, host: string) {
  const w = corsCustomDomainWhere(host);
  return (
    row.domain === w.domain &&
    (w.status.in as string[]).includes(row.status) &&
    row.deletedAt === w.deletedAt
  );
}

describe('#1214 custom-domain CORS trust requires a live store', () => {
  const host = 'shop.example.com';

  it.each([
    ['active', null, true],
    ['suspended', null, true], // still serves its branded maintenance page
    ['inactive', null, false],
    ['active', new Date(), false], // soft-deleted
  ])('status=%s deletedAt=%s -> trusted=%s', (status, deletedAt, trusted) => {
    expect(admits({ domain: host, status, deletedAt: deletedAt as Date | null }, host)).toBe(
      trusted
    );
  });

  it('is the clause the CORS handler actually queries with', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'apps/api/src/index.ts'), 'utf8');
    expect(src).toMatch(/findFirst\(\{\s*where:\s*storeOriginWhere\.where/);
  });

  it('a store-cache bust (status change, delete) also drops the cached CORS verdict', async () => {
    corsDomainCache.set(host, { allowed: true, expiresAt: Date.now() + 60_000 });
    await bustStoreCaches('store-1', 'shop', host);
    expect(corsDomainCache.get(host)).toBeUndefined();
  });
});
