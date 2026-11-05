/**
 * NEON-ZERO (Ruling NZ-C-1): the super-admin hub (`/admin`) opens NO Postgres transaction once the billing, access and
 * platform families are on D1; before that it keeps the one request transaction. An unreadable marker is a 503, never a
 * Postgres fallback. Deferred work still drains after the response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({
  runInTenantContext: vi.fn(),
  runInUserScope: vi.fn(),
  runInStoreScope: vi.fn(),
  on: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  runInTenantContext: (...a: [string | undefined, () => Promise<unknown>, string?]) =>
    m.runInTenantContext(...a),
  runInUserScope: (...a: [string, () => Promise<unknown>]) => m.runInUserScope(...a),
  runInStoreScope: (...a: [string, () => Promise<unknown>]) => m.runInStoreScope(...a),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/store-backend', () => ({ backendFor: vi.fn() }));
vi.mock('@api/middleware/auth', () => ({
  authenticateAccounts: vi.fn(),
  liveIdentityMemo: () => ({}),
}));
vi.mock('@api/services/platform/cutover', () => ({
  platformFamilyOnD1: (f: string) => m.on(f),
  // the real helper is "billing && access && platform"; same rule over the mocked marker reads
  platformUserScopeIsLazy: async () =>
    (await Promise.all(['billing', 'access', 'platform'].map(f => m.on(f)))).every(Boolean),
}));

import { platformUserContext } from '@api/middleware/tenant-context';
import { AppError, errorHandler } from '@api/middleware/error-handler';

function app() {
  const a = express();
  a.use((q, _s, n) => {
    (q as never as { user: { userId: string } }).user = { userId: 'su-1' };
    n();
  });
  a.use(platformUserContext(q => (q as never as { user?: { userId: string } }).user?.userId));
  a.get('/admin/x', (_q, res) => res.json({ ok: true }));
  a.use(errorHandler as never);
  return a;
}

beforeEach(() => {
  m.runInTenantContext
    .mockReset()
    .mockImplementation(async (_s, fn: () => Promise<unknown>) => fn());
  m.runInUserScope.mockReset().mockImplementation(async (_u, fn: () => Promise<unknown>) => fn());
  m.on.mockReset();
});

describe('platformUserContext', () => {
  it('families on D1: the lazy user scope, no Postgres transaction', async () => {
    m.on.mockResolvedValue(true);
    const res = await request(app()).get('/admin/x');
    expect(res.status).toBe(200);
    expect(m.runInUserScope).toHaveBeenCalledTimes(1);
    expect(m.runInUserScope.mock.calls[0][0]).toBe('su-1');
    expect(m.runInTenantContext).not.toHaveBeenCalled();
  });

  it('any family still on Postgres: the one request transaction, as before', async () => {
    m.on.mockImplementation(async (f: string) => f !== 'platform');
    const res = await request(app()).get('/admin/x');
    expect(res.status).toBe(200);
    expect(m.runInTenantContext).toHaveBeenCalledTimes(1);
    expect(m.runInUserScope).not.toHaveBeenCalled();
  });

  it('unreadable marker: 503, nothing opened', async () => {
    m.on.mockRejectedValue(new AppError(503, 'PLATFORM_CUTOVER_UNREADABLE', 'down'));
    const res = await request(app()).get('/admin/x');
    expect(res.status).toBe(503);
    expect(m.runInUserScope).not.toHaveBeenCalled();
    expect(m.runInTenantContext).not.toHaveBeenCalled();
  });
});
