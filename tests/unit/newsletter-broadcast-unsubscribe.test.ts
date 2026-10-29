/**
 * Newsletter broadcast unsubscribe (Ruling NEWSLETTER-UNSUB-1): every legacy
 * broadcast email carries its own signed one-click link + RFC 8058 headers, and
 * the public endpoint unsubscribes idempotently and store-scoped.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import {
  createFakePrisma,
  storeRow,
  subscriberRow,
  STORE_A,
  STORE_B,
  type FakeDb,
} from '../helpers/campaign-fake-db';

const { holder, mocks } = vi.hoisted(() => {
  process.env.CAMPAIGN_UNSUBSCRIBE_SECRET = 'broadcast-test-secret';
  process.env.API_URL = 'https://api.ebda.test';
  return {
    holder: { prisma: null as any },
    mocks: { sendBrandedBatch: vi.fn() },
  };
});

vi.mock('@ebda/database', () => ({
  get prisma() {
    return holder.prisma;
  },
  Prisma: {
    PrismaClientKnownRequestError: class A {},
    PrismaClientValidationError: class B {},
    PrismaClientUnknownRequestError: class C {},
    PrismaClientInitializationError: class D {},
    PrismaClientRustPanicError: class E {},
  },
  runInTenantContext: async (_s: string, fn: () => unknown) => fn(),
  runInStoreScope: (_s: string, fn: () => unknown) => fn(),
  withStore: async (_s: string, fn: (tx: unknown) => unknown) => fn(holder.prisma),
  onClosedTenantTxAccess: () => undefined,
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@ebda/shared', async () => await import('../../packages/shared/src/index'));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn(),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
  publicLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/store-mailer.service', () => ({
  StoreMailer: { sendBrandedBatch: mocks.sendBrandedBatch },
  EmailSendError: class extends Error {},
}));
vi.mock('@api/services/email.service', async importOriginal => ({
  ...(await importOriginal<any>()),
  storeHidesPoweredBy: async () => false,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  signSubscriberUnsubscribeToken,
  verifySubscriberUnsubscribeToken,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '@api/lib/campaign-unsubscribe-token';

let app: Express;
let db: FakeDb;

beforeAll(async () => {
  const { default: newsletterRoutes } = await import('@api/routes/newsletter.routes');
  const { default: publicRoutes } = await import('@api/routes/campaign-public.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use(express.urlencoded({ extended: true }));
  server.use('/api/v1/stores', newsletterRoutes);
  server.use('/api/v1/public/campaigns', publicRoutes);
  server.use(errorHandler);
  app = server;
});

beforeEach(() => {
  db = {
    stores: [storeRow(STORE_A), storeRow(STORE_B)],
    campaigns: [],
    recipients: [],
    subscribers: [
      subscriberRow(STORE_A, 'en@x.test', { language: 'en' }),
      subscriberRow(STORE_A, 'ar@x.test', { language: 'ar' }),
      subscriberRow(STORE_B, 'other@x.test'),
    ],
    customers: [],
    users: [],
  };
  holder.prisma = createFakePrisma(db);
  mocks.sendBrandedBatch.mockReset().mockResolvedValue({ ids: [] });
});

async function broadcast() {
  const res = await request(app)
    .post(`/api/v1/stores/${STORE_A}/newsletter/broadcast`)
    .send({ subject: 'Sale', html: '<p>Hello</p>', text: 'Hello' });
  expect(res.status).toBe(200);
  return mocks.sendBrandedBatch.mock.calls.flatMap(c => c[1].messages) as Array<{
    to: string;
    html: string;
    text?: string;
    headers?: Record<string, string>;
  }>;
}

describe('broadcast emails', () => {
  it('every email has its own unsubscribe link, text line and RFC 8058 headers', async () => {
    const msgs = await broadcast();
    expect(msgs.map(m => m.to).sort()).toEqual(['ar@x.test', 'en@x.test']);
    for (const m of msgs) {
      const sub = db.subscribers.find(s => s.email === m.to)!;
      const token = signSubscriberUnsubscribeToken(STORE_A, sub.id);
      expect(m.html).toContain(encodeURIComponent(token));
      expect(m.text).toContain(encodeURIComponent(token));
      expect(m.headers?.['List-Unsubscribe']).toContain(encodeURIComponent(token));
      expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    }
    // links differ per subscriber
    expect(msgs[0].headers!['List-Unsubscribe']).not.toBe(msgs[1].headers!['List-Unsubscribe']);
  });

  it('footer is Arabic for an ar subscriber and English otherwise', async () => {
    const msgs = await broadcast();
    expect(msgs.find(m => m.to === 'ar@x.test')!.html).toContain('إلغاء الاشتراك');
    const en = msgs.find(m => m.to === 'en@x.test')!.html;
    expect(en).toContain('Unsubscribe');
    expect(en).not.toContain('إلغاء الاشتراك');
  });

  it('only this store subscribers are mailed', async () => {
    const msgs = await broadcast();
    expect(msgs.map(m => m.to)).not.toContain('other@x.test');
  });
});

describe('subscriber unsubscribe token', () => {
  it('round-trips, and is never interchangeable with a campaign token', () => {
    const id = db.subscribers[0].id;
    const t = signSubscriberUnsubscribeToken(STORE_A, id);
    expect(verifySubscriberUnsubscribeToken(t)).toEqual({ storeId: STORE_A, subscriberId: id });
    expect(verifyUnsubscribeToken(t)).toBeNull();
    expect(verifySubscriberUnsubscribeToken(signUnsubscribeToken(STORE_A, id))).toBeNull();
    expect(verifySubscriberUnsubscribeToken(t.slice(0, -2) + 'xx')).toBeNull();
  });
});

describe('public unsubscribe for broadcast tokens', () => {
  const url = (t: string) => `/api/v1/public/campaigns/unsubscribe?token=${encodeURIComponent(t)}`;

  it('GET never unsubscribes; POST does, and is idempotent', async () => {
    const sub = db.subscribers[0];
    const t = signSubscriberUnsubscribeToken(STORE_A, sub.id);
    const g = await request(app).get(url(t));
    expect(g.status).toBe(200);
    expect(sub.isActive).toBe(true);

    const p1 = await request(app).post(url(t)).type('form').send('List-Unsubscribe=One-Click');
    expect(p1.status).toBe(200);
    expect(sub.isActive).toBe(false);
    const firstStamp = sub.unsubscribedAt;
    const p2 = await request(app).post(url(t)).send({});
    expect(p2.status).toBe(200);
    expect(p2.body.data.unsubscribed).toBe(true);
    expect(sub.unsubscribedAt).toBe(firstStamp);
  });

  it('is store-scoped: a token for store A cannot touch store B subscriber', async () => {
    const other = db.subscribers[2];
    const forged = signSubscriberUnsubscribeToken(STORE_A, other.id);
    const res = await request(app).post(url(forged)).send({});
    expect(res.status).toBe(404);
    expect(other.isActive).toBe(true);
  });

  it('a tampered token changes nothing', async () => {
    const sub = db.subscribers[0];
    const t = signSubscriberUnsubscribeToken(STORE_A, sub.id);
    const res = await request(app)
      .post(url(t.slice(0, -2) + 'xx'))
      .send({});
    expect(res.status).toBe(400);
    expect(sub.isActive).toBe(true);
  });
});
