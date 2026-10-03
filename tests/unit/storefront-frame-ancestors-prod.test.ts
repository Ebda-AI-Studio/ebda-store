/**
 * S1-1 (2026-09-22 security audit): the production `frame-ancestors` default
 * (used whenever `STOREFRONT_FRAME_ANCESTORS` is unset — verified true in
 * every prod config: no wrangler.toml / .env.production.example entry sets
 * it) included `http://localhost:3001 http://localhost:3000`. Not remotely
 * exploitable on its own, but dev scope has no business in a production CSP
 * header, and it must not silently reappear.
 *
 * Evaluates the actual `headers()` function from `apps/web/next.config.js`
 * (same technique as `admin-page-builder-preview-csp.test.ts`) rather than
 * grepping the source text, so this is provably testing the emitted header,
 * not a comment near it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/next.config.js'), 'utf-8');

/** Extract and evaluate the `headers()` method as a standalone async function. */
function makeHeadersFn(): () => Promise<
  { source: string; headers: { key: string; value: string }[] }[]
> {
  const marker = 'async headers() {';
  const start = CONFIG.indexOf(marker);
  expect(start, 'could not find `async headers() {` in apps/web/next.config.js').toBeGreaterThan(
    -1
  );
  const bodyStart = start + marker.length;
  // The nextConfig object's own closing brace is the only line-anchored `};`
  // in the file — everything after it (module.exports = withSentryConfig(...))
  // is a separate statement.
  const objectEnd = CONFIG.indexOf('\n};', bodyStart);
  expect(objectEnd, 'could not find the end of the headers() method').toBeGreaterThan(bodyStart);
  // Walk back to the method's own closing `\n  },` (one indent level), not
  // the enclosing object's `\n};`.
  const methodEnd = CONFIG.lastIndexOf('\n  },', objectEnd);
  const body = CONFIG.slice(bodyStart, methodEnd);
  // eslint-disable-next-line no-new-func
  return new Function(`return (async function headers() {${body}})`)() as () => Promise<
    { source: string; headers: { key: string; value: string }[] }[]
  >;
}

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
    const headersFn = makeHeadersFn();
    const rules = await headersFn();
    const csp = rules[0].headers.find(h => h.key === 'Content-Security-Policy')!.value;
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
    expect(fa).toContain('https://app.ebda.app');
    expect(fa).toContain('https://app.ebda.app');
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
    expect(fa).not.toContain('app.ebda.app');
  });
});
