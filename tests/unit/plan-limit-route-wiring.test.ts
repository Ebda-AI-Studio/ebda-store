/**
 * SP5 task 1 — the staff-invite and custom-domain routes call the plan guard
 * BEFORE any write / provider call, and surface its 402 PLAN_LIMIT_REACHED
 * (bilingual details) unchanged. The counting + 402 logic itself is proven
 * against a real DB in tests/integration/plan-limits.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { guard, userCreate, addDomain } = vi.hoisted(() => ({
  guard: vi.fn(),
  userCreate: vi.fn(),
  addDomain: vi.fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
  requireRecentLogin: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_req: any, _res: any, next: any) => next(),
  storeScopeContext: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@api/services/plan-limit.service', () => ({ assertWithinLimit: guard }));
vi.mock('@api/services/store.service', () => ({
  StoreService: {
    getById: vi.fn().mockResolvedValue({ id: 'store-1', domain: null }),
    getByDomain: vi.fn().mockRejectedValue(new Error('none')),
  },
  bustStoreCaches: vi.fn(),
}));
vi.mock('@api/services/domain-provider', () => ({
  resolveDomainService: () => ({
    isConfigured: () => true,
    providerName: 'cloudflare',
    addDomain,
  }),
}));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    prisma: {
      store: {
        findUnique: vi.fn().mockResolvedValue({ emailDomainId: null }),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    withRlsBypass: async (fn: (tx: unknown) => unknown) =>
      fn({
        user: { findFirst: vi.fn().mockResolvedValue(null), create: userCreate },
        storeStaff: { findUnique: vi.fn(), create: vi.fn() },
      }),
  };
});

import { AppError, errorHandler } from '@api/middleware/error-handler';
import staffRoutes from '@api/routes/staff.routes';
import storeRoutes from '@api/routes/store.routes';

function limitErr(key: string) {
  return new AppError(402, 'PLAN_LIMIT_REACHED', 'limit', {
    limitKey: key,
    messageKey: `planLimit.${key}`,
    messageEn: 'en',
    messageAr: 'ar',
  });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/stores/:storeId/staff', staffRoutes);
  a.use('/stores', storeRoutes);
  a.use(errorHandler);
  return a;
}

beforeEach(() => vi.clearAllMocks());

describe('POST /stores/:storeId/staff', () => {
  const body = { email: 'a@b.co', firstName: 'A', lastName: 'B' };

  it('checks maxStaff and 402s BEFORE creating any user', async () => {
    guard.mockRejectedValueOnce(limitErr('maxStaff'));
    const res = await request(app()).post('/stores/store-1/staff').send(body);
    expect(guard).toHaveBeenCalledWith('store-1', 'maxStaff');
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(res.body.error.details.messageKey).toBe('planLimit.maxStaff');
    expect(userCreate).not.toHaveBeenCalled();
  });
});

describe('PUT /stores/:id/domain', () => {
  it('checks customDomain and 402s BEFORE touching the domain provider', async () => {
    guard.mockRejectedValueOnce(limitErr('customDomain'));
    const res = await request(app())
      .put('/stores/store-1/domain')
      .send({ domain: 'shop.example.com' });
    expect(guard).toHaveBeenCalledWith('store-1', 'customDomain');
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(addDomain).not.toHaveBeenCalled();
  });

  it('does not gate removing a domain (null)', async () => {
    const res = await request(app()).put('/stores/store-1/domain').send({ domain: null });
    expect(guard).not.toHaveBeenCalled();
    expect(res.status).not.toBe(402);
  });
});
