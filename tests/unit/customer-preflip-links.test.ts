// Opus review of 7d03ec0cd, finding 7: a verification / reset link minted BEFORE the flip must not write the stale Postgres copy
// (and answer "reset") once the store is served by its StoreDO: it is simply invalid.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  onDo: { v: true },
  withUserCalls: [] as string[],
  seq: [] as unknown[],
}));
vi.mock('@api/lib/customer-auth', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/customer-auth')>()),
  clientForScopedToken: async () => null,
  customerAuthRoute: async () =>
    h.onDo.v ? { kind: 'do', client: { storeId: 'S' } } : { kind: 'pg' },
}));
vi.mock('@api/lib/definer', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/definer')>()),
  verificationTokenUser: async () => 'u1',
  refreshTokenUser: async () => 'u1',
  getUserState: async () => ({
    id: 'u1',
    role: 'customer',
    status: 'active',
    tokenVersion: 0,
    storeId: 'S',
    deletedAt: null,
  }),
}));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  prisma: {},
  withUser: async () => {
    h.withUserCalls.push('withUser');
    return h.seq.shift();
  },
}));

import { AuthService } from '@api/services/auth.service';

beforeEach(() => {
  h.onDo.v = true;
  h.withUserCalls.length = 0;
});

describe('pre-flip links on a store now served by its DO', () => {
  it('verify-email: TOKEN_INVALID, the Postgres copy is not marked verified', async () => {
    h.seq = [
      { id: 't1', userId: 'u1', expiresAt: new Date(Date.now() + 1e6) },
      {
        id: 'u1',
        email: 'a@x.com',
        firstName: 'A',
        lastName: 'B',
        emailVerified: false,
        storeId: 'S',
        language: 'en',
        deletedAt: null,
      },
    ];
    await expect(AuthService.verifyEmail('a'.repeat(64))).rejects.toMatchObject({
      statusCode: 400,
      code: 'TOKEN_INVALID',
    });
    expect(h.withUserCalls).toHaveLength(2); // the two READS; no update followed
  });
  it('reset-password: TOKEN_INVALID before the link is claimed or any password written', async () => {
    h.seq = [{ id: 'r1', userId: 'u1' }];
    await expect(
      AuthService.resetPassword('b'.repeat(64), 'N3wPassw0rd!abc')
    ).rejects.toMatchObject({ statusCode: 400, code: 'TOKEN_INVALID' });
    expect(h.withUserCalls).toHaveLength(1); // only the link lookup
  });
});
