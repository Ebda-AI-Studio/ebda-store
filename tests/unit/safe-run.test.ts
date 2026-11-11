import { describe, expect, it } from 'vitest';
import { isProtectedSlug } from '@ebda/shared';
import { safeRun } from '../helpers/safe-run';

describe('safeRun: a test slug suffix that never trips the protected brand list', () => {
  it('is 8 letters and never makes a protected slug, for every prefix the integration tests use', () => {
    const prefixes = ['ob-look-fam0-', 'ob-look-fail-', 'live-ob-', 'ob-', 'dom-a-'];
    for (let i = 0; i < 4000; i++) {
      const r = safeRun();
      expect(r).toMatch(/^[qxzkwj]{8}$/);
      for (const p of prefixes) expect(isProtectedSlug(p + r), p + r).toBe(false);
    }
  });
  it('the old hex suffix did collide (so the guard is real)', () => {
    expect(isProtectedSlug('ob-look-fam0-27c4b34e')).toBe(true);
  });
});
