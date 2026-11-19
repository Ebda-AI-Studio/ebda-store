/**
 * Unit coverage for `userContext` (RLS cutover Phase 1c,
 * docs/plans/done/2026-07-02-rls-cutover.md), the middleware factory that wires
 * `app.current_user_id` (and, optionally, `app.current_store_id`) into the
 * two bare-mounted, user-scoped routers `router.param`/`tenantContext` can't
 * reach: `address.routes.ts` and `wishlist.routes.ts`.
 *
 * The real ebda_app cross-tenant enforcement is proven end-to-end against
 * a live Postgres connection in `tests/integration/rls-ebda-app.test.ts`
 * (describe blocks "RLS-3: userContext middleware call surface — ..."). This
 * file is narrower and DB-free: it mocks `runInTenantContext` and asserts
 * `userContext` calls it with the exact arguments the wiring in
 * address.routes.ts / wishlist.routes.ts depends on — the userId/storeId
 * resolution logic, the "no user → skip straight to next()" branch, and the
 * non-UUID storeId defense.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const runInTenantContextMock = vi.fn(
  async (_storeId: string | undefined, fn: () => Promise<unknown>, _userId?: string) => fn()
);

vi.mock('@ebda/database', () => ({
  runInTenantContext: (...args: [string | undefined, () => Promise<unknown>, string?]) =>
    runInTenantContextMock(...args),
}));

vi.mock('@api/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { userContext } from '@api/middleware/tenant-context';

/**
 * A response double complete enough for `runRequestInTransaction`
 * (middleware/request-transaction.ts), which `userContext` delegates its
 * lifecycle to. That module patches `end`/`write` (and, when present,
 * `download`/`sendFile`/`flushHeaders`) to decide the commit lane, so a double
 * missing `end` throws before the middleware runs at all. Keep this in step
 * with what that module touches — a partial double here fails as a TypeError
 * inside the middleware, which reads as "userContext is broken" rather than
 * "the double is thin".
 */
function makeRes(): Response {
  const listeners: Record<string, () => void> = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    end: vi.fn(),
    write: vi.fn(() => true),
    removeHeader: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => {
      listeners[event] = cb;
      // Fire 'finish' asynchronously so the wrapped promise resolves for the
      // test — this suite never calls res.end(), so 'finish' is the only path
      // that settles the transaction gate.
      if (event === 'finish') {
        setImmediate(cb);
      }
    }),
  };
  return res as unknown as Response;
}

describe('userContext middleware factory (RLS-3)', () => {
  beforeEach(() => {
    runInTenantContextMock.mockClear();
  });

  it('resolves userId via the supplied getUserId and calls runInTenantContext(undefined, fn, userId) when no getStoreId is given', async () => {
    const req = { user: { userId: 'user-a', email: 'a@test.com', role: 'customer' } } as Request;
    const res = makeRes();
    const next: NextFunction = vi.fn();

    const middleware = userContext(r => r.user!.userId);
    middleware(req, res, next);

    // Let the mocked runInTenantContext's `fn()` (which itself calls next())
    // and the finish-listener microtasks flush.
    await new Promise(resolve => setImmediate(resolve));

    expect(runInTenantContextMock).toHaveBeenCalledTimes(1);
    const [storeIdArg, , userIdArg] = runInTenantContextMock.mock.calls[0];
    expect(storeIdArg).toBeUndefined();
    expect(userIdArg).toBe('user-a');
    expect(next).toHaveBeenCalled();
  });

  it('resolves both userId and storeId when getStoreId is supplied (wishlist shape)', async () => {
    const req = {
      user: { userId: 'user-b', email: 'b@test.com', role: 'customer' },
      headers: { 'x-store-id': '11111111-1111-1111-1111-111111111111' },
    } as unknown as Request;
    const res = makeRes();
    const next: NextFunction = vi.fn();

    const middleware = userContext(
      r => r.user!.userId,
      r => (r.headers['x-store-id'] as string) || null
    );
    middleware(req, res, next);
    await new Promise(resolve => setImmediate(resolve));

    expect(runInTenantContextMock).toHaveBeenCalledTimes(1);
    const [storeIdArg, , userIdArg] = runInTenantContextMock.mock.calls[0];
    expect(storeIdArg).toBe('11111111-1111-1111-1111-111111111111');
    expect(userIdArg).toBe('user-b');
  });

  it('treats a non-UUID storeId as absent (mirrors tenantContext) instead of passing it through', async () => {
    const req = {
      user: { userId: 'user-c', email: 'c@test.com', role: 'customer' },
      headers: { 'x-store-id': 'not-a-uuid' },
    } as unknown as Request;
    const res = makeRes();
    const next: NextFunction = vi.fn();

    const middleware = userContext(
      r => r.user!.userId,
      r => (r.headers['x-store-id'] as string) || null
    );
    middleware(req, res, next);
    await new Promise(resolve => setImmediate(resolve));

    const [storeIdArg] = runInTenantContextMock.mock.calls[0];
    expect(storeIdArg).toBeUndefined();
  });

  it('skips straight to next() without touching runInTenantContext when getUserId resolves undefined', () => {
    // Mirrors wishlist.routes.ts: customerUserId(req) returns undefined for
    // a non-customer role, or when unauthenticated.
    const req = { user: undefined } as unknown as Request;
    const res = makeRes();
    const next: NextFunction = vi.fn();

    const middleware = userContext(() => undefined);
    middleware(req, res, next);

    expect(runInTenantContextMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
