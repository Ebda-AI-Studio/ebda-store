/**
 * NEON-ZERO-1 (review of the storefront PR): `POST /public/orders/:id/verify-payment` for a Durable Object store.
 *
 * The order is read from the DO, but the confirmation (`confirmPaymentFromProviderStatus`) claims and writes it in Postgres,
 * where a DO store's order does not exist: a declined card used to come back `paymentStatus: 'paid'` (a 0-row claim read as
 * "paid or settled") and a completed one threw a 500. For a DO store the route now reports the DO order's own state and never
 * calls the Postgres confirmation; `claimOrderFailed` answers `not_found` for an order Postgres does not hold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  backend: 'do' as 'do' | 'pg',
  order: {
    id: 'o1',
    storeId: 'store-do',
    customerId: null,
    paymentStatus: 'unpaid',
    locale: 'en',
    payments: [
      {
        id: 'p1',
        status: 'pending',
        provider: 'paymob',
        transactionId: 't1',
        metadata: {},
        amount: 1000,
        currency: 'EGP',
      },
    ],
  } as Record<string, unknown>,
  confirm: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: new Proxy(
    {},
    {
      get: () => {
        throw new Error('Postgres touched');
      },
    }
  ),
  withStore: () => {
    throw new Error('Postgres touched');
  },
  SlugEntityType: {},
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ order: { findFirst: async () => h.order } }),
  storeRepo: async () => ({ backend: h.backend }),
  storeWriter: async () => ({}),
}));
vi.mock('@api/lib/definer', () => ({
  lookupStore: async () => ({ id: 'store-do', status: 'active' }),
  resolveStoreId: async () => 'store-do',
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: (_id: string, fn: () => unknown) => fn(),
  inDoStoreScope: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/order-tax', () => ({
  resolveActiveTaxRate: vi.fn(),
  effectiveTaxFields: vi.fn(),
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
vi.mock('@api/services/order.service', () => ({ OrderService: {} }));
vi.mock('@api/services/invoice.service', () => ({ InvoiceService: {} }));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/services/slug-redirect.service', () => ({
  resolveSlugRedirect: vi.fn(),
  resolveSlugRedirectCached: vi.fn(),
}));
vi.mock('@api/services/view-ingest.service', () => ({ recordProductView: vi.fn() }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { getPaymentStatus: (...a: unknown[]) => h.getStatus(...a) },
}));
vi.mock('@api/services/payment-confirm.service', () => ({
  confirmPaymentFromProviderStatus: (...a: unknown[]) => h.confirm(...a),
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

const verify = () =>
  request(app).post('/public/orders/o1/verify-payment').set('x-store-id', 'store-do').send({});

beforeEach(() => {
  h.backend = 'do';
  h.order = { ...h.order, paymentStatus: 'unpaid' };
  h.confirm.mockReset();
  h.getStatus.mockReset().mockResolvedValue({ status: 'failed' });
});

describe('verify-payment on a Durable Object store', () => {
  it('a declined card is never reported paid, and the Postgres confirmation is not called', async () => {
    h.getStatus.mockResolvedValue({ status: 'failed' });
    const res = await verify();
    expect(res.status).toBe(200);
    expect(res.body.data.paymentStatus).not.toBe('paid');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('a completed payment does not 500 (it waits for the webhook) and is not claimed paid here', async () => {
    h.getStatus.mockResolvedValue({ status: 'completed' });
    const res = await verify();
    expect(res.status).toBe(200);
    expect(res.body.data.paymentStatus).toBe('unpaid');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("reports the DO order's own failed state", async () => {
    h.order = { ...h.order, paymentStatus: 'failed' };
    expect((await verify()).body.data.paymentStatus).toBe('failed');
  });

  it('an order the DO already holds as paid stays paid', async () => {
    h.order = { ...h.order, paymentStatus: 'paid' };
    expect((await verify()).body.data.paymentStatus).toBe('paid');
  });

  it('a Postgres store still goes through the confirmation', async () => {
    h.backend = 'pg';
    h.confirm.mockResolvedValue({
      paymentStatus: 'failed',
      providerStatus: 'failed',
      statusChanged: true,
    });
    const res = await verify();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(res.body.data.paymentStatus).toBe('failed');
  });
});
