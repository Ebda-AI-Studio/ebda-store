/**
 * Ruling ACT-1: the two write paths that report "help needed" (a super admin writing to a store that is not live yet, a
 * merchant's successful Ebda AI Studio assistant call). Advisory: neither changes what the request does.
 */
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendHelp, STATUS, STORE } = vi.hoisted(() => ({
  sendHelp: vi.fn(async () => undefined),
  STATUS: { v: 'inactive' },
  STORE: '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10',
}));
vi.mock('../../apps/api/src/lib/ci/emit', () => ({ sendOnboardingHelpToCi: sendHelp }));
vi.mock('../../apps/api/src/middleware/security', () => ({
  auditLog: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/services/platform/access-d1', () => ({
  gateRead: vi.fn(),
  onAccessD1: vi.fn(async () => false),
}));
vi.mock('@ebda/database', () => ({
  withStore: vi.fn(async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: {
        findUnique: async () => ({
          id: STORE,
          ownerId: 'owner',
          name: 'S',
          status: STATUS.v,
          billingSuspendedReason: null,
        }),
      },
    })
  ),
}));

import { requireStoreAccess } from '../../apps/api/src/middleware/store-access';

const run = async (method: string, role: string) => {
  const next = vi.fn();
  await requireStoreAccess(
    {
      params: { storeId: STORE },
      method,
      path: '/x',
      baseUrl: '',
      user: { userId: 'u1', role },
      headers: {},
    } as never,
    {} as never,
    next
  );
  return next;
};

describe('super_admin_action help signal (store-access middleware)', () => {
  beforeEach(() => {
    sendHelp.mockClear();
    STATUS.v = 'inactive';
  });

  it('fires for a super admin WRITE on a store that is not live yet, and the request still proceeds', async () => {
    const next = await run('PUT', 'super_admin');
    expect(sendHelp).toHaveBeenCalledWith(STORE, 'super_admin_action');
    expect(next).toHaveBeenCalledWith();
  });

  it('does not fire for a read, for a live store, or for the merchant themself', async () => {
    await run('GET', 'super_admin');
    STATUS.v = 'active';
    await run('PUT', 'super_admin');
    expect(sendHelp).not.toHaveBeenCalled();
  });
});

describe('assistant_used help signal (ai routes)', () => {
  const src = fs.readFileSync(
    new URL('../../apps/api/src/routes/ai.routes.ts', import.meta.url),
    'utf8'
  );
  it('is registered right after the auth chain, only for a store_admin POST, only on a successful response', () => {
    const auth = src.indexOf(
      "router.use(authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess);"
    );
    const hook = src.indexOf("sendOnboardingHelpToCi(storeId, 'assistant_used')");
    const firstRoute = src.indexOf("router.get('/settings'");
    expect(auth).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(auth);
    expect(hook).toBeLessThan(firstRoute);
    const block = src.slice(auth, firstRoute);
    expect(block).toContain("req.method === 'POST'");
    expect(block).toContain("req.user?.role === 'store_admin'");
    expect(block).toContain('res.statusCode < 400');
  });
});
