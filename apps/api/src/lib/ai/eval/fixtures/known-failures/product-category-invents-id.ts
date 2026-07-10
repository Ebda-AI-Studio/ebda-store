import type { KnownFailureCase } from '../types';

/**
 * Guards the generator's single hardest invariant: it must NEVER return a
 * category id outside the store's own taxonomy. The real code already
 * filters this (see product-category-suggester.ts `idSet.has(m.id)`) —
 * this fixture pins the invariant itself so a future refactor that drops
 * the filter is caught immediately by the eval suite, not by a merchant
 * seeing a phantom category.
 */
export const productCategoryInventsId: KnownFailureCase = {
  id: 'product-category-invents-id',
  type: 'product-category-suggestion',
  description: "Suggestion references a category id that does not exist in the store's taxonomy.",
  input: {
    storeId: 'store-1',
    storeName: 'Test Store',
    product: { name: 'Ceramic Mug', description: 'A handmade ceramic mug.' },
    existingCategories: [{ id: 'cat-kitchen', name: 'Kitchen & Dining', nameAr: null }],
  },
  output: [{ id: 'cat-electronics', confidence: 'high' }],
  expectedFailedChecks: ['never-invents-category-ids'],
};
