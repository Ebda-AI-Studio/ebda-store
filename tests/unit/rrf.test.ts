/**
 * Search program Task 12: reciprocal rank fusion + the E10 shape (fuse only the head of the
 * keyword leg, append the keyword tail in its own order).
 */
import { describe, it, expect } from 'vitest';
import { rrfFuse, hybridOrder } from '../../apps/api/src/lib/search/rrf';

describe('rrfFuse', () => {
  it('rewards items found by both legs and keeps single-leg items', () => {
    // c = 1/63 + 1/61; a = 1/61; b = 1/62; d = 1/62 (tie broken by id: b < d).
    expect(
      rrfFuse([
        ['a', 'b', 'c'],
        ['c', 'd'],
      ])
    ).toEqual(['c', 'a', 'b', 'd']);
  });

  it('empty legs', () => {
    expect(rrfFuse([[], ['x']])).toEqual(['x']);
    expect(rrfFuse([[], []])).toEqual([]);
  });

  it('is deterministic whatever the input order of equal scores', () => {
    expect(rrfFuse([['z'], ['y']])).toEqual(['y', 'z']);
    expect(rrfFuse([['y'], ['z']])).toEqual(['y', 'z']);
  });

  it('a single leg keeps its own order (no re-sort by id)', () => {
    expect(rrfFuse([['q', 'b', 'x', 'a']])).toEqual(['q', 'b', 'x', 'a']);
  });
});

describe('hybridOrder (E10: fuse the head, append the keyword tail)', () => {
  const lex = Array.from({ length: 8 }, (_, i) => `l${i}`);

  it('no vector hits → exactly the keyword order, every keyword id kept', () => {
    expect(hybridOrder(lex, [], 3)).toEqual(lex);
  });

  it('fuses only the first `head` keyword ids, then appends the rest in keyword order', () => {
    const out = hybridOrder(lex, ['v1', 'l1'], 3);
    // head = l0,l1,l2 fused with v1,l1: l1 = 1/62 + 1/62 first; then l0 (1/61), v1 (1/61) by id;
    // then l2 (1/63). Tail l3..l7 unchanged.
    expect(out).toEqual(['l1', 'l0', 'v1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7']);
  });

  it('a vector hit that sits in the keyword tail moves up into the fused head, once', () => {
    const out = hybridOrder(lex, ['l6'], 3);
    expect(out.filter(id => id === 'l6')).toHaveLength(1);
    expect(out.indexOf('l6')).toBeLessThan(3 + 1);
    expect(new Set(out)).toEqual(new Set(lex));
  });

  it('vector-only results when the keyword leg is empty (zero-result fallback)', () => {
    expect(hybridOrder([], ['v2', 'v1'], 50)).toEqual(['v2', 'v1']);
  });
});
