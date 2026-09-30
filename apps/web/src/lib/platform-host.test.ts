import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPlatformFromHeader } from './platform-host';

/**
 * #2091 — `x-is-platform` is a tri-state. middleware.ts asserts 'true' on a
 * platform host and 'false' on a custom domain; ABSENT means middleware never
 * ran for this render, and only then may StoreProvider run its client-side
 * `isPlatformHost()` fallback. `=== 'true'` collapsed absent into `false` and
 * made that fallback unreachable from the only production caller.
 */
describe('isPlatformFromHeader', () => {
  it('absent header → undefined, so StoreProvider falls back to host detection', () => {
    expect(isPlatformFromHeader(null)).toBeUndefined();
  });

  it("'true' → true, 'false' → false", () => {
    expect(isPlatformFromHeader('true')).toBe(true);
    expect(isPlatformFromHeader('false')).toBe(false);
  });

  it('layout.tsx seeds StoreProvider through the tri-state helper, not `=== "true"`', () => {
    const src = readFileSync(join(__dirname, '../app/layout.tsx'), 'utf8');
    expect(src).toMatch(
      /initialIsPlatform = isPlatformFromHeader\(headersList\.get\('x-is-platform'\)\)/
    );
    expect(src).not.toMatch(/get\('x-is-platform'\) === 'true'/);
  });
});
