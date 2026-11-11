/**
 * FIX-001 on the Workers shell: the real `redis.service` builds the real
 * `CfRedis`, payloads land in (fake) KV and the generation counters in the
 * AuthState Durable Object engine over node:sqlite — the same harness as
 * tests/unit/cf-redis.test.ts. KV has no in-process L1 here (FIX-002 was
 * already fixed by design on Workers), so the race is purely KV-vs-fill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStateStore, type Op } from '@api/cf/auth-state-core';
import { createSqlite } from '../helpers/sqlite-sql';

vi.mock('@api/lib/runtime', () => ({ isWorkers: true }));
vi.mock('@api/lib/db-retry', () => ({
  retryTransientRead: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));

class FakeAuthStateNamespace {
  readonly stores = new Map<string, AuthStateStore>();
  /** ms an `incr` (a generation bump) takes to land: a slow AuthState instance. */
  bumpDelayMs = 0;
  idFromName(name: string) {
    return name;
  }
  get(id: unknown) {
    const name = String(id);
    if (!this.stores.has(name)) this.stores.set(name, new AuthStateStore(createSqlite()));
    const store = this.stores.get(name)!;
    return {
      apply: async (ops: Op[]) => {
        if (this.bumpDelayMs && ops.some(op => op[0] === 'incr'))
          await new Promise(r => setTimeout(r, this.bumpDelayMs));
        return ops.map(op => store.run(op, Date.now()));
      },
    } as never;
  }
}

class FakeKv {
  readonly data = new Map<string, string>();
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.data.set(k, v);
  }
  async delete(k: string) {
    this.data.delete(k);
  }
  async list(o?: { prefix?: string }) {
    const keys = [...this.data.keys()]
      .filter(k => k.startsWith(o?.prefix ?? ''))
      .map(name => ({ name }));
    return { keys, list_complete: true };
  }
}

let ns: FakeAuthStateNamespace;
let kv: FakeKv;

/** A fresh isolate: new module graph over the SAME bindings (KV + DO). */
async function isolate() {
  vi.resetModules();
  const bindings = await import('@api/cf/bindings');
  bindings.setCfBindings({
    AUTH_STATE: ns,
    KV_CACHE: kv,
  } as unknown as Parameters<typeof bindings.setCfBindings>[0]);
  const { redis } = await import('@api/services/redis.service');
  await redis.connect();
  const raw = await import('@api/lib/public-cache');
  // API-HANG-1: on Workers a fill's write-back runs in waitUntil; collect it so each assertion sees the settled KV.
  const cache = {
    ...raw,
    getCached: ((...args: Parameters<typeof raw.getCached>) =>
      bindings.runWithWaitUntil(
        p => void background.push(p),
        () => raw.getCached(...args)
      )) as typeof raw.getCached,
  };
  return { redis, cache };
}

const background: Array<Promise<unknown>> = [];
const drain = async () => {
  while (background.length) await Promise.all(background.splice(0));
};

beforeEach(() => {
  ns = new FakeAuthStateNamespace();
  kv = new FakeKv();
});
afterEach(async () => {
  await drain();
  (await import('@api/cf/bindings')).clearCfBindings();
});

async function heldFill(cache: Awaited<ReturnType<typeof isolate>>['cache'], key: string) {
  let release!: (v: { price: number }) => void;
  let announce!: () => void;
  const started = new Promise<void>(r => (announce = r));
  const pending = cache.getCached(key, 120, async () => {
    announce();
    return new Promise<{ price: number }>(r => (release = r));
  });
  await started;
  return { release, pending };
}

describe('Workers (KV + AuthState DO): a pre-write fill cannot republish', () => {
  it('generation counters live on the Durable Object, never in KV', async () => {
    const { cache } = await isolate();
    await cache.invalidateStoreProductCaches('s1');
    expect([...kv.data.keys()].some(k => k.includes('cachegen'))).toBe(false);
    expect(ns.stores.size).toBeGreaterThan(0);
  });

  it('same isolate: the order-path invalidator beats a held fill', async () => {
    const { cache } = await isolate();
    const fill = await heldFill(cache, 'public:product:s1:sku-1');
    await cache.invalidateStoreProductCachesAfterOrder('s1');
    fill.release({ price: 100 });
    await fill.pending;
    await drain();
    expect(kv.data.has('cache:public:product:s1:sku-1')).toBe(false);
    const fresh = await cache.getCached('public:product:s1:sku-1', 120, async () => ({
      price: 200,
    }));
    expect(fresh.price).toBe(200);
  });

  it('another isolate invalidating mid-fill is seen through the DO generation', async () => {
    const a = await isolate();
    const fill = await heldFill(a.cache, 'public:products:s1:list');
    const b = await isolate();
    await b.cache.invalidateCachedPrefix('public:products:s1:');
    fill.release({ price: 100 });
    await fill.pending;
    await drain();
    expect(kv.data.has('cache:public:products:s1:list')).toBe(false);
  });

  it('an untouched key still fills KV (no false suppression)', async () => {
    const { cache } = await isolate();
    await cache.getCached('public:products:s2:list', 120, async () => ({ price: 7 }));
    await drain();
    expect(JSON.parse(kv.data.get('cache:public:products:s2:list') ?? 'null')).toEqual({
      price: 7,
    });
  });
  it('a SLOW generation bump (past the AuthState deadline) still lands before the delete: no stale re-publish', async () => {
    // API-HANG-1 review blocker: with the bump under the 2.5 s deadline, the invalidation timed out, deleted at once, and the
    // bump landed later; a fill holding the old generation then wrote its stale value back and kept it for the whole TTL.
    const { AUTH_STATE_TIMEOUT_MS } = await import('@api/cf/auth-state-client');
    ns.bumpDelayMs = AUTH_STATE_TIMEOUT_MS + 300;
    const { cache } = await isolate();
    const fill = await heldFill(cache, 'public:product:s9:sku-slow');
    await cache.invalidateCached('public:product:s9:sku-slow');
    fill.release({ price: 100 }); // read before the write
    await fill.pending;
    await drain();
    await new Promise(r => setTimeout(r, 400)); // let any late bump land
    await drain();
    expect(kv.data.has('cache:public:product:s9:sku-slow')).toBe(false);
  }, 15_000);
});
