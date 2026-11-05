// Dead-Postgres sweep fixes: customer login without a store, the passkey guard and the refresh-token cron must not need Postgres.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  doStores: ['S1', 'S2'],
  pgStores: { v: false },
  purgeCalls: [] as string[],
  purgeFails: new Set<string>(),
  pgPurge: vi.fn(async () => 5),
  pgTouched: vi.fn(),
}));
class StoreClosed extends Error {
  code = 'STORE_CLOSED';
}
vi.mock('@api/lib/store-backend', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/store-backend')>()),
  doStoreIdList: async () => h.doStores,
  hasStoresOnBackend: async (b: string) => (b === 'pg' ? h.pgStores.v : true),
}));
vi.mock('@api/lib/customer-auth', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/customer-auth')>()),
  customerAuthRoute: async (s: string | null) =>
    s
      ? {
          kind: 'do',
          client: {
            storeId: s,
            call: async (op: string) => {
              if (op === 'purge') {
                if (h.purgeFails.has(s))
                  throw new (await import('@api/middleware/error-handler')).AppError(
                    410,
                    'STORE_CLOSED',
                    'closed'
                  );
                h.purgeCalls.push(s);
                return { deleted: 2 };
              }
              return {};
            },
          },
        }
      : { kind: 'pg' },
}));
vi.mock('@api/lib/definer', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/definer')>()),
  purgeRefreshTokens: h.pgPurge,
  getUserState: async () => {
    h.pgTouched();
    throw new Error('pg down');
  },
  findUserIdByEmail: async () => {
    h.pgTouched();
    throw new Error('pg down');
  },
}));

import { AuthService } from '@api/services/auth.service';
import { rejectIdentityManaged } from '@api/middleware/auth';

beforeEach(() => {
  h.purgeCalls.length = 0;
  h.purgeFails.clear();
  h.pgStores.v = false;
  h.pgPurge.mockClear();
  h.pgTouched.mockClear();
  void StoreClosed;
});

describe('refresh-token cleanup cron', () => {
  it('purges every DO store in its DO and never asks Postgres when no pg store exists', async () => {
    expect(await AuthService.cleanupRefreshTokens()).toBe(4);
    expect(h.purgeCalls).toEqual(['S1', 'S2']);
    expect(h.pgPurge).not.toHaveBeenCalled();
  });
  it('a closed store is skipped, the others still purge', async () => {
    h.purgeFails.add('S1');
    expect(await AuthService.cleanupRefreshTokens()).toBe(2);
    expect(h.purgeCalls).toEqual(['S2']);
  });
  it('while a pg store still exists the Postgres purge also runs', async () => {
    h.pgStores.v = true;
    expect(await AuthService.cleanupRefreshTokens()).toBe(4 + 5);
    expect(h.pgPurge).toHaveBeenCalledTimes(1);
  });
});

describe('login without a store (admin namespace)', () => {
  it('is 409 USE_IDENTITY_SERVICE with no Postgres lookup once every store is on D1 / a DO', async () => {
    await expect(AuthService.login('a@x.com', 'whatever', '1.1.1.1', null)).rejects.toMatchObject({
      statusCode: 409,
      code: 'USE_IDENTITY_SERVICE',
    });
    expect(h.pgTouched).not.toHaveBeenCalled();
  });
});

describe('rejectIdentityManaged (passkey / MFA routes)', () => {
  const run = async (user: Record<string, unknown>) => {
    const next = vi.fn();
    await rejectIdentityManaged({ user } as never, {} as never, next);
    return next.mock.calls[0]?.[0] as { code?: string } | undefined;
  };
  it('decides from the verified token: an admin-namespace account is refused with no Postgres read', async () => {
    expect(await run({ userId: 'u', role: 'store_admin' })).toMatchObject({
      code: 'USE_IDENTITY_SERVICE',
    });
    expect(await run({ userId: 'u', role: 'super_admin', storeId: null })).toMatchObject({
      code: 'USE_IDENTITY_SERVICE',
    });
    expect(h.pgTouched).not.toHaveBeenCalled();
  });
  it('a customer (token carries its store) passes', async () => {
    expect(await run({ userId: 'u', role: 'customer', storeId: 'S1' })).toBeUndefined();
  });
});
