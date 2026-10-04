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
    expect(() => normalizeApiOrigin('api.ebda.app', 'TEST_API_URL')).toThrow(
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
    process.env.TEST_API_URL = 'https://api.ebda.app';
    await expect(import('../helpers/api-base')).rejects.toThrow(/non-local host/i);
  });

  it('allows a non-local host only with an explicit opt-in', async () => {
    process.env.TEST_API_URL = 'https://api.ebda.app';
    process.env.TEST_API_ALLOW_REMOTE = '1';
    const m = await import('../helpers/api-base');
    expect(m.API_BASE).toBe('https://api.ebda.app/api/v1');
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

describe('resolveRaw precedence (#1637)', () => {
  // Same reasoning as the block above: dynamic import + resetModules, because
  // the module resolves its base ONCE at load time from process.env.
  const ENV = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    delete process.env.TEST_API_URL;
    delete process.env.TEST_API_BASE;
    delete process.env.API_URL;
    delete process.env.API_HOST;
  });
  afterEach(() => {
    process.env = { ...ENV };
    vi.resetModules();
  });

  it('defaults to localhost:4000 when nothing is set', async () => {
    const m = await import('../helpers/api-base');
    expect(m.API_ORIGIN).toBe('http://localhost:4000');
    expect(m.API_BASE).toBe('http://localhost:4000/api/v1');
  });

  it('TEST_API_URL wins when both TEST_API_URL and TEST_API_BASE are set', async () => {
    process.env.TEST_API_URL = 'http://localhost:5000';
    process.env.TEST_API_BASE = 'http://localhost:6000';
    const m = await import('../helpers/api-base');
    expect(m.API_ORIGIN).toBe('http://localhost:5000');
  });

  it('TEST_API_BASE is honoured alone, as the older alias', async () => {
    process.env.TEST_API_BASE = 'http://localhost:6000';
    const m = await import('../helpers/api-base');
    expect(m.API_ORIGIN).toBe('http://localhost:6000');
  });

  // The regression this file exists to prevent: the SERVER's own env vars
  // (deployed values include `API_URL=https://api.ebda.app`) must never be
  // read as the suite's base, or a local `npm run test:integration` on a
  // machine holding production values would POST /auth/register at prod.
  it('never consults API_URL/API_HOST — a deployed value stays inert', async () => {
    process.env.API_URL = 'https://api.ebda.app';
    process.env.API_HOST = 'localhost';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = await import('../helpers/api-base');
    expect(m.API_ORIGIN).toBe('http://localhost:4000');
    warn.mockRestore();
  });
});
