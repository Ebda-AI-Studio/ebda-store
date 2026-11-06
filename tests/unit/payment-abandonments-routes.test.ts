/**
 * Route-level tests for `payment-abandonments.routes.ts` — the Enterprise
 * payment-gateway-abandonment retargeting list (GitHub #1547: a
 * revenue-critical handler that no test file imported).
 *
 * NOTE ON SCOPE: the file exposes exactly two endpoints, `GET /` (the
 * paginated abandoners list) and `GET /stats` (the dashboard aggregate) —
 * there is no recovery/action/retry endpoint in this router (retargeting
 * itself happens out-of-band, via the admin's own outreach + the Inngest
 * `payment-abandonment-sweep` push notification; see that function's
 * header). This file tests the behaviour the route actually has: the list
 * shape (masked guest/customer contact, items), the stats aggregate, and
 * the failure paths that DO exist here — Zod query validation and the
 * `requireFeature` gate's fail-closed behaviour (its own middleware, tested
 * as the router wires it: the request never reaches the handler when the
 * feature is off or the check errors).
 *
 * Boots a minimal Express app mounting only `payment-abandonments.routes`
 * with the auth chain stubbed out, the same pattern as
 * `tests/unit/agent-credential-route.test.ts`. Only Prisma
 * (`@ebda/database`, including `runInTenantContext`), `authenticate`,
 * `authorize`, `requireStoreAccess` and `requireFeature` are mocked; the
 * masking helpers and response shaping run for real.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ─── Mocks (declared before the route module is dynamically imported) ─────

const { mockPrisma, mockRequireFeatureState } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
  },
  // Controls the stubbed `requireFeature` below — tests flip `.mode` to
  // exercise the enabled / disabled / errored branches the real middleware
  // would produce (`FEATURE_DISABLED` 403 either way; see feature-gate.ts).
  mockRequireFeatureState: { mode: 'enabled' as 'enabled' | 'disabled' | 'error' },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
}));

// NEON-ZERO: the route reads through `storeDb` (the `prisma` proxy for a Postgres store, mocked as the same object here) and
// attaches the shopper with `customersById` (Order -> User is a platform join a Durable Object order cannot do).
vi.mock('@api/lib/repo-factory', () => ({ storeDb: async () => mockPrisma }));
vi.mock('@api/lib/jobs/store-db', () => ({
  runInStoreCtx: (_storeId: string, fn: () => unknown) => fn(),
  customersById: async (_storeId: string, ids: Array<string | null>) =>
    new Map(
      ids
        .filter((id): id is string => id === 'cust-1')
        .map(id => [
          id,
          {
            id,
            firstName: 'Sara',
            lastName: 'Al-Fulan',
            email: 'sara@example.com',
            phone: '+965 9876 5432',
            language: null,
          },
        ])
    ),
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'staff-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

// Mirrors the REAL feature-gate's fail-closed contract (403 FEATURE_DISABLED
// on off/unresolvable/errored) without a real featureService/Redis call.
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: (_key: string) => (_req: any, res: any, next: any) => {
    if (mockRequireFeatureState.mode === 'enabled') {
      next();
      return;
    }
    res.status(403).json({
      success: false,
      error: 'Feature not available',
      code: 'FEATURE_DISABLED',
      feature: _key,
    });
  },
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── App bootstrap ──────────────────────────────────────────────────────────

let app: Express;
const STORE_ID = '11111111-1111-1111-1111-111111111111';
const BASE = `/api/v1/stores/${STORE_ID}/payment-abandonments`;

beforeAll(async () => {
  const { default: paymentAbandonmentsRouter } =
    await import('@api/routes/payment-abandonments.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  // mergeParams: true on the router — mounted directly on the same
  // `:storeId` path Express uses in routes/index.ts
  // (`/stores/:storeId/payment-abandonments`) so `req.params.storeId`
  // resolves identically.
  server.use('/api/v1/stores/:storeId/payment-abandonments', paymentAbandonmentsRouter);
  server.use(errorHandler);
  app = server;
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireFeatureState.mode = 'enabled';
});

function abandonedOrderRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'ORD-1001',
    status: 'pending',
    paymentStatus: 'pending',
    total: 1500,
    currency: 'EGP',
    paymentGatewayAbandonedAt: new Date('2026-09-20T10:00:00.000Z'),
    createdAt: new Date('2026-09-20T09:55:00.000Z'),
    shippingAddress: null,
    customer: {
      id: 'cust-1',
      firstName: 'Sara',
      lastName: 'Al-Fulan',
      email: 'sara@example.com',
      phone: '+965 9876 5432',
    },
    payments: [{ provider: 'kashier', paymentUrl: 'https://pay.tap.company/x', status: 'pending' }],
    items: [
      {
        id: 'item-1',
        productName: 'Abaya',
        variantName: 'Black / M',
        quantity: 1,
        price: 1500,
        total: 1500,
      },
    ],
    _count: { items: 1 },
    ...overrides,
    customerId: overrides.customer === null ? null : 'cust-1',
  };
}

// ─── GET / — masked contact, in any form ───────────────────────────────────

describe('GET /payment-abandonments — masked contact, never the raw value', () => {
  it('masks a registered customer contact to last-4 phone + domain-only email', async () => {
    mockPrisma.order.findMany.mockResolvedValue([abandonedOrderRow()]);
    mockPrisma.order.count.mockResolvedValue(1);

    const res = await request(app).get(BASE);

    expect(res.status).toBe(200);
    const row = res.body.data.abandoners[0];
    expect(row.customer.phoneMasked).toBe('***5432');
    expect(row.customer.emailMasked).toBe('***@example.com');
    expect(row.guestContact).toBeNull();
    // The full phone/email never leave the server in any field.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('9876 5432');
    expect(raw).not.toContain('sara@example.com');
  });

  it('derives + masks guest contact from shippingAddress when there is no customer', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      abandonedOrderRow({
        customer: null,
        shippingAddress: {
          firstName: 'Guest',
          lastName: 'Buyer',
          phone: '+965 5555 1234',
          email: 'guest@shop.example',
        },
      }),
    ]);
    mockPrisma.order.count.mockResolvedValue(1);

    const res = await request(app).get(BASE);

    expect(res.status).toBe(200);
    const row = res.body.data.abandoners[0];
    expect(row.customer).toBeNull();
    expect(row.guestContact.firstName).toBe('Guest');
    expect(row.guestContact.phoneMasked).toBe('***1234');
    expect(row.guestContact.emailMasked).toBe('***@shop.example');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('5555 1234');
    expect(raw).not.toContain('guest@shop.example');
  });

  it('shapes items + itemCount + gateway + pagination meta', async () => {
    mockPrisma.order.findMany.mockResolvedValue([abandonedOrderRow()]);
    mockPrisma.order.count.mockResolvedValue(1);

    const res = await request(app).get(BASE).query({ page: 1, limit: 25 });

    expect(res.status).toBe(200);
    const row = res.body.data.abandoners[0];
    expect(row.gateway).toBe('kashier');
    expect(row.itemCount).toBe(1);
    expect(row.items).toEqual([
      {
        id: 'item-1',
        productName: 'Abaya',
        variantName: 'Black / M',
        quantity: 1,
        price: 1500,
        total: 1500,
      },
    ]);
    expect(res.body.data.meta).toEqual({ page: 1, limit: 25, total: 1, totalPages: 1 });
  });

  it('rejects an out-of-range limit with a readable 400, not a 500', async () => {
    const res = await request(app).get(BASE).query({ limit: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.order.findMany).not.toHaveBeenCalled();
  });

  it('refuses the request when the Enterprise feature is off (fail-closed 403)', async () => {
    mockRequireFeatureState.mode = 'disabled';

    const res = await request(app).get(BASE);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(mockPrisma.order.findMany).not.toHaveBeenCalled();
  });

  it('refuses the request when the feature check itself errors — never optimistically open', async () => {
    mockRequireFeatureState.mode = 'error';

    const res = await request(app).get(BASE);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });
});

// ─── GET /stats — the dashboard aggregate ──────────────────────────────────

describe('GET /payment-abandonments/stats', () => {
  it('returns total/last7d/last30d/totalValue from the four parallel queries', async () => {
    mockPrisma.order.count
      .mockResolvedValueOnce(42) // total
      .mockResolvedValueOnce(5) // last7d
      .mockResolvedValueOnce(18); // last30d
    mockPrisma.order.aggregate.mockResolvedValue({ _sum: { total: 63000 } });

    const res = await request(app).get(`${BASE}/stats`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ total: 42, last7d: 5, last30d: 18, totalValue: 63000 });
  });

  it('reports totalValue: 0 rather than null when there are no abandoners yet', async () => {
    mockPrisma.order.count.mockResolvedValue(0);
    mockPrisma.order.aggregate.mockResolvedValue({ _sum: { total: null } });

    const res = await request(app).get(`${BASE}/stats`);

    expect(res.status).toBe(200);
    expect(res.body.data.totalValue).toBe(0);
  });

  it('refuses stats too when the feature is off', async () => {
    mockRequireFeatureState.mode = 'disabled';

    const res = await request(app).get(`${BASE}/stats`);

    expect(res.status).toBe(403);
    expect(mockPrisma.order.count).not.toHaveBeenCalled();
  });
});
