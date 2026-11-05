// Security review of 5bd6aac92: a revocation or status change for a customer of a DO-served store MUST land in the DO, even
// when the caller names no store (admin suspend, MFA path, any sibling) - never only in the stale Postgres row.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; args: unknown }>,
  pgRevoke: vi.fn(),
  pushed: [] as Array<[string, number]>,
  doStores: new Set<string>(),
  users: new Map<string, { role: string; storeId: string | null }>(),
  lookupFails: { v: false },
}));

vi.mock('@api/lib/customer-auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/lib/customer-auth')>();
  return {
    ...actual,
    customerAuthRoute: async (storeId: string | null | undefined) =>
      storeId && h.doStores.has(storeId)
        ? {
            kind: 'do',
            client: {
              storeId,
              call: async (op: string, args: unknown) => {
                h.calls.push({ op, args });
                return { tokenVersion: 7 };
              },
            },
          }
        : { kind: 'pg' },
  };
});
vi.mock('@api/lib/definer', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/lib/definer')>();
  return {
    ...actual,
    getUserState: async (id: string) => {
      if (h.lookupFails.v) throw new Error('pg down');
      return h.users.get(id) ?? null;
    },
    revokeUserSessionsRow: h.pgRevoke,
  };
});
vi.mock('@api/services/redis.service', () => ({
  redis: {
    setUserTokenVersion: async (id: string, tv: number) => void h.pushed.push([id, tv]),
    clearUserTokenVersion: async () => undefined,
  },
}));
vi.mock('@api/lib/identity-client', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/identity-client')>()),
  revokeIdentityIfManaged: async () => undefined,
}));

import { AuthService } from '@api/services/auth.service';

const S = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  h.calls.length = 0;
  h.pushed.length = 0;
  h.pgRevoke.mockReset();
  h.lookupFails.v = false;
  h.doStores = new Set([S]);
  h.users = new Map([
    ['cust-do', { role: 'customer', storeId: S }],
    ['cust-pg', { role: 'customer', storeId: '33333333-3333-4333-8333-333333333333' }],
  ]);
});

describe('revokeAllSessions without a scope', () => {
  it('resolves the customer store from the user row and revokes in the DO, not in Postgres', async () => {
    await AuthService.revokeAllSessions('cust-do');
    expect(h.calls).toEqual([
      { op: 'revokeAll', args: { userId: 'cust-do', reason: 'revoke_all' } },
    ]);
    expect(h.pushed).toEqual([['cust-do', 7]]);
    expect(h.pgRevoke).not.toHaveBeenCalled();
  });
  it('an explicit scope with no storeId (an admin token) still resolves the store', async () => {
    await AuthService.revokeAllSessions('cust-do', 'revoke_all', { storeId: undefined });
    expect(h.calls).toHaveLength(1);
  });
});

describe('fail closed', () => {
  it('a Postgres blip while resolving the store is a retryable 503, never a silent Postgres-only revoke', async () => {
    h.lookupFails.v = true;
    await expect(AuthService.revokeAllSessions('cust-do')).rejects.toMatchObject({
      statusCode: 503,
      code: 'REVOCATION_UNAVAILABLE',
    });
    expect(h.pgRevoke).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });
});

describe('setCustomerStatusOnDo', () => {
  it('sends status + revocation as ONE DO op and pushes the new version', async () => {
    expect(await AuthService.setCustomerStatusOnDo('cust-do', S, 'suspended')).toBe(true);
    expect(h.calls).toEqual([
      { op: 'setStatus', args: { userId: 'cust-do', status: 'suspended' } },
    ]);
    expect(h.pushed).toEqual([['cust-do', 7]]);
  });
  it('is a no-op (false) for a store that is not DO-served, so the caller keeps its Postgres write', async () => {
    expect(
      await AuthService.setCustomerStatusOnDo(
        'cust-pg',
        '33333333-3333-4333-8333-333333333333',
        'suspended'
      )
    ).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(await AuthService.setCustomerStatusOnDo('x', null, 'suspended')).toBe(false);
  });
});
