/**
 * Editor canvas preview of a store that is NOT active yet.
 *
 * Root cause (2026-10-14 live QA): the storefront resolves the store from the
 * Host via `GET /public/store/resolve`, which only returns active/suspended
 * stores, and `getStoreOrNotFound()` 404s on the miss BEFORE the canvas token
 * (`?_builder=`) is ever looked at. The fix lets the API verify the token
 * server-side (Redis entry bound to the store the HOST resolves to) and return
 * the inactive store for that request only, uncached.
 *
 * Runs the REAL router + REAL getCached over the same fake world as
 * store-host-resolver.test.ts. Nothing here runs the real DB or Redis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
const redisData = vi.hoisted(() => new Map<string, unknown>());

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
    set: async (key: string, value: unknown) => void redisData.set(key, value),
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
    cartLimiter: pass,
    couponAttemptLimiter: pass,
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
import { invalidateCachedPrefix } from '@api/lib/public-cache';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/public', publicRoutes);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

const TOKEN = 'tok_A_abcdefghijklmnopqrstuv'; // 28 chars, valid shape
const OTHER_TOKEN = 'tok_B_abcdefghijklmnopqrstuv';
const DRAFT: StoreRow = { ...STORE_B, id: 'store-draft', slug: 'draftshop', status: 'inactive' };
const ACTIVE_OTHER: StoreRow = { ...STORE_A, id: 'store-live', slug: 'liveshop', domain: null };

const seedToken = (storeId: string, token: string) =>
  void redisData.set(`builder-preview:${storeId}:${token}`, { pageKey: 'home' });

const resolve = (host: string, token?: string) => {
  const r = request(app).get('/public/store/resolve').set('x-store-domain', host);
  return token ? r.set('x-builder-preview-token', token) : r;
};

beforeEach(async () => {
  redisData.clear();
  await invalidateCachedPrefix('');
  world.stores = [DRAFT, ACTIVE_OTHER];
  storeFindFirst.mockReset();
  storeFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const hit = (world.stores as StoreRow[]).find(s => matchesWhere(s, where));
    return hit ? { ...hit, theme: {}, settings: {}, marketingPixels: null } : null;
  });
  listPublic.mockReset();
});

describe('GET /public/store/resolve — builder preview of an inactive store', () => {
  it('inactive store + valid token for THAT store -> resolves, no-store + noindex', async () => {
    seedToken('store-draft', TOKEN);
    const res = await resolve('draftshop.ebda.app', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.data.store.id).toBe('store-draft');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-robots-tag']).toContain('noindex');
  });

  it('inactive store, no token -> 404 (public access stays denied)', async () => {
    seedToken('store-draft', TOKEN);
    const res = await resolve('draftshop.ebda.app');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('STORE_NOT_FOUND');
  });

  it('inactive store + token minted for ANOTHER store -> 404 (no cross-tenant unlock)', async () => {
    seedToken('store-live', OTHER_TOKEN); // valid token, wrong store
    const res = await resolve('draftshop.ebda.app', OTHER_TOKEN);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('store-draft');
  });

  it('expired / never-minted / forged token -> 404', async () => {
    // expired = the Redis entry is gone; forged = never existed
    for (const token of [TOKEN, 'forged_forged_forged_forged']) {
      expect((await resolve('draftshop.ebda.app', token)).status).toBe(404);
    }
  });

  it('malformed token shapes never reach Redis and -> 404', async () => {
    for (const token of ['short', 'has spaces and symbols !!!!!!!!', 'a'.repeat(65)]) {
      expect((await resolve('draftshop.ebda.app', token)).status).toBe(404);
    }
  });

  it('a valid token never turns a deleted store or an unknown host into a store', async () => {
    world.stores = [{ ...DRAFT, deletedAt: new Date() }];
    seedToken('store-draft', TOKEN);
    expect((await resolve('draftshop.ebda.app', TOKEN)).status).toBe(404);
    expect((await resolve('nobody.ebda.app', TOKEN)).status).toBe(404);
  });

  it('active store is unaffected: same payload with or without a token, public path stays cacheable', async () => {
    const plain = await resolve('liveshop.ebda.app');
    expect(plain.status).toBe(200);
    expect(plain.body.data.store.id).toBe('store-live');
    // an invalid token on an active store falls through to the normal path
    const junk = await resolve('liveshop.ebda.app', 'forged_forged_forged_forged');
    expect(junk.status).toBe(200);
    expect(junk.body.data.store.id).toBe('store-live');
    expect(junk.headers['cache-control']).not.toBe('private, no-store');
  });

  it('a preview response is never written to the shared public cache', async () => {
    seedToken('store-draft', TOKEN);
    expect((await resolve('draftshop.ebda.app', TOKEN)).status).toBe(200);
    const sharedKeys = [...redisData.keys()].filter(k => k.startsWith('public:store:resolve:'));
    expect(sharedKeys).toEqual([]);
    // ...and the next PUBLIC request for the same host is still denied.
    expect((await resolve('draftshop.ebda.app')).status).toBe(404);
  });
});
