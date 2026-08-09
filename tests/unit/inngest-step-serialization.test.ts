import { describe, it, expect } from 'vitest';

// r2-orphan-sweep threw `referenced.has is not a function` on EVERY run since it
// shipped (d8d27e86) and had never once completed. Cause: Inngest persists each
// step.run result so a replay can resume without re-running it, and that
// round-trip is JSON. Rich types do not survive it.
//
// The consequence was not just a red alert — the sweep is the safety net that
// detects orphaned R2 objects, so while it was dead an object from a 2026-06-15
// tenant delete sat undetected until a manual audit found it on 2026-08-09.
//
// These tests encode the trap itself rather than the specific call sites,
// because the same mistake is available in all ~57 Inngest functions.
const throughStepBoundary = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

describe('Inngest step.run JSON boundary', () => {
  describe('the shapes that silently break', () => {
    it('a Set degrades to {} and loses .has() — the exact reported failure', () => {
      const before = new Set(['stores/a/x.jpg']);
      expect(before.has('stores/a/x.jpg')).toBe(true);

      const after = throughStepBoundary(before) as Set<string>;
      expect(typeof after.has).not.toBe('function');
      expect(() => after.has('stores/a/x.jpg')).toThrow(TypeError);
    });

    it('a Date degrades to a string and loses .getTime() — the latent second bug', () => {
      // This one sat 3 lines below the reported crash and would have surfaced
      // the moment the Set was fixed, in `now - obj.lastModified.getTime()`.
      const before = { lastModified: new Date('2026-06-15T09:31:00Z') };
      const after = throughStepBoundary(before) as { lastModified: Date };
      expect(typeof after.lastModified).toBe('string');
      expect(() => after.lastModified.getTime()).toThrow(TypeError);
    });

    it('a Map degrades too — same family, worth knowing', () => {
      const after = throughStepBoundary(new Map([['k', 'v']])) as Map<string, string>;
      expect(typeof after.get).not.toBe('function');
    });
  });

  describe('the shapes that survive — what a step must return', () => {
    it('an array of strings survives, so a Set is sent as Array.from(set)', () => {
      const keys = ['stores/a/x.jpg', 'stores/b/y.png'];
      const after = throughStepBoundary(keys) as string[];
      expect(after).toEqual(keys);
      // and the Set is rebuilt on the far side, where it is actually used
      expect(new Set(after).has('stores/a/x.jpg')).toBe(true);
    });

    it('an ISO string survives, and rebuilds into the identical Date', () => {
      const original = new Date('2026-06-15T09:31:00Z');
      const after = throughStepBoundary({ iso: original.toISOString() }) as { iso: string };
      expect(new Date(after.iso).getTime()).toBe(original.getTime());
    });

    it('null survives for an absent date — undefined does NOT', () => {
      // JSON.stringify DROPS undefined properties entirely, so an optional
      // Date must be normalised to null, not left undefined, or the key
      // vanishes and the far side cannot tell "absent" from "never set".
      const dropped = throughStepBoundary({ a: undefined, b: null }) as Record<string, unknown>;
      expect('a' in dropped).toBe(false);
      expect('b' in dropped).toBe(true);
    });
  });
});
