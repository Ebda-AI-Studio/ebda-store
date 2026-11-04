/**
 * Regression for #1036: GET /usage/log omitted model/costMicros/subjectType/
 * subjectId (recorded on every AiUsage row but never surfaced), and
 * GET /usage/summary only ever counted rows — no SUM(cost_micros) — so
 * there was no cost figure anywhere for a merchant or super_admin to read.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    aiUsage: { count: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  isStoreAiEnabled: async () => true,
  assertStoreAiEnabled: async () => undefined,
  requireAiEnabled: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/security', () => ({
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

let app: Express;

async function buildApp(): Promise<Express> {
  const { default: aiRouter } = await import('@api/routes/ai.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/stores/:storeId/ai', aiRouter);
  server.use(errorHandler);
  return server;
}

const STORE_ID = '11111111-1111-1111-1111-111111111111';

describe('GET /usage/log (#1036)', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(() => vi.clearAllMocks());

  it('selects model, costMicros, subjectType, subjectId on every row', async () => {
    mockPrisma.aiUsage.findMany.mockResolvedValue([]);
    mockPrisma.aiUsage.count.mockResolvedValue(0);

    await request(app).get(`/api/v1/stores/${STORE_ID}/ai/usage/log`);

    const call = mockPrisma.aiUsage.findMany.mock.calls[0][0];
    expect(call.select).toMatchObject({
      model: true,
      costMicros: true,
      subjectType: true,
      subjectId: true,
    });
  });
});

describe('GET /usage/summary (#1036)', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(() => vi.clearAllMocks());

  // Ruling NZ-AN-1: no raw SQL; cost is aggregate(_sum.costMicros), unpriced is count({costMicros: null})
  const priced = (opts: { today: number | null; month: number | null; unpriced: number }) => {
    mockPrisma.aiUsage.count.mockImplementation(async (a: { where: { costMicros?: null } }) =>
      a.where.costMicros === null ? opts.unpriced : 10
    );
    mockPrisma.aiUsage.aggregate
      .mockResolvedValueOnce({ _sum: { costMicros: opts.today } })
      .mockResolvedValueOnce({ _sum: { costMicros: opts.month } });
    mockPrisma.aiUsage.findMany.mockResolvedValue([]); // last30Days
  };

  it('returns a cost figure (SUM of cost_micros), not just a call count', async () => {
    priced({ today: 1500000, month: 45000000, unpriced: 2 });

    const res = await request(app).get(`/api/v1/stores/${STORE_ID}/ai/usage/summary`);

    expect(res.status).toBe(200);
    expect(res.body.data.todayCostMicros).toBe(1500000);
    expect(res.body.data.todayUnpricedCount).toBe(2);
    expect(res.body.data.monthCostMicros).toBe(45000000);
    expect(res.body.data.monthUnpricedCount).toBe(2);
  });

  it('reports cost as null (not 0) when nothing in the window has a configured rate', async () => {
    priced({ today: null, month: null, unpriced: 3 });

    const res = await request(app).get(`/api/v1/stores/${STORE_ID}/ai/usage/summary`);

    expect(res.body.data.todayCostMicros).toBeNull();
    expect(res.body.data.todayUnpricedCount).toBe(3);
  });
});
