import type { KnownFailureCase } from '../types';

/** Tag suggester returned a duplicate (case-insensitive) tag and an empty-string tag. */
export const productTagsDuplicateAndEmpty: KnownFailureCase = {
  id: 'product-tags-duplicate-and-empty',
  type: 'product-tags',
  description:
    'Tags include a case-insensitive duplicate ("Handmade" / "handmade") and an empty string.',
  input: {
    storeId: 'store-1',
    storeName: 'Test Store',
    product: { name: 'Ceramic Mug', description: 'A handmade ceramic mug.' },
    existingTagNames: ['handmade'],
  },
  output: ['Handmade', 'handmade', 'ceramic', ''],
  expectedFailedChecks: ['no-duplicate-tags', 'no-empty-tags'],
};
