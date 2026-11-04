/**
 * Issue 2432 — a store time-zone change is filing-affecting (Ruling FRT-2: a period filed under the
 * old zone no longer re-runs identically), so `PUT /stores/:id` must leave an audit row saying who
 * changed it, from what, to what. Unchanged / absent zones must not write one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { auditLogMock, findUniqueMock, updateMock } = vi.hoisted(() => ({
  auditLogMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: auditLogMock }));
vi.mock('@api/services/store.service', () => ({
  StoreService: { update: (...a: unknown[]) => updateMock(...a) },
  bustStoreCaches: vi.fn(),
}));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, prisma: { store: { findUnique: findUniqueMock } } };
});

import storeRoutes from '@api/routes/store.routes';
import { errorHandler } from '@api/middleware/error-handler';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/stores', storeRoutes);
  a.use(errorHandler);
  return a;
}

describe('PUT /stores/:id audits a time-zone change (issue 2432)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue({ timezone: 'Africa/Cairo' });
    updateMock.mockResolvedValue({ id: 'store-1' });
    auditLogMock.mockResolvedValue(undefined);
  });

  it('writes STORE_TIMEZONE_CHANGED with from/to, actor and store', async () => {
    const res = await request(app()).put('/stores/store-1').send({ timezone: 'Europe/London' });
    expect(res.status).toBe(200);
    expect(auditLogMock).toHaveBeenCalledTimes(1);
    expect(auditLogMock.mock.calls[0][0]).toMatchObject({
      action: 'STORE_TIMEZONE_CHANGED',
      userId: 'user-1',
      storeId: 'store-1',
      resourceType: 'store',
      resourceId: 'store-1',
      details: { from: 'Africa/Cairo', to: 'Europe/London' },
    });
  });

  it('does not audit when the zone is re-saved unchanged', async () => {
    await request(app()).put('/stores/store-1').send({ timezone: 'Africa/Cairo' });
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it('does not audit (or even read the zone) when the request carries no timezone', async () => {
    const res = await request(app()).put('/stores/store-1').send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(auditLogMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('does not audit a rejected zone (422, nothing written)', async () => {
    const res = await request(app()).put('/stores/store-1').send({ timezone: 'Mars/Olympus' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });
});
