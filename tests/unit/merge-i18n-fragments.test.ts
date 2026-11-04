import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { mergeFragments, leafPaths } from '../../scripts/merge-i18n-fragments.mjs';

describe('merge-i18n-fragments', () => {
  const base = { a: { x: 'old', y: 'keep' }, b: 'b' };

  it('fragment keys win and new keys are added', () => {
    const { merged, conflicts } = mergeFragments(base, {
      t3: { a: { x: 'new' }, c: { d: 'added' } },
    });
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({ a: { x: 'new', y: 'keep' }, b: 'b', c: { d: 'added' } });
  });

  it('is idempotent', () => {
    const frags = { t3: { a: { x: 'new' } }, t4: { z: '1' } };
    const once = mergeFragments(base, frags).merged;
    const twice = mergeFragments(once, frags).merged;
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('fails when two fragments own the same leaf key', () => {
    const { conflicts } = mergeFragments(base, { t3: { a: { x: '1' } }, t4: { a: { x: '2' } } });
    expect(conflicts).toEqual(['a.x is defined by both "t3" and "t4"']);
  });

  it('does not mutate the base', () => {
    const copy = structuredClone(base);
    mergeFragments(base, { t3: { a: { x: 'new' } } });
    expect(base).toEqual(copy);
  });

  it('lists leaf paths', () => {
    expect(leafPaths({ a: { b: 1, c: { d: 2 } }, e: 3 })).toEqual(['a.b', 'a.c.d', 'e']);
  });
});
