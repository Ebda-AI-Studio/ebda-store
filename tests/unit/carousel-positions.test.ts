/**
 * Unit tests for New Arrivals and Best Sellers carousel position ordering.
 *
 * Tests the position-based ordering logic applied in ProductService.listPublic
 * when sort=newest (New Arrivals carousel) or sort=best_seller (Best Sellers
 * carousel) is requested. Mirrors the pattern established by
 * product-category-position.test.ts (PR #362).
 *
 * No DB required — all tests are pure JS.
 */
import { describe, it, expect } from 'vitest';

// ─── Helpers (mirrors ProductService.listPublic ordering logic) ───────────────

/**
 * Sort products by their carousel position, with createdAt desc as a stable
 * tiebreaker for products that share the default position (0).
 *
 * Mirrors the orderBy applied in listPublic for sort=newest / sort=best_seller:
 *   orderBy: [{ newArrivalPosition: 'asc' }, { createdAt: 'desc' }]
 *   orderBy: [{ bestSellerPosition: 'asc' }, { createdAt: 'desc' }]
 */
function sortByCarouselPosition<T extends { id: string; position: number; createdAt: Date }>(
  products: T[]
): T[] {
  return products.slice().sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    // Tiebreaker: newer first (desc)
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

/**
 * Simulate a reorder endpoint write: map each product ID to its index so
 * position = index in the orderedProductIds array.
 */
function buildCarouselPositionMap(orderedProductIds: string[]): Map<string, number> {
  return new Map(orderedProductIds.map((id, i) => [id, i]));
}

/**
 * Validate that every ID in the list belongs to this carousel (has the flag).
 * Returns unknown IDs the same way the API endpoint does.
 */
function findUnknownIds(orderedIds: string[], carouselIds: Set<string>): string[] {
  return orderedIds.filter(id => !carouselIds.has(id));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const NOW = new Date('2026-06-22T00:00:00Z');
const t = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

describe('buildCarouselPositionMap — position = index', () => {
  it('assigns positions 0..n-1 in order', () => {
    const ids = ['p1', 'p2', 'p3'];
    const map = buildCarouselPositionMap(ids);
    expect(map.get('p1')).toBe(0);
    expect(map.get('p2')).toBe(1);
    expect(map.get('p3')).toBe(2);
  });

  it('handles a single product', () => {
    const map = buildCarouselPositionMap(['x']);
    expect(map.get('x')).toBe(0);
  });

  it('handles an empty list without throwing', () => {
    const map = buildCarouselPositionMap([]);
    expect(map.size).toBe(0);
  });
});

describe('sortByCarouselPosition — new arrivals carousel', () => {
  const products = [
    { id: 'p1', name: 'Alpha', position: 2, createdAt: t(-1000) },
    { id: 'p2', name: 'Beta', position: 0, createdAt: t(-2000) },
    { id: 'p3', name: 'Gamma', position: 1, createdAt: t(-3000) },
    { id: 'p4', name: 'Delta', position: 3, createdAt: t(-4000) },
  ];

  it('returns products in ascending position order', () => {
    const sorted = sortByCarouselPosition(products);
    expect(sorted.map(p => p.id)).toEqual(['p2', 'p3', 'p1', 'p4']);
  });

  it('preserves the original array (no mutation)', () => {
    const copy = products.map(p => ({ ...p }));
    sortByCarouselPosition(products);
    expect(products).toEqual(copy);
  });

  it('tiebreaks by createdAt desc when positions are equal', () => {
    const tied = [
      { id: 'old', name: 'Old', position: 0, createdAt: t(-5000) },
      { id: 'new', name: 'New', position: 0, createdAt: t(-1000) },
      { id: 'mid', name: 'Mid', position: 0, createdAt: t(-3000) },
    ];
    const sorted = sortByCarouselPosition(tied);
    // Newer products come first when position is tied (matches orderBy createdAt desc)
    expect(sorted.map(p => p.id)).toEqual(['new', 'mid', 'old']);
  });

  it('handles a single product without error', () => {
    const sorted = sortByCarouselPosition([{ id: 'x', name: 'X', position: 0, createdAt: NOW }]);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].id).toBe('x');
  });

  it('handles an empty array without error', () => {
    expect(sortByCarouselPosition([])).toEqual([]);
  });
});

describe('sortByCarouselPosition — best sellers carousel', () => {
  it('applies the same logic as new arrivals (position asc + createdAt desc tiebreak)', () => {
    const bestSellers = [
      { id: 'bs1', name: 'Hoodie', position: 1, createdAt: t(-1000) },
      { id: 'bs2', name: 'Tshirt', position: 0, createdAt: t(-2000) },
      { id: 'bs3', name: 'Shoes', position: 2, createdAt: t(-500) },
    ];
    const sorted = sortByCarouselPosition(bestSellers);
    expect(sorted.map(p => p.id)).toEqual(['bs2', 'bs1', 'bs3']);
  });
});

describe('findUnknownIds — membership validation', () => {
  const carouselIds = new Set(['p1', 'p2', 'p3', 'p4']);

  it('returns empty array when all IDs are in the carousel', () => {
    const unknown = findUnknownIds(['p1', 'p3', 'p2'], carouselIds);
    expect(unknown).toHaveLength(0);
  });

  it('returns the unknown IDs', () => {
    const unknown = findUnknownIds(['p1', 'p99', 'p2', 'p100'], carouselIds);
    expect(unknown).toEqual(['p99', 'p100']);
  });

  it('flags all IDs as unknown when the carousel is empty', () => {
    const unknown = findUnknownIds(['p1', 'p2'], new Set());
    expect(unknown).toEqual(['p1', 'p2']);
  });

  it('returns empty array for an empty orderedIds list', () => {
    const unknown = findUnknownIds([], carouselIds);
    expect(unknown).toHaveLength(0);
  });
});

describe('reorder round-trip — position persists and reads back in order', () => {
  it('a reorder followed by a re-sort produces the expected display order', () => {
    // Simulate merchant dragging p3 to position 0, p1 to 1, p2 to 2
    const merchantOrder = ['p3', 'p1', 'p2'];
    const positionMap = buildCarouselPositionMap(merchantOrder);

    // Apply positions to products (as the API update would do)
    const products = [
      { id: 'p1', name: 'Alpha', position: positionMap.get('p1')!, createdAt: t(-1000) },
      { id: 'p2', name: 'Beta', position: positionMap.get('p2')!, createdAt: t(-2000) },
      { id: 'p3', name: 'Gamma', position: positionMap.get('p3')!, createdAt: t(-3000) },
    ];

    const sorted = sortByCarouselPosition(products);
    expect(sorted.map(p => p.id)).toEqual(merchantOrder);
  });

  it('a full re-reverse produces the reversed display order', () => {
    const original = ['p1', 'p2', 'p3', 'p4'];
    const reversed = [...original].reverse();
    const positionMap = buildCarouselPositionMap(reversed);

    const products = original.map((id, i) => ({
      id,
      name: `Product ${i}`,
      position: positionMap.get(id)!,
      createdAt: t(-i * 1000),
    }));

    const sorted = sortByCarouselPosition(products);
    expect(sorted.map(p => p.id)).toEqual(reversed);
  });
});
