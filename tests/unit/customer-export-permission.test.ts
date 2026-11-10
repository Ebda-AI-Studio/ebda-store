/**
 * SEC-14 / M-136: bulk PII exports need `customers:export`, held by owners only, and leave an
 * audit row. Red if staff gain the permission, either export route loses the guard, or the
 * audit write is dropped.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import type { Request, Response } from 'express';
import ts from 'typescript';
import { hasPermission, requirePermission } from '@api/middleware/rbac';
import { parseSource, callsTo, isStr, props } from './helpers/ts-ast';

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
  // AST, not a text window: running the real handlers needs a store DB, an xlsx writer and the
  // full auth stack, so the check is structural. It looks at NODES of the exact `router.get`
  // registration: the guard must be a real argument call and the audit action a real property
  // of the handler, so a comment or an adjacent route cannot satisfy it.
  const route = (file: string, route: string) => {
    const sf = parseSource(path.resolve(__dirname, '../../', file));
    const call = callsTo(sf, 'router.get').find(
      c => isStr(c.arguments[0]) && c.arguments[0].text === route
    );
    expect(call, `${route} not found`).toBeDefined();
    return call!;
  };
  const guarded = (call: ts.CallExpression) =>
    call.arguments
      .slice(1, -1)
      .some(
        a =>
          ts.isCallExpression(a) &&
          a.expression.getText() === 'requirePermission' &&
          isStr(a.arguments[0]) &&
          a.arguments[0].text === 'customers:export'
      );
  const audits = (call: ts.CallExpression, action: string) =>
    props(call.arguments[call.arguments.length - 1], 'action').some(
      p => isStr(p.initializer) && p.initializer.text === action
    );
  it('customers/export.xlsx', () => {
    const r = route('apps/api/src/routes/customers.routes.ts', '/customers/export.xlsx');
    expect(guarded(r)).toBe(true);
    expect(audits(r, 'customers.exported')).toBe(true);
  });
  it('orders/export.xlsx', () => {
    const r = route('apps/api/src/routes/order.routes.ts', '/export.xlsx');
    expect(guarded(r)).toBe(true);
    expect(audits(r, 'orders.exported')).toBe(true);
  });
});
