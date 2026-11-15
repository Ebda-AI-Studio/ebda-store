/**
 * A suspended store's admin must still reach the appeal route: authenticate -> authorize -> the REAL requireStoreAccess
 * (the only store-level gate on the chain) let a policy-suspended store through. A billing over-limit suspension is
 * read-only for normal writes (402) and cannot be appealed (409), which is the same end state the banner explains.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const UUID = '11111111-1111-4111-8111-111111111111';
const m = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  rows: [] as Record<string, any>[],
}));

const fakePrisma = {
  trustRequest: {
    create: async ({ data }: any) => {
      const r = { id: 't1', status: 'open', createdAt: new Date(), ...data };
      m.rows.push(r);
      return r;
    },
    findFirst: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  },
  store: { findUnique: async () => m.store },
};
vi.mock('@ebda/database', async () => {
  const real = await vi.importActual<typeof import('@ebda/database')>('@ebda/database');
  return {
    ...real,
    prisma: fakePrisma,
    withStore: async (_id: string, fn: (tx: any) => unknown) => fn(fakePrisma),
    withUser: async (_u: string, fn: (tx: any) => unknown) => fn(fakePrisma),
  };
});
vi.mock('@api/services/platform/access-d1', () => ({ onAccessD1: async () => false }));
vi.mock('@api/lib/ci/emit', () => ({ sendOnboardingHelpToCi: vi.fn() }));
vi.mock('@api/middleware/auth', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/auth')>('@api/middleware/auth');
  return {
    ...real,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: 'owner-1', email: 'o@example.com', role: 'store_admin' };
      next();
    },
  };
});
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/security', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/security')>(
    '@api/middleware/security'
  );
  return {
    ...real,
    auditLog: vi.fn(async () => undefined),
    writeLimiter: (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: async (_n: string, run: () => Promise<unknown>) => run(),
}));
vi.mock('@api/services/email-queue.service', () => ({ emailQueue: { enqueue: vi.fn() } }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: async () => undefined }));

let app: Express;
beforeAll(async () => {
  const support = (await import('@api/routes/support.routes')).default;
  const { requireStoreAccess } = await import('@api/middleware/store-access');
  const { authenticate } = await import('@api/middleware/auth');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores', support);
  // a normal merchant write route behind the same store gate every /stores/:storeId/* route uses
  app.post('/stores/:storeId/products', authenticate, requireStoreAccess, (_q, s) =>
    s.json({ success: true })
  );
  app.use(errorHandler as any);
});
beforeEach(() => {
  m.rows.length = 0;
});

describe('suspended store admin', () => {
  it('policy suspension: passes the store gate and reaches the appeal route (201, row stored)', async () => {
    m.store = {
      id: UUID,
      ownerId: 'owner-1',
      name: 'S',
      status: 'suspended',
      billingSuspendedReason: null,
    };
    const res = await request(app)
      .post(`/stores/${UUID}/suspension/appeal`)
      .send({ message: 'These are my own products.' });
    expect(res.status).toBe(201);
    expect(m.rows).toHaveLength(1);
  });

  it('over-limit (billing) suspension: normal write is 402 and the appeal is refused (409 billing)', async () => {
    m.store = {
      id: UUID,
      ownerId: 'owner-1',
      name: 'S',
      status: 'suspended',
      billingSuspendedReason: 'over_store_limit',
    };
    const write = await request(app).post(`/stores/${UUID}/products`).send({});
    expect(write.status).toBe(402);
    expect(write.body.error.code).toBe('STORE_OVER_PLAN_LIMIT');
    const appeal = await request(app)
      .post(`/stores/${UUID}/suspension/appeal`)
      .send({ message: 'x' });
    expect([402, 409]).toContain(appeal.status);
    expect(m.rows).toHaveLength(0);
  });

  it("someone else's store: 403 on the appeal route", async () => {
    m.store = {
      id: UUID,
      ownerId: 'other',
      name: 'S',
      status: 'suspended',
      billingSuspendedReason: null,
    };
    expect(
      (await request(app).post(`/stores/${UUID}/suspension/appeal`).send({ message: 'x' })).status
    ).toBe(403);
  });
});
