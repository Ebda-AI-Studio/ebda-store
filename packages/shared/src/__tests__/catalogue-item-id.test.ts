import { describe, it, expect } from 'vitest';
import { catalogueItemId, catalogueGroupId } from '../commerce/catalogue-item-id';

describe('catalogue item id contract', () => {
  it('simple product -> product id', () => {
    expect(catalogueItemId({ productId: 'p1' })).toBe('p1');
    expect(catalogueItemId({ productId: 'p1', variantId: null })).toBe('p1');
  });
  it('variant -> variant id, group -> product id', () => {
    expect(catalogueItemId({ productId: 'p1', variantId: 'v9' })).toBe('v9');
    expect(catalogueGroupId('p1')).toBe('p1');
  });
});
