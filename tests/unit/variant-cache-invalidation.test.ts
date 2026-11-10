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
import ts from 'typescript';
import { all, callsIn, parseFile } from './helpers/ast-statements';

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

/** The `static` method node called `name` (a real AST node, so it cannot run into its neighbour). */
function method(name: string): ts.MethodDeclaration {
  const m = all(parseFile('apps/api/src/services/variant.service.ts'), ts.isMethodDeclaration).find(
    x => x.name.getText() === name && x.modifiers?.some(k => k.kind === ts.SyntaxKind.StaticKeyword)
  );
  expect(m, `${name} not found in variant.service.ts`).toBeTruthy();
  return m!;
}

describe('variant.service cache invalidation', () => {
  it('imports the shared product-cache invalidator', () => {
    expect(src).toContain("from '../lib/public-cache'");
    expect(src).toContain('invalidateStoreProductCaches');
  });

  it.each(MUTATORS)('%s busts the store product caches', name => {
    // a real call to the invalidator, not a comment or string that names it
    expect(callsIn(method(name), 'invalidateStoreProductCaches').length).toBeGreaterThan(0);
  });

  it('documents why reorderVariants is deliberately exempt', () => {
    // Position-only writes: no cached payload orders on variant position, so
    // the omission must read as a decision, not an oversight.
    expect(method('reorderVariants').getText()).toMatch(/position/i);
  });
});
