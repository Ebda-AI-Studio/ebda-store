/**
 * public-cache.ts: "ANY write that changes a product's price or stock MUST
 * call invalidateStoreProductCaches". Variant writes change stock. Until
 * 2026-08-30 variant.service.ts called it exactly zero times across 752 lines
 * of variant CRUD — including bulkUpdateInventory — so a merchant restocking
 * a variant saw no change on the storefront until the TTL lapsed. That is the
 * second half of "I updated the variant and nothing happened".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(__dirname, '../../apps/api/src/services/variant.service.ts'),
  'utf8'
);

const MUTATORS = [
  'createVariant',
  'updateVariant',
  'deleteVariant',
  'generateVariants',
  'bulkUpdateInventory',
];

/** Body of `static async <name>(` up to the next same-depth `static`. */
function methodBody(name: string): string {
  const start = src.indexOf(`static async ${name}(`);
  expect(start, `${name} not found in variant.service.ts`).toBeGreaterThan(-1);
  const next = src.indexOf('\n  static ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('variant.service cache invalidation', () => {
  it('imports the shared product-cache invalidator', () => {
    expect(src).toContain("from '../lib/public-cache'");
    expect(src).toContain('invalidateStoreProductCaches');
  });

  it.each(MUTATORS)('%s busts the store product caches', name => {
    expect(methodBody(name)).toContain('invalidateStoreProductCaches');
  });

  it('documents why reorderVariants is deliberately exempt', () => {
    // Position-only writes: no cached payload orders on variant position, so
    // the omission must read as a decision, not an oversight.
    const body = methodBody('reorderVariants');
    expect(body).toMatch(/position/i);
  });
});
