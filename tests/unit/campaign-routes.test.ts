/**
 * Email campaigns (D2) — admin + public routes.
 *
 * The feature gate is the REAL `requireFeature` middleware with only the
 * feature service mocked, so "feature off" here is the production code path:
 * every admin route answers 403 and nothing reaches Inngest or Resend.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import {
  createFakePrisma,
  storeRow,
  subscriberRow,
  uuid,
  STORE_A,
  type FakeDb,
} from '../helpers/campaign-fake-db';

const { holder, mocks } = vi.hoisted(() => {
  process.env.CAMPAIGN_UNSUBSCRIBE_SECRET = 'route-test-secret';
  return {
    holder: { prisma: null as any, role: 'store_admin' },
    mocks: {
      isFeatureEnabled: vi.fn(),
      inngestSend: vi.fn(),
      sendMarketingEmail: vi.fn(),
      authorizeArgs: [] as string[][],
      auditLog: vi.fn(),
    },
  };
});

vi.mock('@force/database', () => ({
  get prisma() {
    return holder.prisma;
  },
  // errorHandler does `instanceof Prisma.PrismaClient*Error`; distinct empty
  // classes keep those checks false instead of throwing on `undefined`.
  Prisma: {
    PrismaClientKnownRequestError: class PrismaKnown {},
    PrismaClientValidationError: class PrismaValidation {},
    PrismaClientUnknownRequestError: class PrismaUnknown {},
    PrismaClientInitializationError: class PrismaInit {},
    PrismaClientRustPanicError: class PrismaPanic {},
  },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));

// Load @force/shared from SOURCE so its schemas and the API's errorHandler
// share one `zod` instance. The package's CJS dist would `require('zod')` and
// hand vitest's ESM errorHandler a different ZodError class (instanceof false
// → 500). Production is CJS on both sides, so this is a test-harness concern.
vi.mock('@force/shared', async () => await import('../../packages/shared/src/index'));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: holder.role };
    next();
  },
  authorize: (...roles: string[]) => {
    mocks.authorizeArgs.push(roles);
    return (_req: any, _res: any, next: any) => next();
  },
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: mocks.auditLog,
  writeLimiter: (_req: any, _res: any, next: any) => next(),
  publicLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: mocks.isFeatureEnabled },
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: mocks.inngestSend } }));
vi.mock('@api/services/resend.service', () => ({
  ResendService: { sendMarketingEmail: mocks.sendMarketingEmail },
  ResendSendError: class extends Error {},
}));
vi.mock('@api/services/ai.service', () => ({
  AIService: { suggestCampaignDraft: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { signUnsubscribeToken } from '@api/lib/campaign-unsubscribe-token';

let app: Express;
let db: FakeDb;
const BASE = `/api/v1/stores/${STORE_A}/campaigns`;

beforeAll(async () => {
  const { default: campaignRoutes } = await import('@api/routes/campaign.routes');
  const { default: publicRoutes } = await import('@api/routes/campaign-public.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use(express.urlencoded({ extended: true }));
  server.use('/api/v1/stores/:storeId/campaigns', campaignRoutes);
  server.use('/api/v1/public/campaigns', publicRoutes);
  server.use(errorHandler);
  app = server;
});

function draft(extra: Record<string, unknown> = {}) {
  const row = {
    id: uuid(),
    storeId: STORE_A,
    name: 'Eid',
    subject: 'Eid sale',
    subjectAr: null,
    bodyHtml: '<p>Hi</p>',
    bodyHtmlAr: null,
    localeStrategy: 'subscriber',
    audience: { source: 'newsletter' },
    status: 'draft',
    scheduledAt: null,
    sentAt: null,
    recipientCount: 0,
    sentCount: 0,
    failedCount: 0,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
  db.campaigns.push(row);
  return row;
}

beforeEach(() => {
  db = {
    stores: [storeRow(STORE_A)],
    campaigns: [],
    recipients: [],
    subscribers: [subscriberRow(STORE_A, 'a@x.test'), subscriberRow(STORE_A, 'b@x.test')],
    customers: [],
    users: [{ id: 'admin-1', email: 'merchant@shop.test' }],
  };
  holder.prisma = createFakePrisma(db);
  holder.role = 'store_admin';
  mocks.isFeatureEnabled.mockReset().mockResolvedValue(true);
  mocks.inngestSend.mockReset().mockResolvedValue({ ids: ['evt'] });
  mocks.sendMarketingEmail.mockReset().mockResolvedValue({ id: 'msg-1' });
  delete process.env.CAMPAIGN_DAILY_SEND_CAP;
});

describe('feature OFF — every admin route is blocked and nothing sends', () => {
  it.each([
    ['get', ''],
    ['get', '/audience'],
    ['post', ''],
    ['post', '/ai-draft'],
    ['get', `/${'00000000-0000-4000-8000-000000000999'}`],
    ['put', `/${'00000000-0000-4000-8000-000000000999'}`],
    ['delete', `/${'00000000-0000-4000-8000-000000000999'}`],
    ['post', `/${'00000000-0000-4000-8000-000000000999'}/send`],
    ['post', `/${'00000000-0000-4000-8000-000000000999'}/test`],
    ['post', `/${'00000000-0000-4000-8000-000000000999'}/cancel`],
    ['get', `/${'00000000-0000-4000-8000-000000000999'}/recipients`],
  ])('%s %s → 403 FEATURE_DISABLED', async (method, path) => {
    mocks.isFeatureEnabled.mockResolvedValue(false);
    const res = await (request(app) as any)[method](`${BASE}${path}`).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(STORE_A, 'email_campaigns');
  });

  it('a send attempt on a real draft with the feature off enqueues and mails nothing', async () => {
    mocks.isFeatureEnabled.mockResolvedValue(false);
    const c = draft();
    await request(app).post(`${BASE}/${c.id}/send`).send({});
    await request(app).post(`${BASE}/${c.id}/test`).send({});
    expect(mocks.inngestSend).not.toHaveBeenCalled();
    expect(mocks.sendMarketingEmail).not.toHaveBeenCalled();
    expect(c.status).toBe('draft');
  });

  it('the router asks for store_admin or super_admin', () => {
    expect(mocks.authorizeArgs).toContainEqual(['store_admin', 'super_admin']);
  });
});

describe('feature ON', () => {
  it('create sanitizes the body before it is stored', async () => {
    const res = await request(app)
      .post(BASE)
      .send({ name: 'x', subject: 's', bodyHtml: '<p>ok</p><script>alert(1)</script>' });
    expect(res.status).toBe(201);
    expect(db.campaigns[0].bodyHtml).toBe('<p>ok</p>');
  });

  it('create rejects unknown keys (no smuggled status or storeId)', async () => {
    const res = await request(app).post(BASE).send({ name: 'x', status: 'sent' });
    expect(res.status).toBe(400);
    expect(db.campaigns).toHaveLength(0);
  });

  it('audience counts consented subscribers only', async () => {
    db.subscribers.push(subscriberRow(STORE_A, 'off@x.test', { isActive: false }));
    const res = await request(app).get(`${BASE}/audience`);
    expect(res.body.data).toMatchObject({ count: 2, dailyCap: 1000, remainingToday: 1000 });
  });

  it('send flips draft → scheduled and enqueues with the scheduledAt nonce; it sends nothing itself', async () => {
    const c = draft();
    const res = await request(app).post(`${BASE}/${c.id}/send`).send({});
    expect(res.status).toBe(202);
    expect(c.status).toBe('scheduled');
    expect(mocks.inngestSend).toHaveBeenCalledWith({
      name: 'campaign/send-requested',
      data: { campaignId: c.id, storeId: STORE_A, scheduledAt: c.scheduledAt.toISOString() },
    });
    expect(mocks.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('an enqueue failure answers 503 so the request transaction rolls the flip back', async () => {
    mocks.inngestSend.mockRejectedValue(new Error('inngest down'));
    const c = draft();
    const res = await request(app).post(`${BASE}/${c.id}/send`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CAMPAIGN_QUEUE_UNREACHABLE');
  });

  it('refuses a campaign that is not a draft', async () => {
    const c = draft({ status: 'sent' });
    const res = await request(app).post(`${BASE}/${c.id}/send`).send({});
    expect(res.status).toBe(409);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it('refuses when nobody has opted in', async () => {
    db.subscribers = [];
    holder.prisma = createFakePrisma(db);
    const c = draft();
    const res = await request(app).post(`${BASE}/${c.id}/send`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EMPTY_AUDIENCE');
  });

  it('refuses a send-now that would exceed the rolling 24h cap', async () => {
    process.env.CAMPAIGN_DAILY_SEND_CAP = '1';
    const c = draft();
    const res = await request(app).post(`${BASE}/${c.id}/send`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DAILY_CAP_EXCEEDED');
    expect(c.status).toBe('draft');
  });

  it('refuses a schedule in the past', async () => {
    const c = draft();
    const res = await request(app)
      .post(`${BASE}/${c.id}/send`)
      .send({ scheduledAt: new Date(Date.now() - 60_000).toISOString() });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_SCHEDULE');
  });

  it('test send goes to the signed-in admin ONLY, never to a body-supplied address', async () => {
    const c = draft({ subjectAr: 'عرض', bodyHtmlAr: '<p>مرحبا</p>' });
    const res = await request(app)
      .post(`${BASE}/${c.id}/test`)
      .send({ to: 'victim@elsewhere.test' });
    expect(res.status).toBe(200);
    const recipients = mocks.sendMarketingEmail.mock.calls.map(call => call[1].to);
    expect(recipients).toEqual(['merchant@shop.test', 'merchant@shop.test']);
    expect(db.recipients).toHaveLength(0);
  });

  it('edits are refused once a campaign left draft', async () => {
    const c = draft({ status: 'scheduled' });
    const res = await request(app).put(`${BASE}/${c.id}`).send({ name: 'y' });
    expect(res.status).toBe(409);
  });

  it('a campaign of another store is a 404', async () => {
    const c = draft({ storeId: '99999999-9999-4999-8999-999999999999' });
    const res = await request(app).get(`${BASE}/${c.id}/recipients`);
    expect(res.status).toBe(404);
  });
});

describe('public unsubscribe', () => {
  function sentRecipient() {
    const sub = db.subscribers[0];
    const r = {
      id: uuid(),
      campaignId: 'c',
      storeId: STORE_A,
      email: sub.email,
      subscriberId: sub.id,
      status: 'sent',
      sentAt: new Date(),
      unsubscribedAt: null,
    };
    db.recipients.push(r);
    return { r, sub };
  }

  it('GET validates only — it never unsubscribes (link scanners prefetch)', async () => {
    const { r, sub } = sentRecipient();
    const res = await request(app).get(
      `/api/v1/public/campaigns/unsubscribe?token=${signUnsubscribeToken(STORE_A, r.id)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('a***@x.test');
    expect(sub.isActive).toBe(true);
    expect(r.status).toBe('sent');
  });

  it('POST (RFC 8058 one-click form body) withdraws consent and records it', async () => {
    const { r, sub } = sentRecipient();
    const res = await request(app)
      .post(`/api/v1/public/campaigns/unsubscribe?token=${signUnsubscribeToken(STORE_A, r.id)}`)
      .type('form')
      .send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect(sub.isActive).toBe(false);
    expect(sub.unsubscribedAt).toBeInstanceOf(Date);
    expect(r.status).toBe('unsubscribed');
  });

  it('a tampered token changes nothing', async () => {
    const { r, sub } = sentRecipient();
    const token = signUnsubscribeToken(STORE_A, r.id);
    const res = await request(app)
      .post(`/api/v1/public/campaigns/unsubscribe?token=${token.slice(0, -2)}xx`)
      .send({});
    expect(res.status).toBe(400);
    expect(sub.isActive).toBe(true);
    expect(r.status).toBe('sent');
  });

  it('keeps working when the feature has since been turned off', async () => {
    mocks.isFeatureEnabled.mockResolvedValue(false);
    const { r, sub } = sentRecipient();
    const res = await request(app)
      .post(`/api/v1/public/campaigns/unsubscribe?token=${signUnsubscribeToken(STORE_A, r.id)}`)
      .send({});
    expect(res.status).toBe(200);
    expect(sub.isActive).toBe(false);
  });
});
