import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Ruling MKT-SIGNUP-1: ebda.app/signup (both locales, with and without the slash) sends people to the store app. */
const rules = readFileSync('apps/marketing/public/_redirects', 'utf8')
  .split('\n')
  .filter(l => l.trim() && !l.startsWith('#'))
  .map(l => l.trim().split(/\s+/));

describe('marketing signup redirects', () => {
  it.each(['/signup', '/signup/', '/en/signup', '/en/signup/'])(
    '%s -> store.ebda.app/signup',
    from => {
      const r = rules.find(x => x[0] === from);
      expect(r?.[1]).toBe('https://store.ebda.app/signup');
      expect(['301', '302']).toContain(r?.[2]);
    }
  );
});
