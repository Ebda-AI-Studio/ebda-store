import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { requireCustomerStoreMatch } from '@api/middleware/customer-store-match';

const API = path.resolve(__dirname, '../../apps/api/src');
const run = (user: unknown, storeId: string | undefined) => {
  const next = vi.fn() as unknown as NextFunction;
  requireCustomerStoreMatch(
    { user, params: { storeId } } as unknown as Request,
    {} as Response,
    next
  );
  return (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
};

describe('requireCustomerStoreMatch (MAP-HIGH, customer token vs URL store)', () => {
  it('a customer of store A is refused on /stores/B/... with the same 404 as assertStoreCustomer', () => {
    const err = run({ role: 'customer', storeId: 'A' }, 'B');
    expect(err).toMatchObject({ statusCode: 404, code: 'CUSTOMER_NOT_FOUND' });
  });
  it('a customer token with no store claim is refused', () => {
    expect(run({ role: 'customer' }, 'A')).toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });
  it('a customer on their own store passes', () => {
    expect(run({ role: 'customer', storeId: 'A' }, 'A')).toBeUndefined();
  });
  it('staff and admins pass (requireStoreAccess / checkStoreAccess decide for them)', () => {
    for (const role of ['staff', 'store_admin', 'super_admin'])
      expect(run({ role, storeId: null }, 'B')).toBeUndefined();
  });
});

describe('the dual-use store routes mount it right after authenticate', () => {
  const count = (file: string) =>
    (
      readFileSync(path.join(API, 'routes', file), 'utf8').match(
        /authenticate,\s*requireCustomerStoreMatch,/g
      ) ?? []
    ).length;
  it('order routes: list, detail, my/list, timeline, create', () => {
    expect(count('order.routes.ts')).toBe(5);
  });
  it('return routes: list, create, detail', () => {
    expect(count('return.routes.ts')).toBe(3);
  });
});
