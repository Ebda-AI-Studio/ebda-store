import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import doShardedTagCache from '@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache';
import { TAG_CACHE_OPTIONS, REGIONAL_TTL_SEC } from './tag-cache-options';

// Drives the REAL @opennextjs/cloudflare DO-sharded tag cache against fake DO namespaces + fake per-colo Cache API,
// counting Durable Object calls. Proves (1) DO calls per render drop, (2) a product price write still invalidates.

type TagData = { revalidatedAt: number; stale: number | null; expire: number | null };
const CTX = Symbol.for('__cloudflare-context__');

function makeDO() {
  const calls = { get: 0, write: 0 };
  const stores = new Map<string, Map<string, TagData>>();
  const ns = {
    idFromName: (n: string) => n,
    get: (name: string) => {
      const s = stores.get(name) ?? new Map<string, TagData>();
      stores.set(name, s);
      return {
        getTagData: async (tags: string[]) => {
          calls.get++;
          return Object.fromEntries(tags.filter(t => s.has(t)).map(t => [t, s.get(t)!]));
        },
        writeTags: async (tags: { tag: string; stale: number; expire?: number }[]) => {
          calls.write++;
          for (const t of tags)
            s.set(t.tag, { revalidatedAt: Date.now(), stale: t.stale, expire: t.expire ?? null });
        },
      };
    },
  };
  return { ns, calls };
}

function makeColoCache() {
  const m = new Map<string, { body: string; exp: number }>();
  return {
    open: async () => ({
      match: async (k: string) => {
        const e = m.get(k);
        if (!e || e.exp <= Date.now()) return undefined;
        return new Response(e.body);
      },
      put: async (k: string, r: Response) => {
        const ttl = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') ?? '')?.[1] ?? 0);
        m.set(k, { body: await r.text(), exp: Date.now() + ttl * 1000 });
      },
      delete: async (k: string) => m.delete(k),
    }),
  };
}

// A render's tag set: fetch tags + Next soft tags (never revalidated until a merchant writes).
const PAGE_TAGS = [
  'products:s1',
  'layout:s1',
  'categories:s1',
  '_N_T_/layout',
  '_N_T_/products/[slug]/page',
  '_N_T_/products/p1',
];

let doState: ReturnType<typeof makeDO>;
function colo(env = doState.ns) {
  (globalThis as Record<symbol, unknown>)[CTX] = {
    env: { NEXT_TAG_CACHE_DO_SHARDED: env },
    ctx: { waitUntil: (p: Promise<unknown>) => void p },
    cf: {},
  };
  (globalThis as { caches?: unknown }).caches = makeColoCache();
  (globalThis as { openNextConfig?: unknown }).openNextConfig = {};
  return doShardedTagCache(opts as never) as unknown as {
    hasBeenRevalidated: (t: string[], lm?: number) => Promise<boolean>;
    writeTags: (t: string[]) => Promise<void>;
  };
}
let opts: Record<string, unknown> = TAG_CACHE_OPTIONS;

async function render(tc: ReturnType<typeof colo>, lastModified: number) {
  // one render = one request scope; flush waitUntil'd regional puts
  await tc.hasBeenRevalidated(PAGE_TAGS, lastModified);
  await new Promise(r => setTimeout(r, 0));
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
  doState = makeDO();
  opts = TAG_CACHE_OPTIONS;
});
afterEach(() => vi.useRealTimers());

describe('storefront tag cache: DO calls per render', () => {
  it('BEFORE (old config) vs AFTER, 20 renders inside one TTL window', async () => {
    // the Cache API instance is per colo: keep ONE across the 20 renders
    const run = async (o: Record<string, unknown>) => {
      doState = makeDO();
      opts = o;
      const cache = makeColoCache();
      const lm = Date.now();
      for (let i = 0; i < 20; i++) {
        const t = colo();
        (globalThis as { caches?: unknown }).caches = cache;
        await render(t, lm);
      }
      return doState.calls.get;
    };
    const before = await run({ baseShardSize: 12, regionalCache: true });
    const after = await run(TAG_CACHE_OPTIONS);
    console.log(
      `DO getTagData calls over 20 renders: before=${before} after=${after}; per render ${before / 20} -> ${after / 20}`
    );
    expect(before).toBeGreaterThanOrEqual(20 * 2);
    expect(after).toBeLessThanOrEqual(before / 10);
  });
});

describe('storefront tag cache: a product price change still invalidates', () => {
  it('same colo: next render after revalidateTag(products:s1) sees the page as revalidated (listing + product page share the tag)', async () => {
    const tc = colo();
    const generatedAt = Date.now();
    await render(tc, generatedAt); // warm: sentinel cached
    expect(await tc.hasBeenRevalidated(PAGE_TAGS, generatedAt)).toBe(false);
    vi.setSystemTime(Date.now() + 1000);
    await tc.writeTags(['products:s1']); // what POST /api/revalidate does on a price write
    expect(await tc.hasBeenRevalidated(['products:s1'], generatedAt)).toBe(true); // product page
    expect(await tc.hasBeenRevalidated(['products:s1', 'categories:s1'], generatedAt)).toBe(true); // listing
    expect(await tc.hasBeenRevalidated(['layout:s1'], generatedAt)).toBe(false); // unrelated tag untouched
  });

  it('other colo: sees the write within the documented residual window (<= REGIONAL_TTL_SEC) and not later', async () => {
    const writer = colo();
    const generatedAt = Date.now();
    const cacheB = makeColoCache();
    const reader = colo();
    (globalThis as { caches?: unknown }).caches = cacheB;
    await render(reader, generatedAt); // colo B caches the "never revalidated" sentinel
    vi.setSystemTime(Date.now() + 1000);
    colo();
    (globalThis as { caches?: unknown }).caches = makeColoCache(); // writer colo A
    await writer.writeTags(['products:s1']);
    (globalThis as { caches?: unknown }).caches = cacheB;
    vi.setSystemTime(Date.now() + (REGIONAL_TTL_SEC + 1) * 1000);
    expect(await reader.hasBeenRevalidated(['products:s1'], generatedAt)).toBe(true);
  });

  it('guard: the residual window is not silently widened', () => {
    expect(TAG_CACHE_OPTIONS.regionalCacheTtlSec).toBe(5);
    expect(REGIONAL_TTL_SEC).toBeLessThanOrEqual(5);
    expect(TAG_CACHE_OPTIONS.regionalCacheDangerouslyPersistMissingTags).toBe(true);
  });
});
