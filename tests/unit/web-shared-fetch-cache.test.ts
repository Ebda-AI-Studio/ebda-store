/**
 * Ruling WEB-COLD-2: the storefront's data cache survives a deploy. Before it, OpenNext's R2 incremental cache stored
 * every entry under the build id, so each deploy started with an empty data cache and the first render of every store
 * paid the whole API chain live (measured 7.6-10.3 s cold locally with an empty cache, 0.47 s with a filled one).
 *
 * Drives the REAL stock R2 cache code (get/set) through the override against an in-memory bucket, across two build ids:
 * a `fetch` entry written by build A is read by build B; a page (`cache`) entry is not, because its HTML names build A's
 * `/_next/static` files.
 */
import { afterEach, describe, expect, it } from 'vitest';
// The context is read per call, never at import time, so a static import is fine.
import cache, { SHARED_FETCH_SEGMENT } from '../../apps/web/shared-fetch-cache';

const objects = new Map<string, { body: string; uploaded: Date }>();
const bucket = {
  async get(key: string) {
    const o = objects.get(key);
    return o ? { json: async () => JSON.parse(o.body), uploaded: o.uploaded } : null;
  },
  async put(key: string, body: string) {
    objects.set(key, { body, uploaded: new Date() });
  },
  async delete(key: string) {
    objects.delete(key);
  },
};
const env: Record<string, unknown> = { NEXT_INC_CACHE_R2_BUCKET: bucket };

// The context the Worker runtime installs per request (OpenNext's own global slot), so the real code paths run.
(globalThis as Record<symbol, unknown>)[Symbol.for('__cloudflare-context__')] = {
  env,
  cf: {},
  ctx: {},
};

const asBuild = (id: string) => {
  process.env.OPEN_NEXT_BUILD_ID = id;
};

afterEach(() => {
  objects.clear();
  delete env.NEXT_INC_CACHE_R2_PREFIX;
  delete process.env.OPEN_NEXT_BUILD_ID;
});

describe('shared fetch cache (WEB-COLD-2)', () => {
  it('a fetch entry written by one build is read by the next build', async () => {
    asBuild('build-A');
    await cache.set('fetch-key', { kind: 'FETCH', data: { body: 'store' } } as never, 'fetch');
    asBuild('build-B');
    const hit = await cache.get('fetch-key', 'fetch');
    expect(hit?.value).toEqual({ kind: 'FETCH', data: { body: 'store' } });
  });

  it('stores fetch entries under the shared segment, never under a build id', async () => {
    asBuild('build-A');
    await cache.set('fetch-key', { kind: 'FETCH' } as never, 'fetch');
    const [key] = [...objects.keys()];
    expect(key).toMatch(
      new RegExp(`^incremental-cache/${SHARED_FETCH_SEGMENT}/[0-9a-f]{64}\\.fetch$`)
    );
    expect(key).not.toContain('build-A');
  });

  it('page entries stay build-scoped: build B never reads build A HTML', async () => {
    asBuild('build-A');
    await cache.set('/ar', { type: 'app', html: '<html>' } as never, 'cache');
    expect([...objects.keys()][0]).toMatch(/^incremental-cache\/build-A\//);
    asBuild('build-B');
    expect(await cache.get('/ar', 'cache')).toBeNull();
    asBuild('build-A');
    expect(await cache.get('/ar', 'cache')).not.toBeNull();
  });

  it('keeps the configured R2 prefix and a per-key hash (tenants never share an entry)', async () => {
    env.NEXT_INC_CACHE_R2_PREFIX = 'pre';
    await cache.set('store-1', { kind: 'FETCH', n: 1 } as never, 'fetch');
    await cache.set('store-2', { kind: 'FETCH', n: 2 } as never, 'fetch');
    expect([...objects.keys()].every(k => k.startsWith(`pre/${SHARED_FETCH_SEGMENT}/`))).toBe(true);
    expect(objects.size).toBe(2);
    expect((await cache.get('store-2', 'fetch'))?.value).toEqual({ kind: 'FETCH', n: 2 });
  });
});
