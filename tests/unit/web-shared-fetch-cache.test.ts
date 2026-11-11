/**
 * Ruling WEB-COLD-2: the storefront's data cache survives a deploy while the DATA CONTRACT is unchanged. Before it,
 * OpenNext's R2 incremental cache stored every entry under the build id, so each deploy started with an empty data cache
 * and the first render of every store paid the whole API chain live (measured 3.7-10.3 s cold locally, 0.38 s with the
 * previous build's cache).
 *
 * Drives the REAL stock R2 cache code (get/set) through the override against an in-memory bucket, across build ids and
 * contract versions; and the REAL OpenNext fetch-cache adapter + REAL sharded Durable Object tag cache client to prove
 * a `revalidateTag` (merchant price/stock edit) still reaches an entry carried over from an older build.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
// The context is read per call, never at import time, so static imports are fine.
import { createSharedFetchCache, sharedFetchSegment } from '../../apps/web/shared-fetch-cache';
import doShardedTagCache from '@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache';
import { build } from 'esbuild'; // pinned through wrangler (root devDependency), the bundler OpenNext itself uses
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

/** In-memory stand-in for the sharded tag-cache Durable Object namespace: one tag table per DO name. */
const doTables = new Map<string, Map<string, number>>();
const tagNamespace = {
  idFromName: (name: string) => name,
  get: (id: string) => {
    if (!doTables.has(id)) doTables.set(id, new Map());
    const table = doTables.get(id)!;
    return {
      async writeTags(tags: Array<string | { tag: string }>, lastModified?: number) {
        const at = lastModified ?? Date.now();
        for (const t of tags) table.set(typeof t === 'string' ? t : t.tag, at);
      },
      async getTagData(tags: string[]) {
        return Object.fromEntries(
          tags
            .filter(t => table.has(t))
            .map(t => [t, { revalidatedAt: table.get(t)!, stale: null, expire: null }])
        );
      },
    };
  },
};

const env: Record<string, unknown> = {
  NEXT_INC_CACHE_R2_BUCKET: bucket,
  NEXT_TAG_CACHE_DO_SHARDED: tagNamespace,
};

// The context the Worker runtime installs per request (OpenNext's own global slot), so the real code paths run.
(globalThis as Record<symbol, unknown>)[Symbol.for('__cloudflare-context__')] = {
  env,
  cf: {},
  ctx: { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) },
};

const asBuild = (id: string) => {
  process.env.OPEN_NEXT_BUILD_ID = id;
};
const CONTRACT_A = '0123456789abcdef';
const CONTRACT_B = 'fedcba9876543210';

afterEach(() => {
  objects.clear();
  doTables.clear();
  delete env.NEXT_INC_CACHE_R2_PREFIX;
  delete process.env.OPEN_NEXT_BUILD_ID;
});

describe('shared fetch cache (WEB-COLD-2)', () => {
  const cache = createSharedFetchCache(CONTRACT_A);

  it('a fetch entry written by one build is read by the next build with the same contract', async () => {
    asBuild('build-A');
    await cache.set('fetch-key', { kind: 'FETCH', data: { body: 'store' } } as never, 'fetch');
    asBuild('build-B');
    const hit = await createSharedFetchCache(CONTRACT_A).get('fetch-key', 'fetch');
    expect(hit?.value).toEqual({ kind: 'FETCH', data: { body: 'store' } });
  });

  it('a CHANGED data contract starts a fresh namespace: the new build never reads old-shaped JSON', async () => {
    asBuild('build-A');
    await createSharedFetchCache(CONTRACT_A).set(
      'fetch-key',
      { kind: 'FETCH', v: 1 } as never,
      'fetch'
    );
    asBuild('build-B');
    const next = createSharedFetchCache(CONTRACT_B);
    expect(await next.get('fetch-key', 'fetch')).toBeNull();
    await next.set('fetch-key', { kind: 'FETCH', v: 2 } as never, 'fetch');
    expect((await next.get('fetch-key', 'fetch'))?.value).toEqual({ kind: 'FETCH', v: 2 });
    // and the two never overwrite each other
    expect(objects.size).toBe(2);
  });

  it('stores fetch entries under the contract segment, never under a build id', async () => {
    asBuild('build-A');
    await cache.set('fetch-key', { kind: 'FETCH' } as never, 'fetch');
    const [key] = [...objects.keys()];
    expect(key).toMatch(
      new RegExp(`^incremental-cache/${sharedFetchSegment(CONTRACT_A)}/[0-9a-f]{64}\\.fetch$`)
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
    expect(
      [...objects.keys()].every(k => k.startsWith(`pre/${sharedFetchSegment(CONTRACT_A)}/`))
    ).toBe(true);
    expect(objects.size).toBe(2);
    expect((await cache.get('store-2', 'fetch'))?.value).toEqual({ kind: 'FETCH', n: 2 });
  });

  it('refuses a malformed contract version at config time', () => {
    expect(() => createSharedFetchCache('')).toThrow(/invalid contract/);
    expect(() => createSharedFetchCache('../x')).toThrow(/invalid contract/);
  });
});

describe('a tag purge reaches an entry carried over from an older build (BOUNDED-stale, WEB-COLD-2)', () => {
  const g = globalThis as Record<string, unknown>;
  // The REAL OpenNext fetch-cache adapter. @opennextjs/aws ships ESM with extensionless relative imports (it expects a
  // bundler, as OpenNext bundles it into the Worker), so bundle it once here exactly like that and import the result.
  let Cache: new () => { get(key: string, options: unknown): Promise<unknown> };
  beforeAll(async () => {
    const out = await build({
      entryPoints: [require.resolve('@opennextjs/aws/adapters/cache.js')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      logLevel: 'silent',
    });
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'opennext-cache-')), 'cache.mjs');
    writeFileSync(file, out.outputFiles[0].text);
    Cache = (await import(pathToFileURL(file).href)).default;
    g.openNextConfig = {};
    g.nextVersion = '16.0.0';
    g.incrementalCache = createSharedFetchCache(CONTRACT_A);
    g.tagCache = doShardedTagCache({ baseShardSize: 12, regionalCache: false });
  });

  const TAGS = ['products:store-1'];
  const read = () =>
    new Cache().get('price-list', { kind: 'FETCH', tags: TAGS, softTags: [] } as never);

  it('build A writes the price list, a price edit purges products:<store> under build A, build B misses', async () => {
    asBuild('build-A');
    await (g.incrementalCache as ReturnType<typeof createSharedFetchCache>).set(
      'price-list',
      { kind: 'FETCH', data: { body: '{"price":100}' }, revalidate: 60, tags: TAGS } as never,
      'fetch'
    );
    asBuild('build-B');
    expect(await read()).not.toBeNull(); // carried over, not yet purged
    await new Promise(r => setTimeout(r, 5));
    asBuild('build-A'); // the purge lands on the OLD build (deploy happens right after the merchant edit)
    await (g.tagCache as { writeTags(t: string[]): Promise<void> }).writeTags(TAGS);
    asBuild('build-B');
    expect(await read()).toBeNull(); // the new build refetches: the purge reached the carried-over key
  });

  it('a purge recorded by the NEW build also invalidates the carried-over entry', async () => {
    asBuild('build-A');
    await (g.incrementalCache as ReturnType<typeof createSharedFetchCache>).set(
      'price-list',
      { kind: 'FETCH', data: { body: '{"stock":3}' }, revalidate: 60, tags: TAGS } as never,
      'fetch'
    );
    await new Promise(r => setTimeout(r, 5));
    asBuild('build-B');
    await (g.tagCache as { writeTags(t: string[]): Promise<void> }).writeTags(TAGS);
    expect(await read()).toBeNull();
  });
});
