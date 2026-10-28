/**
 * #1194: package.json's overrides force qs to 6.16.2 (a GHSA-x5fp-wj9c-mxmx
 * fix) into express@4.22.2 and body-parser@1.20.8, which still declare
 * `qs: ~6.15.1` — a range that EXCLUDES 6.16.2. npm honours the override
 * anyway (nothing fails at install time), but the advisory itself changes
 * how qs parses bracket-key comma input for array-limit enforcement — a
 * parsing-semantics change on the hot path every request.query and every
 * `extended: true` urlencoded body goes through
 * (apps/api/src/index.ts:362, plus Express's default 'extended' query
 * parser).
 *
 * This exercises the ACTUAL installed qs resolution (not a mock) against
 * the exact query shapes this codebase relies on
 * (apps/api/src/routes/public.routes.ts's opt_<Name>=A,B,C facet filters,
 * and a comma-separated `ids` list), so a future qs bump that changes this
 * parsing turns red here instead of silently breaking PLP facet filtering
 * in production.
 */
import { describe, it, expect } from 'vitest';
// The real resolved qs — same one express/body-parser get via the override.
import qs from 'qs';

describe('#1194: forced qs 6.16.2 parses the shapes this API relies on', () => {
  it('is actually resolved to 6.16.2 (guards against the override silently lapsing)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('qs/package.json') as { version: string };
    expect(pkg.version).toBe('6.16.2');
  });

  it('a comma-separated single query value stays a STRING, not an array', () => {
    // public.routes.ts's option-filter loop explicitly requires
    // `typeof raw === 'string'` and does its OWN comma-splitting — if qs
    // ever started treating a bare comma as an array delimiter, every
    // `opt_Color=Red,Blue` facet filter would silently stop matching
    // (typeof raw !== 'string' => the option is skipped entirely).
    const parsed = qs.parse('opt_Color=Red,Blue&opt_Size=Large,XL');
    expect(parsed.opt_Color).toBe('Red,Blue');
    expect(parsed.opt_Size).toBe('Large,XL');
  });

  it('bracket-array query syntax still parses to a real array', () => {
    // Not used by this route today, but is the exact shape the GHSA
    // advisory's array-limit enforcement change targets — assert it still
    // behaves like an ordinary array for a small, legitimate input.
    const parsed = qs.parse('tag[]=a&tag[]=b&tag[]=c');
    expect(parsed.tag).toEqual(['a', 'b', 'c']);
  });

  it('an extended urlencoded body (nested object) round-trips', () => {
    // The shape express.urlencoded({ extended: true }) hands qs.parse for
    // every form-encoded POST body in this API.
    const parsed = qs.parse('user[name]=Ahmad&user[email]=a@b.com');
    expect(parsed.user).toEqual({ name: 'Ahmad', email: 'a@b.com' });
  });

  it('a comma-separated ids list still parses as a single string to split manually', () => {
    // GET /products?ids=<uuid>,<uuid> — public.routes.ts splits this itself.
    const parsed = qs.parse(
      'ids=11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222'
    );
    expect(typeof parsed.ids).toBe('string');
    expect((parsed.ids as string).split(',')).toHaveLength(2);
  });
});
