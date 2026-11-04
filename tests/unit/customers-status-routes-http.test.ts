/**
 * Opus review of 7d03ec0cd, finding 4: the store-scoped customer status + deactivate routes (the only way to suspend a
 * customer that exists solely in its StoreDO). Real authorize / requireStoreAccess / rejectImpersonated / requirePermission.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  setCustomerStatus: vi.fn(),
  softDeleteCustomer: vi.fn(),
  revokeForAccount: vi.fn(),
  auditLog: vi.fn(),
  caller: {
    role: 'store_admin' as string,
    userId: 'admin-a',
    impersonatedBy: undefined as string | undefined,
  },
}));

vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@ebda/database')>();
  const prisma = { user: { findUnique: h.userFindUnique }, store: { findUnique: vi.fn() } };
  return {
    ...actual,
    prisma,
    // requireStoreAccess reads the store inside its own scope (`withStore`, strict RLS);
    // here the scoped client is the same fake, so the owner/customer fixtures below still decide.
    withStore: async (_storeId: string, fn: (tx: typeof prisma) => unknown) => fn(prisma),
  };
});

// authenticate is mocked to read the test-controlled caller identity.
// authorize / requireStoreAccess / rejectImpersonated are the REAL
// implementations from this same module — only authenticate itself is
// replaced, via importOriginal.
vi.mock('@api/middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/middleware/auth')>();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = {
        userId: h.caller.userId,
        role: h.caller.role,
        ...(h.caller.impersonatedBy ? { impersonatedBy: h.caller.impersonatedBy } : {}),
      };
      next();
    },
  };
});

// requireStoreAccess is left as the REAL middleware (imported by
// customers.routes.ts from a different module) — it reads prisma.store,
// which the mocked prisma above provides, keyed to admin-a owning store A
// and admin-b owning store B for every test below.

vi.mock('@api/services/auth.service', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/services/auth.service')>();
  return {
    ...actual,
    AuthService: {
      setCustomerStatus: h.setCustomerStatus,
      softDeleteCustomer: h.softDeleteCustomer,
    },
  };
});
vi.mock('@api/middleware/security', () => ({
  auditLog: h.auditLog,
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/lib/public-cache', () => ({
  getCached: vi.fn(),
  customersCacheKey: (storeId: string) => `customers:${storeId}`,
  invalidateCustomersCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/lib/wa/consent', () => ({ revokeForAccount: h.revokeForAccount }));
vi.mock('exceljs', () => ({ default: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_OF_A = '33333333-3333-4333-8333-333333333333';
const STAFF_OF_A = '44444444-4444-4444-8444-444444444444';

let app: Express;

beforeAll(async () => {
  const { default: customersRouter } = await import('@api/routes/customers.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/stores/:storeId', customersRouter);
  app.use(errorHandler);
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.caller = { role: 'store_admin', userId: 'admin-a', impersonatedBy: undefined };
  h.setCustomerStatus.mockResolvedValue(undefined);
  h.softDeleteCustomer.mockResolvedValue({ phone: '+201000000000' });
  const dbMock = await import('@ebda/database');
  (dbMock as any).prisma.store.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(
      where.id === STORE_A
        ? { id: STORE_A, ownerId: 'admin-a', name: 'Store A', status: 'active' }
        : where.id === STORE_B
          ? { id: STORE_B, ownerId: 'admin-b', name: 'Store B', status: 'active' }
          : null
    )
  );
  h.userFindUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(
      where.id === CUSTOMER_OF_A
        ? { id: CUSTOMER_OF_A, storeId: STORE_A, role: 'customer' }
        : where.id === STAFF_OF_A
          ? { id: STAFF_OF_A, storeId: STORE_A, role: 'staff' }
          : null
    )
  );
});

const status = (storeId: string, id: string, body: unknown) =>
  request(app)
    .put(`/api/v1/stores/${storeId}/customers/${id}/status`)
    .send(body as object);
const del = (storeId: string, id: string) =>
  request(app).delete(`/api/v1/stores/${storeId}/customers/${id}`);

describe('PUT /stores/:storeId/customers/:customerId/status', () => {
  it('owner suspends their own store customer: 200, one status call, audited', async () => {
    const res = await status(STORE_A, CUSTOMER_OF_A, { status: 'suspended' });
    expect(res.status).toBe(200);
    expect(h.setCustomerStatus).toHaveBeenCalledWith(CUSTOMER_OF_A, STORE_A, 'suspended');
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'customer.status.changed_by_merchant', storeId: STORE_A })
    );
  });
  it('refuses an impersonated session, staff, another store, a non-customer, an unknown id and a bad status', async () => {
    h.caller.impersonatedBy = 'super-1';
    expect((await status(STORE_A, CUSTOMER_OF_A, { status: 'suspended' })).status).toBe(403);
    h.caller = { role: 'staff', userId: 'staff-a', impersonatedBy: undefined };
    expect((await status(STORE_A, CUSTOMER_OF_A, { status: 'suspended' })).status).toBe(403);
    h.caller = { role: 'store_admin', userId: 'admin-a', impersonatedBy: undefined };
    expect(
      (await status(STORE_B, CUSTOMER_OF_A, { status: 'suspended' })).status
    ).toBeGreaterThanOrEqual(403);
    expect((await status(STORE_A, STAFF_OF_A, { status: 'suspended' })).status).toBe(404);
    expect(
      (await status(STORE_A, '55555555-5555-4555-8555-555555555555', { status: 'suspended' }))
        .status
    ).toBe(404);
    expect((await status(STORE_A, CUSTOMER_OF_A, { status: 'banned' })).status).toBe(400);
    expect(h.setCustomerStatus).not.toHaveBeenCalled();
  });
});

describe('DELETE /stores/:storeId/customers/:customerId', () => {
  it('deactivates, withdraws WhatsApp consent with the phone the DO returned, audits', async () => {
    const res = await del(STORE_A, CUSTOMER_OF_A);
    expect(res.status).toBe(200);
    expect(h.softDeleteCustomer).toHaveBeenCalledWith(CUSTOMER_OF_A, STORE_A);
    expect(h.revokeForAccount).toHaveBeenCalledWith(STORE_A, CUSTOMER_OF_A, '+201000000000');
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'customer.account.deleted_by_merchant' })
    );
  });
  it('same guards: impersonation, staff and a customer of another store are refused', async () => {
    h.caller.impersonatedBy = 'super-1';
    expect((await del(STORE_A, CUSTOMER_OF_A)).status).toBe(403);
    h.caller = { role: 'staff', userId: 'staff-a', impersonatedBy: undefined };
    expect((await del(STORE_A, CUSTOMER_OF_A)).status).toBe(403);
    h.caller = { role: 'store_admin', userId: 'admin-b', impersonatedBy: undefined };
    expect((await del(STORE_A, CUSTOMER_OF_A)).status).toBeGreaterThanOrEqual(403);
    expect(h.softDeleteCustomer).not.toHaveBeenCalled();
  });
});
