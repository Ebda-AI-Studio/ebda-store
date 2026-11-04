/**
 * Ruling CF-JOBS-4: the non-money jobs (second half of the alphabet) that serve a store on its Durable Object. Each job here is
 * proved on the DO path: it is not refused by the guard, it reads and writes the store ONLY through the DO clients (the Postgres
 * `prisma` mock and `runInTenantContext` THROW if reached), platform rows (`Store`, `User`) come from the platform mock, and a job
 * that writes is delivered twice and writes once. The DO ops themselves: packages/repo/test/do-job-ops-b.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';

const h = vi.hoisted(() => {
  const pg = new Proxy(
    {},
    {
      get: (_t, p) => {
        throw new Error(`Postgres touched: prisma.${String(p)}`);
      },
    }
  );
  return {
    pg,
    // platform rows (D1 target, still Postgres): `withStore` answers from here
    platform: {
      store: { findUnique: vi.fn() },
      user: { findMany: vi.fn() },
      storeLifecycleEmail: { createMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
      storeSubscription: { findUnique: vi.fn() },
    } as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
    doDb: {
      order: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
      review: { findUnique: vi.fn() },
      product: { count: vi.fn() },
      shippingZone: { count: vi.fn() },
      paymentConfig: { count: vi.fn() },
      abandonedCart: { count: vi.fn() },
      storeWhatsAppLink: { findUnique: vi.fn() },
      storeWhatsAppConsent: { findMany: vi.fn() },
      fiscalDocument: { findMany: vi.fn() },
    } as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
    writer: { review: { update: vi.fn() } } as Record<
      string,
      Record<string, ReturnType<typeof vi.fn>>
    >,
    money: { orderStamp: vi.fn() },
    emailReview: vi.fn(async () => undefined),
    emailInvoice: vi.fn(async () => undefined),
    emailLifecycle: vi.fn(async () => undefined),
    capi: vi.fn(async () => undefined),
    gemini: vi.fn(),
    sendStoreEvents: vi.fn(async () => undefined),
    redis: { exists: vi.fn(async () => 0), set: vi.fn(async () => undefined) },
  };
});

// the Store row is read through the store's backend (Ruling NZ-AN-1, N-13): same stub as the platform one
h.doDb.store = h.platform.store;

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: h.pg,
    extra: {
      currentStoreId: () => DO_STORE,
      withStore: async (_id: string, fn: (tx: unknown) => Promise<unknown>) => fn(h.platform),
      runInTenantContext: async () => {
        throw new Error('Postgres touched: runInTenantContext');
      },
    },
  })
);
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async (storeId: string) => ({
    storeId,
    backend: 'do',
    db: h.doDb,
    writer: h.writer,
    money: h.money,
  }),
  storeMoney: async () => h.money,
  storeDb: async () => h.doDb,
  storeWriter: async () => h.writer,
  runInJobRepoScope: <T>(fn: () => T) => fn(),
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(async () => undefined),
    createFunction: (options: unknown, handler: unknown) => ({ options, handler }),
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn(async () => 'sent') }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendReviewRequest: h.emailReview,
    sendInvoice: h.emailInvoice,
    sendLifecycleEmail: h.emailLifecycle,
  },
}));
vi.mock('@api/services/pixels-capi.service', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/services/pixels-capi.service')>()),
  sendPurchaseConversion: h.capi,
}));
vi.mock('@api/lib/ai/gemini-keys', () => ({
  GeminiFailoverClient: class {
    getGenerativeModel() {
      return { generateContent: h.gemini };
    }
  },
}));
// The AI call is mocked, but getModel() refuses without a key: pin one so the suite does not depend on the runner's env.
vi.mock('@api/config', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/config')>();
  return { ...actual, config: { ...actual.config, googleAiKey: 'test-key' } };
});
vi.mock('@api/lib/ai-quota', () => ({ assertAiQuota: vi.fn() }));
vi.mock('@api/lib/wa/events', () => ({
  buildStoreEvent: async (input: unknown) => input,
  sendStoreEvents: h.sendStoreEvents,
}));
vi.mock('@api/services/plan-entitlements', () => ({
  getEntitlements: async () => ({
    planCode: 'growth',
    status: 'active',
    limits: { whatsappAutomation: true },
    currentPeriodEnd: null,
    trialEndsAt: null,
    pastDueSince: null,
  }),
}));
vi.mock('@api/services/redis.service', () => ({ redis: h.redis }));
vi.mock('@api/services/sentry.service', () => ({ SentryService: { captureException: vi.fn() } }));

import { NO_STORE_DATA_JOBS, PORTED_JOBS } from '@api/lib/jobs/job-data';
import { decideRunForStore } from '@api/lib/jobs/do-guard';
import { reviewRequest } from '@api/lib/inngest/functions/review-request';
import { reviewModeration } from '@api/lib/inngest/functions/review-moderation';
import { invoiceEmail } from '@api/lib/inngest/functions/invoice-email';
import { orderCapiConversion } from '@api/lib/inngest/functions/order-capi-conversion';
import { lifecycleFirstOrder } from '@api/lib/inngest/functions/lifecycle-emails';
import { waPlanSync } from '@api/lib/inngest/functions/wa-store-events';

type Handler = { handler: (a: unknown) => Promise<unknown> };
const call = (job: unknown, event: object) =>
  (job as Handler).handler({
    event,
    step: {
      run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
        const v = await fn();
        return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
      },
      sleep: async () => undefined,
      sleepUntil: async () => undefined,
    },
  });

/** The ids this file proves; the guard must let each one run for the DO store. */
const PORTED_B = [
  'ebda-ads-conversion',
  'legal-notice-send',
  'review-request',
  'review-moderation',
  'invoice-email',
  'order-capi-conversion',
  'lifecycle-emails',
  'lifecycle-first-order',
  'wa-plan-sync',
];

beforeEach(() => {
  vi.clearAllMocks();
  for (const group of [h.platform, h.doDb, h.writer])
    for (const m of Object.values(group)) for (const f of Object.values(m)) f.mockReset();
  h.money.orderStamp.mockReset();
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
  vi.stubEnv('AI_BULK_THROTTLE_MS', '0');
});

describe('the guard lets the ported non-money jobs run for a DO store', () => {
  it.each(PORTED_B)('%s is classified and not refused', async id => {
    expect(NO_STORE_DATA_JOBS.has(id) || PORTED_JOBS.has(id), id).toBe(true);
    expect(await decideRunForStore({ id } as never, DO_STORE), id).toEqual({ run: true });
  });
});

describe('review-request on a DO store', () => {
  const order = {
    id: 'o1',
    status: 'delivered',
    storeId: DO_STORE,
    locale: 'ar',
    customerId: 'u1',
    reviewRequestSentAt: null as Date | null,
    shippingAddress: null,
    items: [{ productId: 'p1', product: { id: 'p1', name: 'Mug', nameAr: 'كوب', images: [] } }],
  };
  const event = { name: 'order/delivered', data: { orderId: 'o1', storeId: DO_STORE } };
  beforeEach(() => {
    h.platform.store.findUnique.mockResolvedValue({ slug: 'demo', domain: null });
    h.platform.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        firstName: 'Mona',
        lastName: 'A',
        email: 'mona@example.com',
        phone: null,
        language: 'ar',
      },
    ]);
  });

  it('reads the order from the DO, attaches the buyer from the platform, and stamps once through the DO op', async () => {
    h.doDb.order.findUnique.mockResolvedValue({ ...order });
    h.money.orderStamp.mockResolvedValue({ stamped: true });
    const r = (await call(reviewRequest, event)) as { sent?: boolean };
    expect(r.sent).toBe(true);
    expect(h.emailReview).toHaveBeenCalledWith(
      DO_STORE,
      expect.objectContaining({ to: 'mona@example.com', customerName: 'Mona A' }),
      'ar'
    );
    expect(h.money.orderStamp).toHaveBeenCalledWith({
      orderId: 'o1',
      stamp: 'reviewRequestSentAt',
    });
  });

  it('double-fire: the second delivery sees the stamp and sends nothing', async () => {
    let stamp: Date | null = null;
    h.doDb.order.findUnique.mockImplementation(async () => ({
      ...order,
      reviewRequestSentAt: stamp,
    }));
    h.money.orderStamp.mockImplementation(async () => {
      const first = stamp === null;
      stamp ??= new Date();
      return { stamped: first };
    });
    await call(reviewRequest, event);
    const second = (await call(reviewRequest, event)) as { skipped?: string };
    expect(second.skipped).toBe('already-sent');
    expect(h.emailReview).toHaveBeenCalledTimes(1);
    expect(h.money.orderStamp).toHaveBeenCalledTimes(1);
  });
});

describe('review-moderation on a DO store', () => {
  const event = { name: 'review/submitted', data: { reviewId: 'r1', storeId: DO_STORE } };
  beforeEach(() => {
    h.doDb.review.findUnique.mockResolvedValue({
      storeId: DO_STORE,
      title: 't',
      body: 'Great mug, fast delivery',
      rating: 5,
      language: 'en',
      bodyTranslated: null,
    });
    h.gemini.mockImplementation(async () => ({
      response: { text: () => '{"spamScore":0.05,"reasons":[],"translated":"كوب ممتاز"}' },
    }));
  });

  it('scores the review from the DO, persists the verdict and the translation through the DO writer', async () => {
    const r = (await call(reviewModeration, event)) as { status: string };
    expect(r.status).toBe('published');
    expect(h.writer.review.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1', storeId: DO_STORE },
        data: expect.objectContaining({ spamScore: 0.05, status: 'published' }),
      })
    );
    expect(h.writer.review.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bodyTranslated: 'كوب ممتاز' }),
      })
    );
  });

  it('double-fire: the verdict is an overwrite with the same value, and a translated review is not translated again', async () => {
    await call(reviewModeration, event);
    h.doDb.review.findUnique.mockResolvedValue({
      storeId: DO_STORE,
      title: 't',
      body: 'Great mug, fast delivery',
      rating: 5,
      language: 'en',
      bodyTranslated: 'كوب ممتاز',
    });
    h.writer.review.update.mockClear();
    h.gemini.mockClear();
    await call(reviewModeration, event);
    const writes = h.writer.review.update.mock.calls.map(c => Object.keys(c[0].data).sort());
    expect(writes).toEqual([['spamReasons', 'spamScore', 'status']]); // the verdict again; no second translation write
  });
});

describe('invoice-email on a DO store', () => {
  it('renders the invoice from the DO order (buyer and store attached from the platform) and mails it', async () => {
    h.doDb.order.findFirst.mockResolvedValue({
      id: 'o1',
      storeId: DO_STORE,
      orderNumber: 'EB-1',
      customerId: 'u1',
      locale: 'en',
      status: 'delivered',
      paymentStatus: 'paid',
      total: 1000,
      subtotal: 1000,
      shippingCost: 0,
      discount: 0,
      tax: 0,
      currency: 'EGP',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      shippingAddress: { firstName: 'Mona', lastName: 'A', email: 'mona@example.com' },
      billingAddress: null,
      items: [],
      payments: [],
      appliedPromotion: null,
    });
    h.doDb.order.findUnique.mockResolvedValue({ orderNumber: 'EB-1', locale: 'en' });
    h.doDb.fiscalDocument.findMany.mockResolvedValue([]);
    h.platform.store.findUnique.mockResolvedValue({
      name: 'Demo',
      email: 's@example.com',
      phone: null,
      address: null,
      logo: null,
      theme: null,
      look: null,
      template: null,
      currency: 'EGP',
      timezone: 'Africa/Cairo',
      settings: {},
    });
    h.platform.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        firstName: 'Mona',
        lastName: 'A',
        email: 'mona@example.com',
        phone: null,
        language: 'en',
      },
    ]);
    await call(invoiceEmail, {
      name: 'order/invoice.email-requested',
      data: { orderId: 'o1', storeId: DO_STORE, to: 'mona@example.com' },
    });
    expect(h.doDb.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1', storeId: DO_STORE } })
    );
    expect(h.emailInvoice).toHaveBeenCalledWith(
      DO_STORE,
      expect.objectContaining({ to: 'mona@example.com', orderNumber: 'EB-1' }),
      'en'
    );
  });
});

describe('order-capi-conversion on a DO store', () => {
  const event = { name: 'order/created', data: { orderId: 'o1', storeId: DO_STORE } };
  it('reads the order from the DO and the buyer from the platform, then sends the conversion', async () => {
    h.platform.store.findUnique.mockResolvedValue({
      marketingPixels: {},
      slug: 'demo',
      domain: null,
    });
    h.doDb.order.findUnique.mockResolvedValue({
      id: 'o1',
      total: 500,
      currency: 'EGP',
      shippingAddress: { city: 'Cairo' },
      customerId: 'u1',
    });
    h.platform.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        firstName: 'M',
        lastName: 'A',
        email: 'm@example.com',
        phone: '0100',
        language: 'ar',
      },
    ]);
    const r = (await call(orderCapiConversion, event)) as { sent?: boolean };
    expect(r.sent).toBe(true);
    expect(h.capi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'o1', customer: { email: 'm@example.com', phone: '0100' } }),
      expect.any(String)
    );
  });
  it('an erased customer order is suppressed (a re-delivery sends nothing)', async () => {
    h.platform.store.findUnique.mockResolvedValue({
      marketingPixels: {},
      slug: 'demo',
      domain: null,
    });
    h.doDb.order.findUnique.mockResolvedValue({
      id: 'o1',
      total: 500,
      currency: 'EGP',
      shippingAddress: { anonymized: true },
      customerId: null,
    });
    await call(orderCapiConversion, event);
    const second = (await call(orderCapiConversion, event)) as { skipped?: string };
    expect(second.skipped).toBe('erased-customer-suppressed');
    expect(h.capi).not.toHaveBeenCalled();
  });
});

describe('lifecycle first-order email on a DO store', () => {
  it('reads setup state and the order from the DO, records the (store, kind) row once, sends once', async () => {
    h.platform.store.findUnique.mockResolvedValue({
      name: 'Demo',
      slug: 'demo',
      domain: null,
      status: 'active',
      settings: {},
      createdAt: new Date(),
      owner: { email: 'owner@example.com', status: 'active' },
    });
    h.platform.storeSubscription.findUnique.mockResolvedValue({
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + 86_400_000 * 10),
    });
    h.platform.storeLifecycleEmail.findUnique.mockResolvedValue(null);
    let rows = 0;
    h.platform.storeLifecycleEmail.createMany.mockImplementation(async () => ({
      count: rows++ === 0 ? 1 : 0,
    }));
    h.doDb.product.count.mockResolvedValue(3);
    h.doDb.shippingZone.count.mockResolvedValue(1);
    h.doDb.paymentConfig.count.mockResolvedValue(1);
    h.doDb.order.count.mockResolvedValue(1);
    h.doDb.order.findUnique.mockResolvedValue({
      status: 'pending',
      shippingAddress: { email: 'buyer@example.com' },
      customerId: null,
    });
    const ev = { name: 'order/created', data: { storeId: DO_STORE, orderId: 'o1' } };
    const first = (await call(lifecycleFirstOrder, ev)) as { status: string };
    const second = (await call(lifecycleFirstOrder, ev)) as { status: string };
    expect(first.status).toBe('sent');
    expect(second.status).toBe('duplicate');
    expect(h.emailLifecycle).toHaveBeenCalledTimes(1);
    expect(h.doDb.product.count).toHaveBeenCalled();
  });
});

describe('wa-plan-sync on a DO store alarm', () => {
  it('finds the link row in the DO, re-sends the plan state, and backfills once per store', async () => {
    h.doDb.storeWhatsAppLink.findUnique.mockResolvedValue({ storeId: DO_STORE });
    h.doDb.storeWhatsAppConsent.findMany.mockResolvedValue([]);
    h.platform.store.findUnique.mockResolvedValue({ ownerId: 'owner-1' });
    const alarm = { name: 'cron', data: { alarm: true, storeId: DO_STORE } };
    await call(waPlanSync, alarm);
    expect(h.redis.exists).toHaveBeenCalledWith(expect.stringContaining(`:${DO_STORE}`));
    expect(h.redis.set).toHaveBeenCalledWith(
      expect.stringContaining(`:${DO_STORE}`),
      '1',
      expect.any(Number)
    );
    expect(h.sendStoreEvents).toHaveBeenCalled();
  });
  it('a store with no link row sends nothing', async () => {
    h.doDb.storeWhatsAppLink.findUnique.mockResolvedValue(null);
    const r = (await call(waPlanSync, {
      name: 'cron',
      data: { alarm: true, storeId: DO_STORE },
    })) as {
      sent: number;
    };
    expect(r.sent).toBe(0);
    expect(h.sendStoreEvents).not.toHaveBeenCalled();
  });
});

describe('the ported jobs reach their store only through the DO-aware clients', () => {
  const read = (f: string) => readFileSync(`apps/api/src/lib/inngest/functions/${f}`, 'utf8');
  it('none of them opens a Postgres tenant transaction or reads a store model with prisma', () => {
    for (const f of ['review-moderation.ts', 'invoice-email.ts', 'order-capi-conversion.ts']) {
      const src = read(f).replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/prisma\.(order|review)\b/);
      expect(src, f).not.toMatch(/runInTenantContext\(/);
    }
  });
});
