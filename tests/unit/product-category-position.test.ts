/**
 * Unit tests for product ordering within a category.
 *
 * Tests the position-based ordering logic that is applied in
 * ProductService.listPublic when filtering by a single category
 * and no explicit sort option is chosen.
 *
 * No DB required — all tests are pure JS.
 */
import { describe, it, expect } from 'vitest';

// ─── Helpers (mirrors ProductService logic) ─────────────────────────────────

/**
 * Re-sort a products array by the position map — mirrors what listPublic does
 * after fetching an id-IN list from the DB.
 */
function sortByPosition<T extends { id: string }>(products: T[], orderedIds: string[]): T[] {
  const posMap = new Map(orderedIds.map((id, i) => [id, i]));
  return products.slice().sort((a, b) => {
    const pa = posMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const pb = posMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}

/**
 * Simulate a reorder endpoint write: given a list of product IDs in desired
 * order, return a position map (productId → index) the same way the API
 * stores it.
 */
function buildPositionMap(orderedProductIds: string[]): Map<string, number> {
  return new Map(orderedProductIds.map((id, i) => [id, i]));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('buildPositionMap — position = index', () => {
  it('assigns positions 0..n-1 in order', () => {
    const ids = ['a', 'b', 'c'];
    const map = buildPositionMap(ids);
    expect(map.get('a')).toBe(0);
    expect(map.get('b')).toBe(1);
    expect(map.get('c')).toBe(2);
  });

  it('handles a single product', () => {
    const map = buildPositionMap(['x']);
    expect(map.get('x')).toBe(0);
  });

  it('handles empty list without throwing', () => {
    const map = buildPositionMap([]);
    expect(map.size).toBe(0);
  });
});

describe('sortByPosition — storefront default ordering', () => {
  const products = [
    { id: 'p1', name: 'Alpha' },
    { id: 'p2', name: 'Beta' },
    { id: 'p3', name: 'Gamma' },
    { id: 'p4', name: 'Delta' },
  ];

  it('returns products in the merchant-defined order', () => {
    const ordered = sortByPosition(products, ['p3', 'p1', 'p4', 'p2']);
    expect(ordered.map(p => p.id)).toEqual(['p3', 'p1', 'p4', 'p2']);
  });

  it('preserves the original array (no mutation)', () => {
    const copy = products.slice();
    sortByPosition(products, ['p2', 'p1', 'p3', 'p4']);
    expect(products).toEqual(copy);
  });

  it('pushes products not in the orderedIds list to the end', () => {
    // p4 is missing from orderedIds — it should sort to the back.
    const ordered = sortByPosition(products, ['p2', 'p3', 'p1']);
    expect(ordered[0].id).toBe('p2');
    expect(ordered[1].id).toBe('p3');
    expect(ordered[2].id).toBe('p1');
    expect(ordered[3].id).toBe('p4'); // unknown → MAX_SAFE_INTEGER
  });

  it('is stable when two products have the same position sentinel', () => {
    const subset = [{ id: 'x' }, { id: 'y' }];
    // Both unknown → positions are equal → original order preserved (stable)
    const ordered = sortByPosition(subset, []);
    expect(ordered.map(p => p.id)).toEqual(['x', 'y']);
  });

  it('handles a fully reversed desired order correctly', () => {
    const ordered = sortByPosition(products, ['p4', 'p3', 'p2', 'p1']);
    expect(ordered.map(p => p.id)).toEqual(['p4', 'p3', 'p2', 'p1']);
  });
});

describe('reorder endpoint contract — orderedProductIds validates membership', () => {
  /**
   * Simulate the server-side membership check: every ID in orderedIds must
   * exist in the categoryMemberIds set (what the DB returns).
   */
  function validateMembership(orderedIds: string[], categoryMemberIds: string[]): string[] {
    const memberSet = new Set(categoryMemberIds);
    return orderedIds.filter(id => !memberSet.has(id));
  }

  it('passes when all ordered IDs are category members', () => {
    const unknown = validateMembership(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(unknown).toHaveLength(0);
  });

  it('returns unknown IDs when a product is not in the category', () => {
    const unknown = validateMembership(['a', 'b', 'z'], ['a', 'b', 'c']);
    expect(unknown).toEqual(['z']);
  });

  it('returns all IDs when none are category members', () => {
    const unknown = validateMembership(['x', 'y'], ['a', 'b']);
    expect(unknown).toEqual(['x', 'y']);
  });

  it('returns empty when ordered list is empty', () => {
    const unknown = validateMembership([], ['a', 'b']);
    expect(unknown).toHaveLength(0);
  });
});
