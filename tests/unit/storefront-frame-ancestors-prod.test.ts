/**
 * S1-1 (2026-09-22 security audit): the production `frame-ancestors` default
 * (used whenever `STOREFRONT_FRAME_ANCESTORS` is unset — verified true in
 * every prod config: no wrangler.toml / .env.production.example entry sets
 * it) included `http://localhost:3001 http://localhost:3000`. Not remotely
 * exploitable on its own, but dev scope has no business in a production CSP
 * header, and it must not silently reappear.
 *
 * Calls the real policy builder (`apps/web/src/lib/csp.ts`, run per request by
 * middleware.ts) rather than grepping the source text, so this is provably
 * testing the emitted header, not a comment near it.
 */
import { describe, it, expect } from 'vitest';

import { buildStorefrontCsp } from '../../apps/web/src/lib/csp';

async function frameAncestors(env: Record<string, string | undefined>): Promise<string> {
  const prevEnv = { ...process.env };
  Object.assign(process.env, env);
  // Explicitly delete keys the caller wants unset — `Object.assign` cannot
  // remove a property, only overwrite it, and process.env values coerce
  // `undefined` to the STRING "undefined" rather than deleting the key.
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
  }
  try {
    const csp = buildStorefrontCsp('AAAAAAAAAAAAAAAAAAAAAA==');
    return (csp.match(/frame-ancestors[^;]*/) ?? [''])[0];
  } finally {
    // Restore exactly what was there before (including deletions).
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    Object.assign(process.env, prevEnv);
  }
}

describe('S1-1: production frame-ancestors default excludes localhost', () => {
  it('the PRODUCTION default (no STOREFRONT_FRAME_ANCESTORS set) has no localhost origin', async () => {
    const fa = await frameAncestors({
      NODE_ENV: 'production',
      STOREFRONT_FRAME_ANCESTORS: undefined,
    });
    expect(fa).not.toContain('localhost');
  });

  it('the production default still contains the two real admin origins (unchanged prod behaviour)', async () => {
    const fa = await frameAncestors({
      NODE_ENV: 'production',
      STOREFRONT_FRAME_ANCESTORS: undefined,
    });
    expect(fa).toContain('https://store.ebda.app');
    expect(fa).toContain('https://store.ebda.app');
  });

  it('a non-production build keeps the localhost origins (dev must still work over http)', async () => {
    const fa = await frameAncestors({
      NODE_ENV: 'development',
      STOREFRONT_FRAME_ANCESTORS: undefined,
    });
    expect(fa).toContain('http://localhost:3001');
    expect(fa).toContain('http://localhost:3000');
  });

  it('an explicit STOREFRONT_FRAME_ANCESTORS always wins, in any NODE_ENV', async () => {
    const fa = await frameAncestors({
      NODE_ENV: 'production',
      STOREFRONT_FRAME_ANCESTORS: 'https://custom.example.com',
    });
    expect(fa).toContain('https://custom.example.com');
    expect(fa).not.toContain('store.ebda.app');
  });
});
