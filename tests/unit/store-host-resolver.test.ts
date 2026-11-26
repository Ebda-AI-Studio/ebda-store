/**
 * SP4 / Review Focus 1 — host routing on the API's PUBLIC store paths.
 *
 *   `<slug>.ebda.app`  → resolved by SLUG
 *   anything else      → resolved by custom DOMAIN
 *   reserved / platform / IP / localhost / malformed / unknown → 404, never a
 *   default or "first" store, and a miss is never cached.
 *
 * Runs the REAL router (`public.routes.ts`), the REAL `getCached` (Redis stubbed
 * with an in-memory map so entries really are cached), the REAL
 * `getStoreIdFromRequest`, and a fake `prisma.store` that evaluates the same
 * `where` clauses Postgres would. What is asserted is therefore the observable
 * isolation contract: store A and store B at the SAME path each get their own
 * data — including after A's response was cached — and an unknown host asked
 * right after a known one is a 404 (no stale store).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Fake world ────────────────────────────────────────────────────────────

interface StoreRow {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  domainStatus: 'pending' | 'active' | 'failed' | null;
  status: 'active' | 'suspended' | 'inactive';
  deletedAt: Date | null;
}

const STORE_A: StoreRow = {
  id: 'store-a',
  slug: 'amelia',
  name: 'Amelia Aurum',
  domain: 'ameliaaurum.com',
  domainStatus: 'active',
  status: 'active',
  deletedAt: null,
};
const STORE_B: StoreRow = {
  id: 'store-b',
  slug: 'demo-boutique',
  name: 'Demo Boutique',
  domain: null,
  domainStatus: null,
  status: 'active',
  deletedAt: null,
};

const world = vi.hoisted(() => ({ stores: [] as unknown[] }));
const storeFindFirst = vi.hoisted(() => vi.fn());
const listPublic = vi.hoisted(() => vi.fn());
const redisData = vi.hoisted(() => new Map<string, string>());

function matchesWhere(row: StoreRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'status') {
      const allowed = (v as { in?: string[] } | string).hasOwnProperty('in')
        ? (v as { in: string[] }).in
        : [v as string];
      if (!allowed.includes(row.status)) return false;
    } else if (k === 'deletedAt') {
      if (v === null && row.deletedAt !== null) return false;
    } else if ((row as unknown as Record<string, unknown>)[k] !== v) {
      return false;
    }
  }
  return true;
}

// The row the route reads once the store is known: `stores` is under RLS, so it is read inside
// `withStore(id)` by exact id (never found by host/slug from an unscoped client).
const storeRowById = (id: string) => {
  const hit = (world.stores as StoreRow[]).find(s => s.id === id);
  // Return the full row shape the route selects (extra keys are harmless).
  return hit ? { ...hit, theme: {}, settings: {}, marketingPixels: null } : null;
};

vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: {
        findUnique: async ({ where }: { where: { id: string } }) => storeRowById(where.id),
      },
    }),
  prisma: {
    // `storeDb(id).store` on the Postgres path is the request `prisma` proxy (NEON-ZERO-1: the route reads the row through it)
    store: {
      findUnique: async ({ where }: { where: { id: string } }) => storeRowById(where.id),
    },
    // The faqs + howtos + disabled-pages triple is one raw round trip (fetchStoreExtras).
    $queryRaw: vi.fn().mockResolvedValue([{ faqs: [], howtos: [], disabled: [] }]),
    storePage: { findMany: vi.fn().mockResolvedValue([]) },
    storeFaq: { findMany: vi.fn().mockResolvedValue([]) },
    storeHowto: { findMany: vi.fn().mockResolvedValue([]) },
    storeLocation: { findMany: vi.fn().mockResolvedValue([]) },
  },
  SlugEntityType: {},
}));

// Host / slug -> store is the `ebda_store_lookup` / `ebda_resolve_store_id` definers;
// `storeFindFirst` stays the source of truth for "which store does this host or slug name".
vi.mock('@api/lib/definer', () => ({
  lookupStore: async (
    match: { id?: string | null; slug?: string | null; domain?: string | null },
    statuses: string[] = ['active']
  ) => {
    const key = match.id
      ? { id: match.id }
      : match.domain
        ? { domain: match.domain }
        : { slug: match.slug };
    const hit = (await storeFindFirst({
      where: { ...key, status: { in: statuses }, deletedAt: null },
    })) as { id: string; status: string } | null;
    return hit ? { id: hit.id, status: hit.status } : null;
  },
  resolveStoreId: async (match: { slug?: string | null; domain?: string | null }) => {
    const where: Record<string, unknown> = match.domain
      ? { domain: match.domain, status: { in: ['active', 'suspended'] }, deletedAt: null }
      : { slug: match.slug, status: { in: ['active', 'suspended'] }, deletedAt: null };
    return ((await storeFindFirst({ where })) as { id: string } | null)?.id ?? null;
  },
}));

vi.mock('@api/services/redis.service', () => ({
  redis: {
    get: async (key: string) => redisData.get(key) ?? null,
    set: async (key: string, value: string) => void redisData.set(key, value),
    delete: async (key: string) => void redisData.delete(key),
    deleteByPattern: async () => undefined,
    // FIX-001/002: healthy Redis with generations that never move.
    isAvailable: () => true,
    getCacheGenerations: async (names: string[]) => names.map(() => null),
    bumpCacheGeneration: async () => undefined,
  },
}));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: (_id: string, fn: () => unknown) => fn(),
  inDoStoreScope: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/order-tax', () => ({
  resolveActiveTaxRate: vi.fn().mockResolvedValue({ ratePercent: 0, seller: null }),
  effectiveTaxFields: (t: { ratePercent: number }) => ({
    taxRatePercent: t.ratePercent,
    taxEnabled: t.ratePercent > 0,
  }),
}));
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { isSmsMarketingAvailable: vi.fn().mockResolvedValue(false) },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: {
    getEnabledFeatureKeys: vi.fn().mockResolvedValue([]),
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock('@api/services/product.service', () => ({
  ProductService: { listPublic: (...a: unknown[]) => listPublic(...a) },
}));
vi.mock('@api/config', () => ({
  config: { webUrl: 'https://ebda.app', apiUrl: 'https://api.ebda.app' },
}));
vi.mock('@api/lib/edge-cache', () => ({ setEdgeCache: vi.fn() }));
vi.mock('@api/lib/db-retry', () => ({
  retryTransientRead: (fn: () => unknown) => fn(),
}));
vi.mock('@api/middleware/security', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    publicLimiter: pass,
    publicTenantLimiter: pass,
    storeResolveLimiter: pass,
    storeMissLimiter: pass,
    publicSearchLimiter: pass,
    whenSearching: () => pass,
    cartLimiter: pass,
    couponAttemptLimiter: pass,
    guestReturnIpLimiter: pass,
    guestReturnOrderLimiter: pass,
    writeLimiter: pass,
    newsletterLimiter: pass,
    viewIngestLimiter: pass,
    auditLog: vi.fn(),
  };
});
vi.mock('@api/middleware/auth', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    authenticate: pass,
    optionalAuthenticate: pass,
    rejectImpersonated: pass,
    customerUserId: vi.fn(() => null),
  };
});
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@api/services/cart.service', () => ({ CartService: {} }));
vi.mock('@api/services/order.service', () => ({ OrderService: {} }));
vi.mock('@api/services/invoice.service', () => ({ InvoiceService: {} }));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/services/slug-redirect.service', () => ({
  resolveSlugRedirect: vi.fn(),
  resolveSlugRedirectCached: vi.fn(),
}));
vi.mock('@api/services/view-ingest.service', () => ({ recordProductView: vi.fn() }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({ PaymentService: {} }));
vi.mock('@api/services/payment-confirm.service', () => ({
  confirmPaymentFromProviderStatus: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import publicRoutes from '@api/routes/public.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { invalidateCachedPrefix, invalidateCached } from '@api/lib/public-cache';
import { invalidateStoreDirectory } from '@api/lib/store-directory';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/public', publicRoutes);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

const resolve = (host: string) =>
  request(app).get('/public/store/resolve').set('x-store-domain', host);

beforeEach(async () => {
  redisData.clear();
  // getCached also keeps a module-level in-memory layer: drop it so every test starts cold.
  await invalidateCachedPrefix('');
  world.stores = [STORE_A, STORE_B];
  storeFindFirst.mockReset();
  storeFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const hit = (world.stores as StoreRow[]).find(s => matchesWhere(s, where));
    // Return the full row shape the route selects (extra keys are harmless).
    return hit ? { ...hit, theme: {}, settings: {}, marketingPixels: null } : null;
  });
  listPublic.mockReset();
  listPublic.mockImplementation(async (storeId: string) => ({
    products: [{ id: `${storeId}-p1`, name: `Product of ${storeId}` }],
  }));
});

describe('GET /public/store/resolve — host → store', () => {
  it.each([
    ['amelia.ebda.app', 'store-a'],
    ['AMELIA.EBDA.APP:443', 'store-a'],
    ['amelia.ebda.app.', 'store-a'],
    ['demo-boutique.ebda.app', 'store-b'],
    ['ameliaaurum.com', 'store-a'], // custom domain
    ['www.ameliaaurum.com', 'store-a'], // www canonicalises to the apex row
  ])('%s → %s', async (host, id) => {
    const res = await resolve(host);
    expect(res.status).toBe(200);
    expect(res.body.data.store.id).toBe(id);
  });

  it('a slug subdomain is looked up by SLUG, a custom domain by DOMAIN', async () => {
    await resolve('amelia.ebda.app');
    expect(storeFindFirst.mock.calls[0][0].where).toMatchObject({ slug: 'amelia' });
    expect(storeFindFirst.mock.calls[0][0].where).not.toHaveProperty('domain');
    storeFindFirst.mockClear();
    await resolve('ameliaaurum.com');
    expect(storeFindFirst.mock.calls[0][0].where).toMatchObject({ domain: 'ameliaaurum.com' });
    expect(storeFindFirst.mock.calls[0][0].where).not.toHaveProperty('slug');
  });

  it('serves a suspended store (branded maintenance page) but not an inactive or deleted one', async () => {
    world.stores = [
      { ...STORE_A, slug: 'paused', domain: null, status: 'suspended' },
      { ...STORE_B, slug: 'draft', status: 'inactive' },
      { ...STORE_B, slug: 'gone', deletedAt: new Date() },
    ];
    expect((await resolve('paused.ebda.app')).status).toBe(200);
    expect((await resolve('draft.ebda.app')).status).toBe(404);
    expect((await resolve('gone.ebda.app')).status).toBe(404);
  });

  // Hosts that can NEVER be a store never reach the database at all.
  it.each([
    'ebda.app',
    'www.ebda.app',
    'admin.ebda.app',
    'api.ebda.app',
    'orders.ebda.app',
    'docs.ebda.app',
    'whatsapp.ebda.app',
    'invite.ebda.app', // coming-soon page (SUBDOMAIN-SOON-2)
    'ads.ebda.app',
    'quote.ebda.app',
    'quote-studio.ebda.app',
    'chat.ebda.app', // 301 to wa.ebda.app
    'store.ebda.app',
    'app.ebda.app', // retired label: never served, never a store
    'mail.ebda.app',
    'x.y.ebda.app',
    'ab.ebda.app', // too short to be a slug
    '-bad-.ebda.app',
    '127.0.0.1',
    '127.0.0.1:3000',
    'localhost',
    'amelia.localhost', // dev suffix is NOT honoured by the API
    '[::1]',
    'not a host',
  ])('reserved/platform/invalid host %j → 404 with no database lookup', async host => {
    const res = await resolve(host);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('STORE_NOT_FOUND');
    expect(storeFindFirst).not.toHaveBeenCalled();
  });

  it('a reserved slug is a 404 even if a row with that slug exists', async () => {
    world.stores = [{ ...STORE_A, slug: 'app' }];
    expect((await resolve('admin.ebda.app')).status).toBe(404);
    expect(storeFindFirst).not.toHaveBeenCalled();
  });

  it('an unknown subdomain / custom domain is a 404 — never the first store', async () => {
    for (const host of ['nobody.ebda.app', 'nobody.example.com']) {
      const res = await resolve(host);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('store-a');
      expect(JSON.stringify(res.body)).not.toContain('store-b');
    }
  });

  it('a missing x-store-domain header is a 400, not a default store', async () => {
    const res = await request(app).get('/public/store/resolve');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_DOMAIN');
  });

  it('there is no default-store endpoint any more (GET /public/store)', async () => {
    const res = await request(app).get('/public/store');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('store-a');
  });
});

describe('cache isolation (Review Focus 1)', () => {
  it('store A then store B on the same endpoint: each host gets its own store, repeatedly', async () => {
    const first = await resolve('amelia.ebda.app'); // A is now cached
    const b = await resolve('demo-boutique.ebda.app');
    const again = await resolve('amelia.ebda.app'); // served from A's cache
    const bAgain = await resolve('demo-boutique.ebda.app');
    expect(first.body.data.store.id).toBe('store-a');
    expect(b.body.data.store.id).toBe('store-b');
    expect(again.body.data.store.id).toBe('store-a');
    expect(bAgain.body.data.store.id).toBe('store-b');
    // ...and the repeat really was a cache hit (one DB read per host).
    expect(storeFindFirst).toHaveBeenCalledTimes(2);
  });

  it('a custom domain and the same store’s subdomain are independent keys, each correct', async () => {
    const viaCustom = await resolve('ameliaaurum.com');
    const viaSub = await resolve('amelia.ebda.app');
    expect(viaCustom.body.data.store.id).toBe('store-a');
    expect(viaSub.body.data.store.id).toBe('store-a');
    expect(storeFindFirst).toHaveBeenCalledTimes(2);
  });

  it('an unknown host asked AFTER a known one is a 404 — no stale store', async () => {
    expect((await resolve('amelia.ebda.app')).status).toBe(200); // known, now cached
    const unknown = await resolve('nobody.ebda.app');
    expect(unknown.status).toBe(404);
    expect(unknown.body.data).toBeUndefined();
    expect((await resolve('amelia.ebda.app')).status).toBe(200); // known still fine
    const unknownCustom = await resolve('nobody.example.com');
    expect(unknownCustom.status).toBe(404);
  });

  it('a miss is negatively cached but cleared by the creation bust: a store created after a 404 resolves immediately', async () => {
    expect((await resolve('fresh.ebda.app')).status).toBe(404);
    world.stores = [
      ...(world.stores as StoreRow[]),
      { ...STORE_B, id: 'store-new', slug: 'fresh' },
    ];
    // Store creation busts the directory (NEON-SCALE-1 rule 1): the negative entry from the 404 is cleared.
    await invalidateStoreDirectory('store-new', 'fresh');
    const res = await resolve('fresh.ebda.app');
    expect(res.status).toBe(200);
    expect(res.body.data.store.id).toBe('store-new');
  });

  it('every cache key written is scoped to the host (or store id) — none is store-agnostic', async () => {
    await resolve('amelia.ebda.app');
    await resolve('demo-boutique.ebda.app');
    await resolve('ameliaaurum.com');
    const keys = [...redisData.keys()];
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const key of keys) {
      expect(key).toMatch(
        /dir:(id|slug|domain):|amelia\.ebda\.app|demo-boutique\.ebda\.app|ameliaaurum\.com|store-[ab]/
      );
    }
    expect(keys.some(k => k.endsWith(':default'))).toBe(false);
  });

  it('the SAME path (GET /products) returns each host’s own catalogue, before and after A is cached', async () => {
    const get = (host: string) => request(app).get('/public/products').set('x-store-domain', host);

    const a1 = await get('amelia.ebda.app'); // fills A's cache
    const b1 = await get('demo-boutique.ebda.app');
    const a2 = await get('amelia.ebda.app'); // served from A's cache
    const b2 = await get('demo-boutique.ebda.app');
    const custom = await get('ameliaaurum.com'); // A's custom domain: A's data again

    expect(a1.body.data.products[0].id).toBe('store-a-p1');
    expect(b1.body.data.products[0].id).toBe('store-b-p1');
    expect(a2.body.data.products[0].id).toBe('store-a-p1');
    expect(b2.body.data.products[0].id).toBe('store-b-p1');
    expect(custom.body.data.products[0].id).toBe('store-a-p1');
    // One fetch per store, not per request: the cache is real, and still isolated.
    expect(listPublic).toHaveBeenCalledTimes(2);
    expect(listPublic.mock.calls.map(c => c[0]).sort()).toEqual(['store-a', 'store-b']);
  });

  it('the same path for an unknown host after a cached store is a 400 STORE_NOT_RESOLVED, never A’s data', async () => {
    const get = (host: string) => request(app).get('/public/products').set('x-store-domain', host);
    await get('amelia.ebda.app');
    const unknown = await get('nobody.ebda.app');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('STORE_NOT_RESOLVED');
    expect(JSON.stringify(unknown.body)).not.toContain('store-a');
    const reserved = await get('admin.ebda.app');
    expect(reserved.status).toBe(400);
  });
});

describe('GET /public/stores/:slugOrId', () => {
  it('resolves a slug case-insensitively through ONE cache entry', async () => {
    const lower = await request(app).get('/public/stores/amelia');
    const upper = await request(app).get('/public/stores/AMELIA');
    expect(lower.body.data.store.id).toBe('store-a');
    expect(upper.body.data.store.id).toBe('store-a');
    expect(storeFindFirst).toHaveBeenCalledTimes(1);
  });

  it.each(['app', 'api', 'www', 'orders', 'store', 'admin'])(
    'reserved label %j is a 404 with no database lookup',
    async slug => {
      const res = await request(app).get(`/public/stores/${slug}`);
      expect(res.status).toBe(404);
      expect(storeFindFirst).not.toHaveBeenCalled();
    }
  );

  it('an unknown slug is a 404, negatively cached, and cleared by the creation bust', async () => {
    expect((await request(app).get('/public/stores/newcomer')).status).toBe(404);
    world.stores = [
      ...(world.stores as StoreRow[]),
      { ...STORE_B, id: 'store-n', slug: 'newcomer' },
    ];
    await invalidateStoreDirectory('store-n', 'newcomer');
    const res = await request(app).get('/public/stores/newcomer');
    expect(res.status).toBe(200);
    expect(res.body.data.store.id).toBe('store-n');
  });
});

// RESOLVE-SWR-1: the resolved payload is served stale-while-revalidate (120 s soft age, 600 s hard max). A write of a
// NEVER-stale field is cleared by its bust, so a bust is never followed by the old payload, at any age.
/** Lets an un-awaited background refresh (in-memory mocks only, no real I/O) run to its end. */
const settleRefresh = async () => {
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
};

describe('GET /public/store/resolve: stale-while-revalidate, NEVER-stale cleared by the bust', () => {
  const HOST = 'amelia.ebda.app';
  const KEY = 'public:store:resolve:amelia.ebda.app';
  let clock: number;
  beforeEach(() => {
    clock = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => vi.restoreAllMocks());
  const suspend = () => {
    world.stores = (world.stores as StoreRow[]).map(s =>
      s.id === STORE_A.id ? { ...s, status: 'suspended' as const } : s
    );
  };
  const status = async () => (await resolve(HOST)).body.data.store.status as string;

  it('past the soft age the cached payload is served at once and refreshed behind the response', async () => {
    expect(await status()).toBe('active');
    clock += 200_000;
    suspend(); // a write that was NOT busted (the BOUNDED-stale case the window is for)
    expect(await status()).toBe('active'); // stale, served without waiting on the refill
    await settleRefresh();
    expect(await status()).toBe('suspended'); // the background refresh landed
  });

  it('a suspension followed by its bust is served as suspended at every age, never the cached active payload', async () => {
    for (const ageMs of [0, 119_000, 200_000, 590_000]) {
      redisData.clear();
      await invalidateCachedPrefix('');
      world.stores = [STORE_A, STORE_B];
      expect(await status()).toBe('active'); // cache the ACTIVE payload
      clock += ageMs;
      suspend(); // the write ...
      await invalidateStoreDirectory(STORE_A.id, STORE_A.slug, STORE_A.domain);
      await invalidateCached(KEY); // ... and what bustStoreCaches does to the resolve key
      expect(await status(), `age ${ageMs} ms`).toBe('suspended');
    }
  });
});
