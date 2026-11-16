/**
 * G18 route contract for GET /stores/:storeId/ai/bulk/estimate, through the REAL ai router with the REAL `authorize` and
 * `requireStoreAccess` (only the identity, the access-gate data and the usage counts are faked):
 *   no identity -> 401; a store admin or staff member asking for ANOTHER store -> 403; an unknown store -> 404;
 *   the owner -> 200 with only that store's numbers (no platform-wide counters).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  stores: {} as Record<string, { ownerId: string; products: number; used: number }>,
  staff: new Set<string>(),
  countedStores: [] as string[],
}));

vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@api/middleware/auth', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/auth')>('@api/middleware/auth');
  const { AppError } = await vi.importActual<typeof import('@api/middleware/error-handler')>(
    '@api/middleware/error-handler'
  );
  return {
    ...real,
    authenticate: (req: any, _res: any, next: any) => {
      const who = req.header('x-test-user');
      if (!who) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      const [userId, role] = who.split(':');
      req.user = { userId, role };
      next();
    },
  };
});
vi.mock('@api/services/platform/access-d1', () => ({
  onAccessD1: async () => true,
  gateRead: async (storeId: string, userId: string) => {
    const s = h.stores[storeId];
    if (!s) return null;
    return {
      store: {
        id: storeId,
        ownerId: s.ownerId,
        name: 'n',
        status: 'active',
        billingSuspendedReason: null,
      },
      isStaff: h.staff.has(`${storeId}:${userId}`),
    };
  },
}));
vi.mock('@api/middleware/security', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/security')>(
    '@api/middleware/security'
  );
  return { ...real, auditLog: vi.fn(), writeLimiter: (_q: any, _s: any, n: any) => n() };
});
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  assertStoreAiEnabled: async () => undefined,
  isStoreAiEnabled: async () => true,
  requireAiEnabled: (_q: any, _s: any, n: any) => n(),
  setStoreAiEnabled: vi.fn(),
}));
vi.mock('@ebda/database', async () => {
  const real = await vi.importActual<typeof import('@ebda/database')>('@ebda/database');
  return {
    ...real,
    currentStoreId: () => 'ambient',
    prisma: {
      aiUsage: {
        count: async ({ where }: any) => {
          h.countedStores.push(where.storeId);
          return h.stores[where.storeId]?.used ?? 0;
        },
      },
    },
  };
});
vi.mock('@api/lib/definer', () => ({ countAiUsage: async () => 100 }));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    product: { count: async ({ where }: any) => h.stores[where.storeId]?.products ?? 0 },
  }),
  storeWriter: async () => ({}),
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/services/ai.service', () => ({ AIService: {} }));
vi.mock('@api/services/ai-autofill.service', () => ({
  fillProductFields: vi.fn(),
  balanceProductLanguages: vi.fn(),
  revertProductBalance: vi.fn(),
}));
vi.mock('@api/lib/ai/product-faq-generator', () => ({ generateProductFaqs: vi.fn() }));

let app: Express;
beforeAll(async () => {
  h.stores[A] = { ownerId: 'owner-a', products: 40, used: 10 };
  h.stores[B] = { ownerId: 'owner-b', products: 7, used: 0 };
  h.staff.add(`${A}:staff-a`);
  const { default: router } = await import('@api/routes/ai.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores/:storeId/ai', router);
  app.use(errorHandler as any);
});

const get = (storeId: string, who?: string, kind = 'tags') => {
  const r = request(app).get(`/stores/${storeId}/ai/bulk/estimate?kind=${kind}`);
  return who ? r.set('x-test-user', who) : r;
};

describe('GET /stores/:storeId/ai/bulk/estimate', () => {
  it('no identity: 401', async () => {
    expect((await get(A)).status).toBe(401);
  });

  it("a store admin asking for another owner's store: 403", async () => {
    expect((await get(B, 'owner-a:store_admin')).status).toBe(403);
  });

  it('staff of store A asking for store B: 403', async () => {
    expect((await get(B, 'staff-a:staff')).status).toBe(403);
  });

  it('a customer: 403', async () => {
    expect((await get(A, 'someone:customer')).status).toBe(403);
  });

  it('an unknown store: 404', async () => {
    expect((await get(MISSING, 'owner-a:store_admin')).status).toBe(404);
  });

  it('the owner gets 200 with only that store, and no platform-wide counters', async () => {
    h.countedStores.length = 0;
    const res = await get(A, 'owner-a:store_admin');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      kind: 'tags',
      products: 40,
      requests: 40,
      remaining: 140,
      limitedBy: 'store_daily',
      aiEnabled: true,
      canStart: true,
      fits: true,
    });
    // the per-store count was asked for store A only (never B); the platform definer's 100 used never reaches the body
    expect(h.countedStores.every(s => s === A)).toBe(true);
    expect(Object.keys(res.body.data).sort()).toEqual(
      [
        'aiEnabled',
        'canStart',
        'fits',
        'kind',
        'limitedBy',
        'products',
        'remaining',
        'requests',
      ].sort()
    );
  });

  it('this router is for store admins and super admins: even its own staff are refused; an unknown kind is 400', async () => {
    expect((await get(A, 'staff-a:staff')).status).toBe(403);
    expect((await get(A, 'owner-a:store_admin', 'nope')).status).toBe(400);
    expect((await get(B, 'root:super_admin')).status).toBe(200);
  });
});
