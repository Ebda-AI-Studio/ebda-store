/**
 * Gold-rate pricing, review fix wave (Ruling B5-36): the BODY of `POST /public/orders` (the create response) must
 * not carry the merchant's cost or the gold margin. It used to return what `OrderService.create` returns, whole.
 * Runs the REAL public router; only the service underneath is a double that returns a worst-case order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const world = vi.hoisted(() => ({ stores: [] as unknown[] }));
const storeFindFirst = vi.hoisted(() => vi.fn());
const listPublic = vi.hoisted(() => vi.fn());
const redisData = vi.hoisted(() => new Map<string, unknown>());
const createOrder = vi.hoisted(() => vi.fn());
const storeRowById = (id: string) => ({
  id,
  slug: 's',
  name: 'S',
  status: 'active',
  theme: {},
  settings: {},
  marketingPixels: null,
});

vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: {
        findUnique: async ({ where }: { where: { id: string } }) => storeRowById(where.id),
      },
    }),
  prisma: {
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
vi.mock('@api/services/order.service', () => ({
  OrderService: { create: (...a: unknown[]) => createOrder(...a) },
}));
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

const app = express();
app.use(express.json());
app.use('/public', publicRoutes);
app.use(errorHandler);

const SNAP = {
  v: 1,
  karat: 21,
  weightMg: 3250,
  ratePerGram: 410000,
  rateId: 'rate-secret-id',
  rateAppliedAt: '2026-10-22T06:00:00.000Z',
  makingChargeType: 'per_gram',
  makingChargeValue: 15000,
  marginBps: 700,
  roundingStep: 100,
  unitPrice: 2_050_000,
};

describe('POST /public/orders response body', () => {
  beforeEach(() => {
    storeFindFirst.mockResolvedValue({ id: 'store-a', status: 'active' });
    createOrder.mockResolvedValue({
      id: 'o1',
      total: 2_050_000,
      items: [{ id: 'i1', price: 2_050_000, costPrice: 1_700_000, goldSnapshot: SNAP }],
    });
  });

  it('carries no cost price, margin, making charge or rate id on a gold line', async () => {
    const res = await request(app)
      .post('/public/orders')
      .set('x-session-id', 'sess-1')
      .set('x-store-domain', 'ameliaaurum.com')
      .send({
        shippingAddress: { firstName: 'A', lastName: 'B', address1: 'Street 1', country: 'EG' },
        paymentMethod: 'cod',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const text = JSON.stringify(res.body);
    expect(createOrder).toHaveBeenCalled();
    expect(text).toContain('"price":2050000');
    expect(text).not.toMatch(/costPrice|marginBps|makingCharge|rate-secret-id|roundingStep/);
  });
});
