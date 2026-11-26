/**
 * RESOLVE-PARALLEL-1 / ruling TAX-2 / M3-9 (money, display = charge): the tax fields the PUBLIC storefront payloads carry
 * (`GET /public/store/resolve` and `GET /public/stores/:slugOrId`) must equal what an ORDER for the same store charges.
 * The concurrent fill moved the resolver call, so this is a behavioural check, not a shape pin: the REAL router, the REAL
 * `resolveActiveTaxRate` / `effectiveTaxFields` / `computeOrderTax`, a fake database whose tax reads are the ones the order
 * path makes, and the same fixture asked both ways. The VAT gate cases (unverified, disabled, no rate) must read 0 / false
 * in the payload exactly where the order charges nothing.
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
// What the REAL `resolveActiveTaxRate` reads for a store (the three reads the order path also makes).
const taxWorld = vi.hoisted(() => ({
  taxEnabled: false,
  taxIncludedInPrice: false,
  rates: [] as { rate: string }[],
  profile: null as null | { status: string; taxRegistrationNumber: string; legalName: string },
}));
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
  return hit
    ? {
        ...hit,
        theme: {},
        settings: {},
        marketingPixels: null,
        taxEnabled: taxWorld.taxEnabled,
        taxIncludedInPrice: taxWorld.taxIncludedInPrice,
      }
    : null;
};

vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: {
        findUnique: async ({ where }: { where: { id: string } }) => storeRowById(where.id),
      },
      taxRate: { findMany: async () => taxWorld.rates },
      storeTaxProfile: { findUnique: async () => taxWorld.profile },
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
// The REAL order-tax resolver runs (no mock): the postgres repo path reads through the mocked `withStore` above.
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
    guestReturnIpLimiter: pass,
    guestReturnOrderLimiter: pass,
    storeResolveLimiter: pass,
    storeMissLimiter: pass,
    publicSearchLimiter: pass,
    whenSearching: () => pass,
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
import { resolveActiveTaxRate } from '@api/lib/order-tax';
import { computeOrderTax } from '@ebda/shared';

const VERIFIED = { status: 'verified', taxRegistrationNumber: '123456789', legalName: 'Acme LLC' };
const cases: Array<{
  name: string;
  enabled: boolean;
  included: boolean;
  rates: string[];
  profile: typeof taxWorld.profile;
  percent: number;
}> = [
  {
    name: 'enabled + verified + 14%',
    enabled: true,
    included: false,
    rates: ['14.00'],
    profile: VERIFIED,
    percent: 14,
  },
  {
    name: 'enabled + verified + 5% + 2% (summed)',
    enabled: true,
    included: false,
    rates: ['5.00', '2.00'],
    profile: VERIFIED,
    percent: 7,
  },
  {
    name: 'prices include the tax',
    enabled: true,
    included: true,
    rates: ['14.00'],
    profile: VERIFIED,
    percent: 14,
  },
  {
    name: 'enabled but NOT verified (VAT gate): 0',
    enabled: true,
    included: false,
    rates: ['14.00'],
    profile: { ...VERIFIED, status: 'pending' },
    percent: 0,
  },
  {
    name: 'enabled with no tax profile: 0',
    enabled: true,
    included: false,
    rates: ['14.00'],
    profile: null,
    percent: 0,
  },
  {
    name: 'disabled by the merchant: 0',
    enabled: false,
    included: false,
    rates: ['14.00'],
    profile: VERIFIED,
    percent: 0,
  },
  {
    name: 'enabled + verified but no active rate: 0',
    enabled: true,
    included: false,
    rates: [],
    profile: VERIFIED,
    percent: 0,
  },
];

describe('public payload tax fields equal what the order charges (display = charge)', () => {
  for (const c of cases) {
    it(c.name, async () => {
      taxWorld.taxEnabled = c.enabled;
      taxWorld.taxIncludedInPrice = c.included;
      taxWorld.rates = c.rates.map(rate => ({ rate }));
      taxWorld.profile = c.profile;

      // What the order uses (order.service.ts: resolveActiveTaxRate(storeId) -> computeOrderTax).
      const order = await resolveActiveTaxRate(STORE_A.id);
      expect(order.ratePercent).toBe(c.percent);
      const orderTax = computeOrderTax(100_00, 0, order.ratePercent / 100, order.includedInPrice);

      for (const get of [
        () => resolve('amelia.ebda.app'),
        () => request(app).get('/public/stores/amelia'),
      ]) {
        await invalidateCachedPrefix('');
        redisData.clear();
        const res = await get();
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const s = res.body.data.store;
        expect(s.taxRatePercent).toBe(order.ratePercent);
        expect(s.taxEnabled).toBe(order.ratePercent > 0);
        expect(s.taxIncludedInPrice).toBe(order.includedInPrice);
        // A shopper's cart line computed from the payload equals the order's tax for the same basket.
        expect(computeOrderTax(100_00, 0, s.taxRatePercent / 100, s.taxIncludedInPrice)).toBe(
          orderTax
        );
      }
    });
  }
});
