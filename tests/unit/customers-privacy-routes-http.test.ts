/**
 * #1873 — HTTP-level coverage for the merchant-initiated customer
 * erase/export routes (`POST/GET /stores/:storeId/customers/:customerId/
 * {erase,export}`).
 *
 * `tests/integration/customer-privacy-cross-tenant.test.ts` calls
 * `resolveStoreCustomerOrThrow` directly — it proves the resolver's own
 * logic but never sends an HTTP request, so nothing exercised
 * `authorize`/`requireStoreAccess`/`rejectImpersonated` actually being
 * MOUNTED on these routes (the same "guard exists but nothing proves it's
 * wired" gap `reject-impersonated.test.ts`'s own docstring calls out).
 *
 * This file mounts the REAL router (supertest, matching wallet-routes.test.ts
 * / order-refund-route.test.ts's pattern) with only the identity of the
 * caller mocked — `authenticate` reads the role/impersonation flag the test
 * sets, everything downstream (`authorize`, `requireStoreAccess`,
 * `rejectImpersonated`) is the REAL middleware. A stubbed `rejectImpersonated`
 * would make every assertion below pass against an unguarded route.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  eraseAccount: vi.fn(),
  exportAccount: vi.fn(),
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
    AuthService: { eraseAccount: h.eraseAccount, exportAccount: h.exportAccount },
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
  h.eraseAccount.mockResolvedValue({ crmChecked: false, crmRowsScrubbed: 0, crmAmbiguous: false });
  h.exportAccount.mockResolvedValue({ account: {} });

  const dbMock = await import('@ebda/database');
  // requireStoreAccess: admin-a owns store A only.
  (dbMock as any).prisma.store.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(
      where.id === STORE_A
        ? { id: STORE_A, ownerId: 'admin-a', name: 'Store A', status: 'active' }
        : where.id === STORE_B
          ? { id: STORE_B, ownerId: 'admin-b', name: 'Store B', status: 'active' }
          : null
    )
  );
  // resolveStoreCustomerOrThrow: CUSTOMER_OF_A belongs to store A; STAFF_OF_A
  // is a staff row on store A (must still 404 — customer-only).
  h.userFindUnique.mockImplementation(({ where }: any) => {
    if (where.id === CUSTOMER_OF_A) {
      return Promise.resolve({ id: CUSTOMER_OF_A, storeId: STORE_A, role: 'customer' });
    }
    if (where.id === STAFF_OF_A) {
      return Promise.resolve({ id: STAFF_OF_A, storeId: STORE_A, role: 'staff' });
    }
    return Promise.resolve(null);
  });
});

const erase = (storeId: string, customerId: string) =>
  request(app).post(`/api/v1/stores/${storeId}/customers/${customerId}/erase`);
const exportRoute = (storeId: string, customerId: string) =>
  request(app).get(`/api/v1/stores/${storeId}/customers/${customerId}/export`);

describe('POST /stores/:storeId/customers/:customerId/erase — HTTP surface', () => {
  it('owning admin: 200, erases, audits', async () => {
    const res = await erase(STORE_A, CUSTOMER_OF_A);
    expect(res.status).toBe(200);
    // Ruling W-7: a merchant erasure is scoped to its own store and names the actor.
    expect(h.eraseAccount).toHaveBeenCalledWith(CUSTOMER_OF_A, {
      scopeStoreId: STORE_A,
      actorId: 'admin-a',
      storeHint: STORE_A,
    });
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'customer.account.erased_by_merchant' })
    );
  });

  it('staff: 403 — privacyMiddleware excludes staff from this route entirely', async () => {
    h.caller.role = 'staff';
    const res = await erase(STORE_A, CUSTOMER_OF_A);
    expect(res.status).toBe(403);
    expect(h.eraseAccount).not.toHaveBeenCalled();
  });

  it('other-store admin: 403 — requireStoreAccess refuses before the customer resolver runs', async () => {
    h.caller = { role: 'store_admin', userId: 'admin-b', impersonatedBy: undefined };
    const res = await erase(STORE_A, CUSTOMER_OF_A);
    expect(res.status).toBe(403); // requireStoreAccess: not this store's owner
    expect(h.eraseAccount).not.toHaveBeenCalled();
  });

  it("cross-tenant customer id (own store, someone else's customer): 404, never erases", async () => {
    // admin-b legitimately owns store B, but points the id at store A's customer.
    h.caller = { role: 'store_admin', userId: 'admin-b', impersonatedBy: undefined };
    const res = await erase(STORE_B, CUSTOMER_OF_A);
    expect(res.status).toBe(404);
    expect(h.eraseAccount).not.toHaveBeenCalled();
  });

  it('impersonation: 403 IMPERSONATION_FORBIDDEN from the REAL rejectImpersonated, never erases', async () => {
    h.caller = { role: 'store_admin', userId: 'admin-a', impersonatedBy: 'super-admin-9' };
    const res = await erase(STORE_A, CUSTOMER_OF_A);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'IMPERSONATION_FORBIDDEN' } });
    expect(h.eraseAccount).not.toHaveBeenCalled();
  });

  it('a staff/admin account id (not a customer): 404, never erases', async () => {
    const res = await erase(STORE_A, STAFF_OF_A);
    expect(res.status).toBe(404);
    expect(h.eraseAccount).not.toHaveBeenCalled();
  });
});

describe('GET /stores/:storeId/customers/:customerId/export — HTTP surface', () => {
  it('owning admin: 200, exports, audits', async () => {
    const res = await exportRoute(STORE_A, CUSTOMER_OF_A);
    expect(res.status).toBe(200);
    expect(h.exportAccount).toHaveBeenCalledWith(CUSTOMER_OF_A, STORE_A);
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'customer.data.exported_by_merchant' })
    );
  });

  it('staff: 403, never exports', async () => {
    h.caller.role = 'staff';
    const res = await exportRoute(STORE_A, CUSTOMER_OF_A);
    expect(res.status).toBe(403);
    expect(h.exportAccount).not.toHaveBeenCalled();
  });

  it('other-store admin: 403 (requireStoreAccess), never exports', async () => {
    h.caller = { role: 'store_admin', userId: 'admin-b', impersonatedBy: undefined };
    const res = await exportRoute(STORE_A, CUSTOMER_OF_A);
    expect(res.status).toBe(403);
    expect(h.exportAccount).not.toHaveBeenCalled();
  });

  it('impersonation: 403 IMPERSONATION_FORBIDDEN, never exports the PII bundle', async () => {
    h.caller = { role: 'store_admin', userId: 'admin-a', impersonatedBy: 'super-admin-9' };
    const res = await exportRoute(STORE_A, CUSTOMER_OF_A);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'IMPERSONATION_FORBIDDEN' } });
    expect(h.exportAccount).not.toHaveBeenCalled();
  });
});
