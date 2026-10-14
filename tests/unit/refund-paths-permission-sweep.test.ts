/**
 * Refund-path permission sweep (S8, 2026-10-14).
 *
 * `staff` holds `orders:manage` and `returns:write` but deliberately NOT
 * `orders:refund` (rbac.ts). Every route that moves refund money, or records
 * that it moved, must therefore be gated on `orders:refund`. Existing tests pin
 * refund-via-provider / refresh-refund-status (order-refund-permission.test.ts)
 * and the return-complete gateway methods (return-complete-gateway-permission
 * .test.ts). This test closes the rest and adds a SWEEP: any route whose path
 * names a refund must carry the permission, so a new refund route fails here
 * instead of silently shipping open to staff.
 *
 * Static source checks (no DB, no app boot).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { hasPermission } from '../../apps/api/src/middleware/rbac';

const routesDir = path.resolve(__dirname, '../../apps/api/src/routes');
const read = (f: string) => readFileSync(path.join(routesDir, f), 'utf-8');

describe('rbac: who may refund', () => {
  it('staff cannot refund; store_admin and super_admin can', () => {
    expect(hasPermission('staff', 'orders:refund')).toBe(false);
    expect(hasPermission('staff', 'payments:refund')).toBe(false);
    expect(hasPermission('customer', 'orders:refund')).toBe(false);
    expect(hasPermission('store_admin', 'orders:refund')).toBe(true);
    expect(hasPermission('super_admin', 'orders:refund')).toBe(true);
  });
});

describe('every route whose path names a refund is permission-gated', () => {
  // Platform billing refunds (Ebda refunding a merchant) are super_admin-only
  // routes in admin.routes.ts, a different surface from a store's order refunds.
  const platformBilling = new Set(['admin.routes.ts']);
  const files = readdirSync(routesDir).filter(f => f.endsWith('.routes.ts'));
  const routeDecl = /router\.(?:post|put|patch|delete)\(\s*'([^']*refund[^']*)'/gi;

  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(routeDecl)) {
      const chain = src.slice(m.index!, m.index! + 700);
      it(`${file} ${m[1]} requires orders:refund`, () => {
        if (platformBilling.has(file)) {
          expect(chain).toMatch(/super_admin|requireRole|authorize/);
        } else {
          expect(chain).toContain("requirePermission('orders:refund')");
        }
      });
    }
  }

  it('found the refund routes this sweep is meant to cover', () => {
    const all = files.flatMap(f => [...read(f).matchAll(routeDecl)].map(m => `${f}:${m[1]}`));
    expect(all).toEqual(
      expect.arrayContaining([
        'payment.routes.ts:/refund',
        'order.routes.ts:/:orderId/instapay-refund',
        'order.routes.ts:/:orderId/refresh-refund-status',
        'order.routes.ts:/:orderId/refund-via-provider',
      ])
    );
  });
});

describe('refund-by-status and return completion check the permission in-handler', () => {
  it("PUT /:id/status → 'refunded' needs orders:refund before it records anything", () => {
    const src = read('order.routes.ts');
    const i = src.indexOf("if (status === 'refunded' && previousOrder.status !== 'refunded')");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 400);
    expect(block).toContain("hasPermission(actor.role as Role, 'orders:refund')");
    expect(block).toContain('403');
    // …and the permission check precedes the status write.
    expect(i).toBeLessThan(src.indexOf('OrderService.updateStatus(storeId, id, status)'));
  });

  it('return completion gates every gateway refund method on orders:refund', () => {
    const src = read('return.routes.ts');
    const i = src.indexOf('GATEWAY_REFUND_METHODS as readonly string[]).includes(refundMethod)');
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 300)).toContain(
      "hasPermission(req.user!.role as Role, 'orders:refund')"
    );
    expect(i).toBeLessThan(src.indexOf('ReturnService.complete('));
  });
});
