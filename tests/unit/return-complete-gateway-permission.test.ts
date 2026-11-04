/**
 * Issue 2024 — `POST /stores/:storeId/returns/admin/:id/complete` gated only
 * on `returns:write`, which staff hold, while a gateway refund method reaches
 * `PaymentService.refund` — a real, irreversible the gateway refund.
 * Staff deliberately lack `orders:refund` (rbac.ts), so a gateway completion
 * now also requires it; non-gateway methods (store credit, bank transfer,
 * cash, manual) record money only and stay open to `returns:write`. The
 * refund preview tells the modal up front, so staff see the option disabled
 * with a reason instead of a 403 after confirming.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { state, mockComplete, mockPreview } = vi.hoisted(() => ({
  state: { role: 'staff' as string },
  mockComplete: vi.fn(),
  mockPreview: vi.fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u-1', role: state.role };
    next();
  },
  customerUserId: () => null,
  rejectImpersonated: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: vi.fn().mockResolvedValue(true),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/return.service', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ReturnService: { complete: mockComplete, refundPreview: mockPreview },
  };
});

import returnRoutes from '@api/routes/return.routes';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/stores/:storeId/returns', returnRoutes);
  return a;
}

const COMPLETE = '/stores/store-1/returns/admin/ret-1/complete';
const PREVIEW = '/stores/store-1/returns/admin/ret-1/refund-preview';

describe('returns complete — gateway refunds need orders:refund (issue 2024)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComplete.mockResolvedValue({ id: 'ret-1', status: 'completed' });
    mockPreview.mockResolvedValue({
      gateway: {
        available: true,
        amount: 5000,
        refundableRemaining: 5000,
        unavailableReason: null,
      },
    });
  });

  it('refuses staff a gateway method with 403 REFUND_PERMISSION_REQUIRED, before any refund runs', async () => {
    state.role = 'staff';
    for (const method of ['original', 'gateway', 'original_payment']) {
      const res = await request(app()).post(COMPLETE).send({ refundMethod: method });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('REFUND_PERMISSION_REQUIRED');
    }
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('refuses staff store_credit too (F-10: it credits a spendable wallet), before any refund runs', async () => {
    state.role = 'staff';
    const res = await request(app()).post(COMPLETE).send({ refundMethod: 'store_credit' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REFUND_PERMISSION_REQUIRED');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('still lets staff complete with a record-only method (cash, bank transfer, manual)', async () => {
    state.role = 'staff';
    for (const method of ['cash', 'bank_transfer', 'manual']) {
      const res = await request(app()).post(COMPLETE).send({ refundMethod: method });
      expect(res.status).toBe(200);
      expect(mockComplete).toHaveBeenCalledWith('store-1', 'ret-1', 'u-1', method, {});
    }
  });

  it('lets a store_admin complete with store_credit', async () => {
    state.role = 'store_admin';
    const res = await request(app()).post(COMPLETE).send({ refundMethod: 'store_credit' });
    expect(res.status).toBe(200);
  });

  it('lets a store_admin send a gateway refund', async () => {
    state.role = 'store_admin';
    const res = await request(app()).post(COMPLETE).send({ refundMethod: 'original' });
    expect(res.status).toBe(200);
    expect(mockComplete).toHaveBeenCalledWith('store-1', 'ret-1', 'u-1', 'original', {});
  });

  it('the preview marks the gateway unavailable for staff, with a reason the modal renders', async () => {
    state.role = 'staff';
    const res = await request(app()).get(PREVIEW);
    expect(res.status).toBe(200);
    expect(res.body.data.preview.gateway).toMatchObject({
      available: false,
      unavailableReason: 'REFUND_PERMISSION_REQUIRED',
    });
  });

  it('the preview is unchanged for a store_admin', async () => {
    state.role = 'store_admin';
    const res = await request(app()).get(PREVIEW);
    expect(res.body.data.preview.gateway.available).toBe(true);
  });
  it('refuses staff a refund override even with a record-only method (B2B Task 8b: it changes the amount paid out)', async () => {
    state.role = 'staff';
    const res = await request(app())
      .post(COMPLETE)
      .send({
        refundMethod: 'cash',
        refundOverrides: {
          '11111111-1111-4111-8111-111111111111': { amountMinor: 100, reason: 'goodwill' },
        },
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REFUND_PERMISSION_REQUIRED');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('lets a store_admin pass an override through to the service', async () => {
    state.role = 'store_admin';
    const overrides = {
      '11111111-1111-4111-8111-111111111111': { amountMinor: 100, reason: 'goodwill' },
    };
    const res = await request(app())
      .post(COMPLETE)
      .send({ refundMethod: 'cash', refundOverrides: overrides });
    expect(res.status).toBe(200);
    expect(mockComplete).toHaveBeenCalledWith('store-1', 'ret-1', 'u-1', 'cash', overrides);
  });
});
