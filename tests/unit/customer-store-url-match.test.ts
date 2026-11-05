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

describe('every customer-facing route with a URL :storeId mounts it right after authentication', () => {
  const src = (file: string) => readFileSync(path.join(API, 'routes', file), 'utf8');
  const count = (file: string) =>
    (src(file).match(/(?:optionalAuthenticate|authenticate),\s*requireCustomerStoreMatch,/g) ?? [])
      .length;
  const table: Array<[string, number]> = [
    ['order.routes.ts', 5], // list, detail, my/list, timeline, create
    ['return.routes.ts', 3], // list, create, detail
    ['shipping-carrier.routes.ts', 1], // public order tracking
    ['review.routes.ts', 1], // create review
    ['loyalty.routes.ts', 3], // my-points, my-transactions, join
    ['wallet.routes.ts', 2], // public wallet, wallet transactions
    ['coupon.routes.ts', 1], // public coupon validate (optional auth)
  ];
  it.each(table)('%s mounts it on %i route(s)', (file, n) => {
    expect(count(file)).toBe(n);
  });
  it('the cart router applies it to every handler', () => {
    expect(src('cart.routes.ts')).toMatch(/router\.use\(requireCustomerStoreMatch\)/);
  });
});

describe("another customer's order or return answers 404, never 403 (no existence oracle)", () => {
  const src = (file: string) => readFileSync(path.join(API, 'routes', file), 'utf8');
  it('order detail, timeline and tracking', () => {
    expect(src('order.routes.ts')).not.toContain('Not authorized to view this order');
    expect(src('order.routes.ts')).not.toMatch(/error: \{ message: 'Forbidden' \}/);
    expect(src('order.routes.ts')).toMatch(
      /order\.customerId !== req\.user\?\.userId\) \{\s*throw new AppError\(404, 'NOT_FOUND', 'Order not found'\)/
    );
    expect(src('shipping-carrier.routes.ts')).toMatch(
      /order\.customerId !== user\.userId\) \{\s*res\.status\(404\)/
    );
  });
  it('return detail', () => {
    expect(src('return.routes.ts')).toMatch(
      /returnRequest\.customerId !== req\.user!\.userId\) \{\s*throw new AppError\(404, 'NOT_FOUND', 'Return request not found'\)/
    );
  });
});
