/**
 * SEC-14 / M-136: bulk PII exports need `customers:export`, held by owners only, and leave an
 * audit row. Red if staff gain the permission, either export route loses the guard, or the
 * audit write is dropped.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { hasPermission, requirePermission } from '@api/middleware/rbac';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../', rel), 'utf8');

describe('customers:export permission', () => {
  it('owners and platform admins have it; staff and customers do not', () => {
    expect(hasPermission('store_admin', 'customers:export')).toBe(true);
    expect(hasPermission('super_admin', 'customers:export')).toBe(true);
    expect(hasPermission('staff', 'customers:export')).toBe(false);
    expect(hasPermission('customer', 'customers:export')).toBe(false);
  });

  it('the middleware answers 403 for staff and calls next for an owner', () => {
    const run = (role: string) => {
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      const next = vi.fn();
      requirePermission('customers:export')(
        { user: { role } } as unknown as Request,
        { status } as unknown as Response,
        next
      );
      return { status, next };
    };
    const staff = run('staff');
    expect(staff.status).toHaveBeenCalledWith(403);
    expect(staff.next).not.toHaveBeenCalled();
    expect(run('store_admin').next).toHaveBeenCalled();
  });
});

describe('both bulk-export routes are guarded and audited', () => {
  const routeSrc = (file: string, route: string) => {
    const src = read(file);
    const start = src.indexOf(`router.get(\n  '${route}'`);
    expect(start, `${route} not found`).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n);\n', start));
  };
  it('customers/export.xlsx', () => {
    const r = routeSrc('apps/api/src/routes/customers.routes.ts', '/customers/export.xlsx');
    expect(r).toContain("requirePermission('customers:export')");
    expect(r).toContain("action: 'customers.exported'");
  });
  it('orders/export.xlsx', () => {
    const r = routeSrc('apps/api/src/routes/order.routes.ts', '/export.xlsx');
    expect(r).toContain("requirePermission('customers:export')");
    expect(r).toContain("action: 'orders.exported'");
  });
});
