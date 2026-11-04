/**
 * #1859 (S2-tenancy-rls, 2026-09-25).
 *
 * `PUT /admin/users/:id` calls `AuthService.revokeAllSessions(id)` inside the
 * request's ambient tenant transaction (`tenantContext` /
 * `middleware/request-transaction.ts`: the whole request is ONE Prisma
 * interactive transaction that COMMITS BEFORE THE RESPONSE IS SENT).
 * `revokeAllSessions` used to `await redis.setUserTokenVersion(...)` directly,
 * INSIDE that still-open transaction. Redis has no rollback: if the outer
 * transaction's COMMIT (or a later audit-log write in the same tx) then
 * failed, Postgres rolled back to the old tokenVersion while Redis kept the
 * bumped one — every access token for that user is permanently rejected, with
 * no DB row and no retry path recording why.
 *
 * The fix routes the Redis bump through `deferAfterTenantCommit`, the same
 * helper `eraseAccount`'s third-party propagation already uses (see
 * `auth-erase-propagation.test.ts`): it only fires once the ambient
 * transaction has actually committed, and is DROPPED if it rolls back.
 *
 * Revert the fix (put the bare `await redis.setUserTokenVersion(...)` back)
 * and the first two tests below go red: the "commits" test sees Redis called
 * too early, and the "rolls back" test sees Redis called even though nothing
 * committed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@api/services/email.service', () => ({
  EmailService: { sendOrderConfirmation: vi.fn() },
}));

vi.mock('@api/services/account-lockout.service', () => ({
  accountLockout: {
    isLocked: vi.fn().mockResolvedValue({ locked: false }),
    recordFailedAttempt: vi.fn(),
    clearAttempts: vi.fn(),
  },
}));

vi.mock('@api/services/r2-cleanup.service', () => ({
  deleteR2ObjectIfOrphan: vi.fn().mockResolvedValue(undefined),
}));

const { mockPrisma, redisMock, sendMock, sendAlertMock } = vi.hoisted(() => {
  const mockPrisma = {
    user: { update: vi.fn() },
    refreshToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    merchantApiKey: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const redisMock = {
    setUserTokenVersion: vi.fn().mockResolvedValue(undefined),
    clearUserTokenVersion: vi.fn().mockResolvedValue(undefined),
  };
  const sendMock = vi.fn().mockResolvedValue({ ids: [] });
  const sendAlertMock = vi.fn().mockResolvedValue('sent');
  return { mockPrisma, redisMock, sendMock, sendAlertMock };
});

// The tokenVersion bump and the merchant-key revocation are ONE `ebda_user_revoke_sessions`
// definer call (`revokeUserSessionsRow`); `user.update` stands in for it here.
vi.mock('@api/lib/definer', () => ({
  // N-9: an unscoped revoke resolves the user's store first; an admin-namespace / unknown user stays on Postgres
  getUserState: async () => null,
  revokeUserSessionsRow: (userId: string) => mockPrisma.user.update({ where: { id: userId } }),
}));

// Merchant/staff sessions are also ended at the identity service (tests/unit/identity-shadow.test.ts covers that call).
vi.mock('@api/lib/identity-client', () => ({ revokeIdentityIfManaged: async () => undefined }));

vi.mock('@api/services/alerts.service', () => ({ sendAlert: sendAlertMock }));

vi.mock('@api/services/redis.service', () => ({ redis: redisMock }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: sendMock } }));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  Prisma: {},
  hasTenantContext: () => false,
  // no ambient transaction: the revoke runs AS the target user (own short transaction)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withUser: (_userId: string, fn: any) => fn(mockPrisma),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (client: any, fn: any) => fn(client),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRlsBypass: (fn: any) => fn(mockPrisma),
  // Mirrors fire-and-forget-helpers-deferred.test.ts: the drain step's
  // `runInTenantContext` just runs the task inline for this unit test —
  // the real GUC-setting transaction is covered against Postgres in
  // tests/integration/after-tenant-commit.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runInTenantContext: vi.fn(async (_storeId: string | undefined, fn: () => Promise<unknown>) =>
    fn()
  ),
  onClosedTenantTxAccess: vi.fn(),
}));

import { AuthService } from '@api/services/auth.service';
import { withDeferredWork } from '@api/lib/after-tenant-commit';

const USER_ID = 'user-revoke-1';
const STORE_ID = '11111111-1111-1111-1111-111111111111';

describe('#1859 AuthService.revokeAllSessions — Redis tv bump defers past the ambient commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.update.mockResolvedValue({ tokenVersion: 7 });
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.merchantApiKey.updateMany.mockResolvedValue({ count: 1 });
    redisMock.setUserTokenVersion.mockResolvedValue(undefined);
  });

  it('bumps Postgres inside the ambient transaction but does NOT touch Redis until it commits', async () => {
    await withDeferredWork({ storeId: STORE_ID, userId: USER_ID }, async () => {
      await AuthService.revokeAllSessions(USER_ID);

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: USER_ID } })
      );
      expect(redisMock.setUserTokenVersion).not.toHaveBeenCalled();
    });

    // Only after the "transaction" (the withDeferredWork callback) settles.
    expect(redisMock.setUserTokenVersion).toHaveBeenCalledWith(USER_ID, 7);
  });

  it('drops the Redis bump entirely when the ambient transaction rolls back — no permanent lockout with a stale cache and a reverted DB row', async () => {
    await expect(
      withDeferredWork({ storeId: STORE_ID, userId: USER_ID }, async () => {
        await AuthService.revokeAllSessions(USER_ID);
        throw new Error('COMMIT failed');
      })
    ).rejects.toThrow('COMMIT failed');

    expect(redisMock.setUserTokenVersion).not.toHaveBeenCalled();
  });

  it('still bumps Redis with no ambient transaction (self-service logout-all, Inngest, scripts — unchanged)', async () => {
    await AuthService.revokeAllSessions(USER_ID);

    expect(redisMock.setUserTokenVersion).toHaveBeenCalledWith(USER_ID, 7);
  });

  it('still revokes refresh tokens and merchant keys regardless of the Redis deferral', async () => {
    await withDeferredWork({ storeId: STORE_ID, userId: USER_ID }, () =>
      AuthService.revokeAllSessions(USER_ID)
    );

    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID, revokedAt: null } })
    );
    // merchant keys are revoked inside the same definer call as the tokenVersion bump
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER_ID } })
    );
  });
});

/**
 * Issue 2062 — the inline path (logout-all, password change/reset) used to
 * swallow a failed tv push into a warn while the caller reported success, and
 * the no-TTL key kept serving the stale-LOW version. Now a failed SET deletes
 * the key (the next request reads Postgres), and only a failed DELETE too is
 * treated as "revocation not in effect" — a P1 alert.
 *
 * Mutation proof: in auth.service.ts pushTokenVersion, drop the
 * `clearUserTokenVersion` fallback or the `sendAlert` → a case goes red.
 */
describe('revokeAllSessions — a failed tv push is never quiet (issue 2062)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.update.mockResolvedValue({ tokenVersion: 7 });
    redisMock.setUserTokenVersion.mockResolvedValue(undefined);
    redisMock.clearUserTokenVersion.mockResolvedValue(undefined);
  });

  it('a failed SET deletes the key so the next request reads the bump from Postgres', async () => {
    redisMock.setUserTokenVersion.mockRejectedValueOnce(new Error('redis blip'));

    await AuthService.revokeAllSessions(USER_ID);

    expect(redisMock.clearUserTokenVersion).toHaveBeenCalledWith(USER_ID);
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('SET and DEL both failing raises a P1 alert — the caller is not told a silent success', async () => {
    redisMock.setUserTokenVersion.mockRejectedValueOnce(new Error('redis down'));
    redisMock.clearUserTokenVersion.mockRejectedValueOnce(new Error('redis down'));

    await expect(AuthService.revokeAllSessions(USER_ID)).resolves.toBeUndefined();

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][0]).toMatchObject({
      level: 'p1',
      source: 'auth.revokeAllSessions.setTokenVersion',
      context: { userId: USER_ID },
    });
  });
});
