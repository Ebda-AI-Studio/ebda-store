/**
 * Guards tests/helpers/api-base.ts — the integration suite's API base knob.
 *
 * These assertions exist because the previous shape of that logic shipped two
 * defects that no test could catch: it read the SERVER's `API_URL` (an origin,
 * `http://localhost:4000`) as if it were the versioned base, and it fed that
 * value to `new URL(...)` unguarded. Both are pinned here.
 */

import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';

describe('normalizeApiOrigin', () => {
  // Imported dynamically, NOT with a static top-of-file import: a static import
  // evaluates api-base once, before any hook runs, and that cached instance
  // would then satisfy the `import()` in the second describe — whose whole
  // point is to observe module evaluation THROWING under a hostile env.
  let normalizeApiOrigin: typeof import('../helpers/api-base').normalizeApiOrigin;
  beforeAll(async () => {
    ({ normalizeApiOrigin } = await import('../helpers/api-base'));
  });

  it('accepts a bare origin unchanged', () => {
    expect(normalizeApiOrigin('http://localhost:4000')).toBe('http://localhost:4000');
  });

  it('strips an already-attached /api/v1 so the base never doubles it', () => {
    expect(normalizeApiOrigin('http://localhost:4000/api/v1')).toBe('http://localhost:4000');
  });

  it('tolerates trailing slashes in either form', () => {
    expect(normalizeApiOrigin('http://localhost:4000/')).toBe('http://localhost:4000');
    expect(normalizeApiOrigin('http://localhost:4000/api/v1/')).toBe('http://localhost:4000');
  });

  it('preserves a path prefix ahead of the version segment', () => {
    expect(normalizeApiOrigin('https://example.com/svc/api/v1')).toBe('https://example.com/svc');
  });

  it('rejects a bare host that URL() refuses to parse', () => {
    expect(() => normalizeApiOrigin('api.force-ai.co', 'TEST_API_URL')).toThrow(
      /not a valid absolute URL/
    );
  });

  it('rejects "localhost:4000", which parses as an opaque scheme whose origin is "null"', () => {
    // The regression that motivates the protocol check: this does NOT throw in
    // `new URL()`, and its `.origin` is the truthy STRING "null", so without
    // this guard it would flow into every fetch and fail cryptically.
    expect(new URL('localhost:4000').origin).toBe('null');
    expect(() => normalizeApiOrigin('localhost:4000', 'TEST_API_URL')).toThrow(
      /no http\(s\) scheme/
    );
  });

  it('names the offending variable in the error so the fix is obvious', () => {
    expect(() => normalizeApiOrigin('nope', 'TEST_API_BASE')).toThrow(/TEST_API_BASE="nope"/);
  });
});

describe('api-base safety claims are enforced, not just documented', () => {
  const ENV = { ...process.env };
  // BEFORE each too, not only after: the first test in this block would
  // otherwise re-use whatever instance an earlier test file/describe left in
  // the registry and never re-evaluate the guard.
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...ENV };
    vi.resetModules();
  });

  // The docstring promises the suite "must never be steerable by a variable
  // whose production value is a real, reachable API". Before this, only the
  // variable NAME enforced that — exporting TEST_API_URL by hand walked past it.
  it('refuses a non-local host', async () => {
    process.env.TEST_API_URL = 'https://api.force-ai.co';
    await expect(import('../helpers/api-base')).rejects.toThrow(/non-local host/i);
  });

  it('allows a non-local host only with an explicit opt-in', async () => {
    process.env.TEST_API_URL = 'https://api.force-ai.co';
    process.env.TEST_API_ALLOW_REMOTE = '1';
    const m = await import('../helpers/api-base');
    expect(m.API_BASE).toBe('https://api.force-ai.co/api/v1');
  });

  it.each(['http://localhost:4000', 'http://127.0.0.1:4000', 'http://192.168.1.9:4000'])(
    'allows the local address %s',
    async url => {
      process.env.TEST_API_URL = url;
      const m = await import('../helpers/api-base');
      expect(m.API_ORIGIN).toBe(url);
    }
  );

  // The docstring's claim is absolute; a single suffix strip made it true for
  // one level only.
  it('collapses a repeated version prefix, not just one', async () => {
    process.env.TEST_API_URL = 'http://localhost:4000/api/v1/api/v1';
    const m = await import('../helpers/api-base');
    expect(m.API_BASE).toBe('http://localhost:4000/api/v1');
  });
});
