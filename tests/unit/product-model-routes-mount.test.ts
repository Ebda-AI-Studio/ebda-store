/**
 * The product-models router must be mounted ABOVE every `/stores/:storeId…`
 * tenantContext mount and carry no tenantContext itself: an Express `use` is
 * a prefix match, so a tenantContext mount listed earlier would open the 30 s
 * request transaction before the 15 MB upload handler ran (#1602 pattern; the
 * same pin as ai-routes-no-request-transaction.test.ts).
 *
 * Mutation check (2026-10-07): moving the mount below the products mount, or
 * adding `tenantContext` to it, turns this red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC = readFileSync(resolve(__dirname, '../../apps/api/src/routes/index.ts'), 'utf8');

describe('product-models mount', () => {
  const line = SRC.split('\n').find(l => l.includes("'/stores/:storeId/product-models'"));

  it('exists and opens no request transaction', () => {
    expect(line).toBeDefined();
    expect(line).toBe("router.use('/stores/:storeId/product-models', productModelRoutes);");
  });

  it('sits above every /stores/:storeId tenantContext mount', () => {
    const at = SRC.indexOf("router.use('/stores/:storeId/product-models'");
    const tenantMounts = [
      ...SRC.matchAll(/^router\.use\('\/stores\/:storeId[^']*',\s*tenantContext/gm),
    ];
    expect(tenantMounts.length).toBeGreaterThan(3);
    for (const mnt of tenantMounts) expect(at).toBeLessThan(mnt.index!);
  });
});
