/**
 * Order refund routes — missing-permission regression guard.
 *
 * apps/api/src/routes/order.routes.ts POST /:orderId/refund-via-provider
 * and POST /:orderId/refresh-refund-status only required
 * authorize('store_admin','super_admin','staff') — any `staff` teammate
 * could trigger a real provider refund or flip Payment.status, despite
 * `staff` intentionally NOT having the 'orders:refund' permission
 * everywhere else (payment.routes.ts POST /refund already gates on it).
 * Fix: both routes now also require `requirePermission('orders:refund')`,
 * which `rolePermissions` in middleware/rbac.ts grants only to
 * store_admin/super_admin.
 *
 * This test exercises the real `requirePermission` middleware (not
 * mocked) directly — the same import used by both routes — and pins a
 * static source check so a future edit can't silently drop the guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { requirePermission } from '../../apps/api/src/middleware/rbac';

function mockReqRes(role: string) {
  const req = { user: { userId: 'user-1', role } };
  const jsonMock = vi.fn();
  const statusMock = vi.fn(() => ({ json: jsonMock }));
  const res = { status: statusMock, json: jsonMock };
  const next = vi.fn();
  return { req, res, statusMock, jsonMock, next };
}

describe('requirePermission(orders:refund) — role gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks staff with 403 FORBIDDEN', () => {
    const { req, res, statusMock, jsonMock, next } = mockReqRes('staff');
    requirePermission('orders:refund')(req as any, res as any, next);
    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('allows store_admin through (legitimate same-tenant path, control)', () => {
    const { req, res, next } = mockReqRes('store_admin');
    requirePermission('orders:refund')(req as any, res as any, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows super_admin through (control)', () => {
    const { req, res, next } = mockReqRes('super_admin');
    requirePermission('orders:refund')(req as any, res as any, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('order.routes.ts — refund routes wire the permission guard (static check)', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../apps/api/src/routes/order.routes.ts'),
    'utf-8'
  );

  function routeBlock(routePath: string): string {
    const idx = source.indexOf(`'${routePath}'`);
    expect(idx, `route ${routePath} not found in order.routes.ts`).toBeGreaterThan(-1);
    // Grab the next ~600 chars — enough to cover the middleware chain up to
    // the handler body without pulling in the following route.
    return source.slice(idx, idx + 600);
  }

  it('refund-via-provider requires orders:refund', () => {
    expect(routeBlock('/:orderId/refund-via-provider')).toContain(
      "requirePermission('orders:refund')"
    );
  });

  it('refresh-refund-status requires orders:refund', () => {
    expect(routeBlock('/:orderId/refresh-refund-status')).toContain(
      "requirePermission('orders:refund')"
    );
  });
});
