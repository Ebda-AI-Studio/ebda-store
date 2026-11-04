/**
 * NEON-ZERO-1 (Ruling NZ-TX-1): for a store whose backend is `do`, `tenantContext` opens NO Postgres transaction (no BEGIN, no
 * set_config) - every admin route used to 500 with Postgres dead because of that BEGIN. A `pg` store keeps its request
 * transaction; an unreadable backend flag is a 503; deferred work still drains after the response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({
  runInTenantContext: vi.fn(),
  runInStoreScope: vi.fn(),
  backendFor: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  runInTenantContext: (...a: [string | undefined, () => Promise<unknown>, string?]) =>
    m.runInTenantContext(...a),
  runInStoreScope: (...a: [string, () => Promise<unknown>]) => m.runInStoreScope(...a),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/store-backend', () => ({ backendFor: (id: string) => m.backendFor(id) }));
vi.mock('@api/middleware/auth', () => ({
  authenticateAccounts: vi.fn(),
  liveIdentityMemo: () => ({}),
}));

import { tenantContext } from '@api/middleware/tenant-context';
import { deferAfterTenantCommit } from '@api/lib/after-tenant-commit';
import { AppError, errorHandler } from '@api/middleware/error-handler';

const STORE = '11111111-1111-4111-8111-111111111111';
const events: string[] = [];

function app() {
  const r = express.Router();
  r.use((q, _s, n) => {
    (q as never as { user: { userId: string } }).user = { userId: 'u-1' };
    n();
  });
  r.param('storeId', tenantContext);
  r.get('/:storeId/things', (_q, res) => {
    void deferAfterTenantCommit('t', async () => {
      events.push('deferred');
    });
    events.push('handler');
    res.json({ ok: true });
  });
  const a = express();
  a.use('/stores', r);
  a.use(errorHandler as never);
  return a;
}

beforeEach(() => {
  events.length = 0;
  m.runInTenantContext
    .mockReset()
    .mockImplementation(async (_s, fn: () => Promise<unknown>) => fn());
  m.runInStoreScope.mockReset().mockImplementation(async (_s, fn: () => Promise<unknown>) => fn());
  m.backendFor.mockReset();
});

describe('tenantContext by backend', () => {
  it('a DO store: no Postgres transaction, the handler answers, deferred work still runs after it', async () => {
    m.backendFor.mockResolvedValue('do');
    const res = await request(app())
      .get(`/stores/${STORE}/things`)
      .set('authorization', 'Bearer x');
    expect(res.status).toBe(200);
    expect(m.runInTenantContext).not.toHaveBeenCalled();
    // the user rides along: user-keyed RLS tables (users, addresses) still see app.current_user_id
    expect(m.runInStoreScope).toHaveBeenCalledWith(STORE, expect.any(Function), 'u-1');
    await vi.waitFor(() => expect(events).toEqual(['handler', 'deferred']));
  });

  it('a pg store keeps the request transaction', async () => {
    m.backendFor.mockResolvedValue('pg');
    const res = await request(app())
      .get(`/stores/${STORE}/things`)
      .set('authorization', 'Bearer x');
    expect(res.status).toBe(200);
    // the request transaction + the deferred task's fresh tenant transaction
    expect(m.runInTenantContext).toHaveBeenCalledTimes(2);
  });

  it('an unreadable backend flag is a 503, never a Postgres fallback', async () => {
    m.backendFor.mockRejectedValue(new AppError(503, 'STORE_BACKEND_UNAVAILABLE', 'x'));
    const res = await request(app())
      .get(`/stores/${STORE}/things`)
      .set('authorization', 'Bearer x');
    expect(res.status).toBe(503);
    expect(m.runInTenantContext).not.toHaveBeenCalled();
  });
});
