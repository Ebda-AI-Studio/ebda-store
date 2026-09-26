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
  EmailService: { sendOrderConfirmation: vi.fn(), sendAdminNewOrder: vi.fn() },
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

const { mockPrisma, redisMock, sendMock } = vi.hoisted(() => {
  const mockPrisma = {
    user: { update: vi.fn() },
    refreshToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    merchantApiKey: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const redisMock = { setUserTokenVersion: vi.fn().mockResolvedValue(undefined) };
  const sendMock = vi.fn().mockResolvedValue({ ids: [] });
  return { mockPrisma, redisMock, sendMock };
});

vi.mock('@api/services/redis.service', () => ({ redis: redisMock }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: sendMock } }));

vi.mock('@force/database', () => ({
  prisma: mockPrisma,
  Prisma: {},
  hasTenantContext: () => false,
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
    expect(mockPrisma.merchantApiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID, revokedAt: null } })
    );
  });
});
