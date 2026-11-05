/**
 * Customer wallet routes (D1) — HTTP surface over a minimal Express app.
 *
 * The real `requireFeature` middleware runs (backed by a mocked
 * `featureService.isFeatureEnabled`), so "feature off" exercises the actual
 * gate wiring: every wallet route must refuse with 403 FEATURE_DISABLED and
 * never reach the service. That is the property that keeps the three live
 * stores unchanged after deploy — the feature is off for all of them.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn(),
  userFindFirst: vi.fn(),
  listWallets: vi.fn(),
  getCheckoutAvailability: vi.fn(),
  getBalance: vi.fn(),
  listTransactions: vi.fn(),
  adminAdjust: vi.fn(),
  auditLog: vi.fn(),
  role: { current: 'store_admin' as string },
}));

vi.mock('@ebda/database', () => ({
  prisma: { user: { findFirst: h.userFindFirst } },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = {
      userId: h.role.current === 'customer' ? 'cust-1' : 'admin-1',
      role: h.role.current,
      storeId: h.role.current === 'customer' ? '11111111-1111-4111-8111-111111111111' : null,
    };
    next();
  },
  authorize:
    (...roles: string[]) =>
    (req: any, res: any, next: any) =>
      roles.includes(req.user.role) ? next() : res.status(403).json({ code: 'FORBIDDEN' }),
  customerUserId: (req: any) => (req.user?.role === 'customer' ? req.user.userId : undefined),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: h.auditLog,
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: h.isFeatureEnabled },
}));
vi.mock('@api/services/wallet.service', () => ({
  WALLET_MAX_ENTRY_FILS: 100_000_000,
  storeCustomerWhere: (storeId: string, customerId: string) => ({
    id: customerId,
    role: 'customer',
    storeId,
  }),
  WalletService: {
    listWallets: h.listWallets,
    getCheckoutAvailability: h.getCheckoutAvailability,
    getBalance: h.getBalance,
    listTransactions: h.listTransactions,
    adminAdjust: h.adminAdjust,
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const STORE = '11111111-1111-4111-8111-111111111111';
const CUST = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';

let app: Express;
beforeAll(async () => {
  const { default: walletRouter } = await import('@api/routes/wallet.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/stores', walletRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  vi.clearAllMocks();
  h.role.current = 'store_admin';
  h.isFeatureEnabled.mockResolvedValue(true);
  h.userFindFirst.mockResolvedValue({ id: CUST });
  h.getBalance.mockResolvedValue(1500);
  h.getCheckoutAvailability.mockResolvedValue({ available: false, reason: 'checkout_feature_off' });
  h.listTransactions.mockResolvedValue({ transactions: [], nextCursor: null });
  h.listWallets.mockResolvedValue({
    wallets: [],
    nextCursor: null,
    summary: { outstandingTotal: 0, walletsWithBalance: 0 },
  });
  h.adminAdjust.mockResolvedValue({
    entry: { id: 'e1', amount: 500 },
    balance: 2000,
    replayed: false,
  });
});

const ADMIN_ROUTES: Array<[string, 'get' | 'post', object | undefined]> = [
  [`/api/v1/stores/${STORE}/wallets`, 'get', undefined],
  [`/api/v1/stores/${STORE}/customers/${CUST}/wallet`, 'get', undefined],
  [
    `/api/v1/stores/${STORE}/customers/${CUST}/wallet/adjustments`,
    'post',
    { amount: 500, note: 'goodwill', idempotencyKey: KEY },
  ],
];

const CUSTOMER_ROUTES = [
  `/api/v1/stores/public/${STORE}/wallet`,
  `/api/v1/stores/public/${STORE}/wallet/transactions`,
];

describe('feature gate — customer_wallet OFF (every store at deploy)', () => {
  beforeEach(() => h.isFeatureEnabled.mockResolvedValue(false));

  it.each(ADMIN_ROUTES)(
    'admin %s (%s) → 403 FEATURE_DISABLED, service untouched',
    async (path, method, body) => {
      const res = await (method === 'get'
        ? request(app).get(path)
        : request(app)
            .post(path)
            .send(body ?? {}));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FEATURE_DISABLED');
      expect(res.body.feature).toBe('customer_wallet');
      expect(h.listWallets).not.toHaveBeenCalled();
      expect(h.getBalance).not.toHaveBeenCalled();
      expect(h.adminAdjust).not.toHaveBeenCalled();
    }
  );

  it.each(CUSTOMER_ROUTES)('customer %s → 403 FEATURE_DISABLED', async path => {
    h.role.current = 'customer';
    const res = await request(app).get(path);
    expect(res.status).toBe(403);
    expect(res.body.feature).toBe('customer_wallet');
    expect(h.getBalance).not.toHaveBeenCalled();
    expect(h.listTransactions).not.toHaveBeenCalled();
  });

  it('checks the gate against the store in the URL', async () => {
    await request(app).get(`/api/v1/stores/${STORE}/wallets`);
    expect(h.isFeatureEnabled).toHaveBeenCalledWith(STORE, 'customer_wallet');
  });
});

describe('admin adjust', () => {
  const path = `/api/v1/stores/${STORE}/customers/${CUST}/wallet/adjustments`;

  it('credits, returns 201 and writes an audit row naming the actor, amount and note', async () => {
    const res = await request(app)
      .post(path)
      .send({ amount: 500, note: 'goodwill for late delivery', idempotencyKey: KEY });
    expect(res.status).toBe(201);
    expect(h.adminAdjust).toHaveBeenCalledWith({
      storeId: STORE,
      customerId: CUST,
      amount: 500,
      note: 'goodwill for late delivery',
      actorId: 'admin-1',
      requestKey: KEY,
    });
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'customer.wallet.adjusted',
        userId: 'admin-1',
        storeId: STORE,
        resourceId: CUST,
        details: expect.objectContaining({ amount: 500, note: 'goodwill for late delivery' }),
      })
    );
  });

  it('a replayed submit (same idempotency key) is a 200 and is NOT audited twice', async () => {
    h.adminAdjust.mockResolvedValue({ entry: { id: 'e1' }, balance: 2000, replayed: true });
    const res = await request(app).post(path).send({ amount: 500, note: 'x', idempotencyKey: KEY });
    expect(res.status).toBe(200);
    expect(res.body.data.replayed).toBe(true);
    expect(h.auditLog).not.toHaveBeenCalled();
  });

  it.each([
    [{ amount: 500, note: '', idempotencyKey: KEY }, 'empty note'],
    [{ amount: 500, note: '   ', idempotencyKey: KEY }, 'blank note'],
    [{ amount: 500, idempotencyKey: KEY }, 'missing note'],
    [{ amount: 0, note: 'x', idempotencyKey: KEY }, 'zero amount'],
    [{ amount: 1.5, note: 'x', idempotencyKey: KEY }, 'fractional piastres'],
    [{ amount: 500, note: 'x' }, 'missing idempotency key'],
  ])('rejects %j (%s) before touching the wallet', async (body, _label) => {
    const res = await request(app).post(path).send(body);
    expect(res.status).toBe(400);
    expect(h.adminAdjust).not.toHaveBeenCalled();
  });

  it('404s for a customer that is not a customer of this store', async () => {
    h.userFindFirst.mockResolvedValue(null);
    const res = await request(app).post(path).send({ amount: 500, note: 'x', idempotencyKey: KEY });
    expect(res.status).toBe(404);
    expect(h.userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: CUST, role: 'customer' }),
      })
    );
    expect(h.adminAdjust).not.toHaveBeenCalled();
  });

  it('is refused for staff (money write is owner/admin only)', async () => {
    h.role.current = 'staff';
    const res = await request(app).post(path).send({ amount: 500, note: 'x', idempotencyKey: KEY });
    expect(res.status).toBe(403);
    expect(h.adminAdjust).not.toHaveBeenCalled();
  });
});

describe('customer routes', () => {
  it('returns the caller’s own balance and whether it can be spent at checkout', async () => {
    h.role.current = 'customer';
    const res = await request(app).get(`/api/v1/stores/public/${STORE}/wallet`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ balance: 1500, checkoutAvailable: false });
    expect(h.getBalance).toHaveBeenCalledWith(STORE, 'cust-1');
  });

  it('refuses an admin token (shared cookie space) — no wallet keyed on an admin id', async () => {
    h.role.current = 'store_admin';
    const res = await request(app).get(`/api/v1/stores/public/${STORE}/wallet`);
    expect(res.status).toBe(403);
    expect(h.getBalance).not.toHaveBeenCalled();
  });

  it('history never exposes the merchant note, actor or idempotency key', async () => {
    h.role.current = 'customer';
    h.listTransactions.mockResolvedValue({
      transactions: [
        {
          id: 'e1',
          amount: 500,
          balanceAfter: 500,
          type: 'admin_adjust',
          createdAt: new Date('2026-09-25T00:00:00Z'),
          note: 'internal: customer shouted at driver',
          actorId: 'admin-1',
          idempotencyKey: 'admin-adjust:k',
          order: null,
          return: null,
        },
      ],
      nextCursor: null,
    });
    const res = await request(app).get(`/api/v1/stores/public/${STORE}/wallet/transactions`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('internal');
    expect(body).not.toContain('admin-1');
    expect(body).not.toContain('admin-adjust:k');
    expect(res.body.data.transactions[0]).toMatchObject({ amount: 500, type: 'admin_adjust' });
  });
});
