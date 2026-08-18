import { describe, it, expect } from 'vitest';
import { classifyOrphans } from '../../scripts/r2-orphan-audit';

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const HOUR = 3600_000;
const obj = (key: string, size = 100, agoMs?: number) => ({
  key,
  size,
  lastModified: agoMs === undefined ? undefined : new Date(NOW - agoMs),
});

describe('classifyOrphans — the R2 delete guard', () => {
  it('treats referenced keys as not-orphans regardless of age', () => {
    const r = classifyOrphans([obj('a', 10, 99 * HOUR)], new Set(['a']), 24 * HOUR, NOW);
    expect(r.orphans).toEqual([]);
    expect(r.totalBytes).toBe(10);
    expect(r.orphanBytes).toBe(0);
  });

  it('marks an old unreferenced key as an orphan', () => {
    const r = classifyOrphans([obj('a', 10, 99 * HOUR)], new Set(), 24 * HOUR, NOW);
    expect(r.orphans).toEqual(['a']);
    expect(r.orphanBytes).toBe(10);
  });

  it('SKIPS a freshly-uploaded unreferenced key — the data-loss guard', () => {
    // A file PUT to R2 whose DB row has not landed yet. Deleting it is the
    // failure mode that may have produced Palora's missing covers.
    const r = classifyOrphans([obj('fresh', 10, 1 * HOUR)], new Set(), 24 * HOUR, NOW);
    expect(r.orphans).toEqual([]);
    expect(r.skippedRecent).toBe(1);
  });

  it('is exclusive at the boundary — exactly minAge is old enough', () => {
    const r = classifyOrphans([obj('edge', 10, 24 * HOUR)], new Set(), 24 * HOUR, NOW);
    expect(r.orphans).toEqual(['edge']);
    expect(r.skippedRecent).toBe(0);
  });

  it('treats a missing lastModified as infinitely old (deletable)', () => {
    const r = classifyOrphans([obj('nodate', 10, undefined)], new Set(), 24 * HOUR, NOW);
    expect(r.orphans).toEqual(['nodate']);
  });

  it('totals bytes across every object, orphan or not', () => {
    const r = classifyOrphans(
      [obj('keep', 5, 99 * HOUR), obj('drop', 7, 99 * HOUR), obj('fresh', 3, 0)],
      new Set(['keep']),
      24 * HOUR,
      NOW
    );
    expect(r.totalBytes).toBe(15);
    expect(r.orphanBytes).toBe(7);
    expect(r.orphans).toEqual(['drop']);
    expect(r.skippedRecent).toBe(1);
  });

  it('handles an empty bucket', () => {
    expect(classifyOrphans([], new Set(), 24 * HOUR, NOW)).toEqual({
      orphans: [],
      orphanBytes: 0,
      totalBytes: 0,
      skippedRecent: 0,
    });
  });
});
