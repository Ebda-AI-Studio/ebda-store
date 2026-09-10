/**
 * A rotation race is not a replay.
 *
 * Two browser contexts (two admin tabs, or admin + the orders PWA) whose
 * access tokens expire in the same instant both POST /auth/refresh with the
 * same cookie. One wins and rotates the row; the other arrives milliseconds
 * later holding a token the service has just marked `rotated`. Reuse
 * detection read that as a compromised family and revoked EVERY session the
 * user had open.
 *
 * Measured in production on 2026-09-10: 46 sessions for one user revoked in a
 * single second, the triggering token rotated 1.8 seconds earlier. Across all
 * history `reuse_detected` (58) had overtaken `rotated` (48) as the reason
 * sessions end — the control was firing mostly on its own users.
 *
 * These tests pin the exemption's exact shape. It is a deliberate hole in a
 * security control, so every condition that keeps it narrow is asserted, not
 * just the happy path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockLogger } = vi.hoisted(() => ({
  mockPrisma: {
    refreshToken: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@force/database', () => ({ prisma: mockPrisma, Prisma: {} }));
vi.mock('@api/lib/logger', () => ({ default: mockLogger }));
vi.mock('@api/services/redis.service', () => ({
  redis: { isAvailable: vi.fn().mockReturnValue(false), getClient: vi.fn() },
}));

const { AuthService } = await import('@api/services/auth.service');

const USER = {
  id: 'user-1',
  email: 'merchant@example.com',
  role: 'store_owner',
  storeId: 'store-1',
  tokenVersion: 0,
  deletedAt: null,
};

/** A refresh-token row as the service reads it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'tok-old',
    userId: USER.id,
    user: USER,
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    revokedReason: null,
    replacedById: null,
    ...over,
  };
}

const secondsAgo = (n: number) => new Date(Date.now() - n * 1000);

/**
 * Wire `findUnique` for a single presentation.
 *
 * By-token lookups (the presented refresh token) resolve to `stored`; by-id
 * lookups — the successor-chain walk — resolve from `successors`. The default
 * empty chain means "the successor is not there", which is itself a denial, so
 * every forgiven test has to name a live tip explicitly.
 */
function present(stored: unknown, successors: Record<string, unknown> = {}) {
  mockPrisma.refreshToken.findUnique.mockImplementation(async (args: any) => {
    if (args?.where?.id !== undefined) return successors[args.where.id] ?? null;
    return stored;
  });
}

/** The live tip of a family: rotated into, not yet rotated out of. */
const LIVE_SUCCESSOR = { 'tok-new': row({ id: 'tok-new', revokedAt: null, revokedReason: null }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.refreshToken.update.mockResolvedValue({});
  mockPrisma.refreshToken.create.mockResolvedValue({});
});

describe('the race is forgiven', () => {
  it('issues fresh tokens instead of revoking the family', async () => {
    present(
      row({ revokedAt: secondsAgo(2), revokedReason: 'rotated', replacedById: 'tok-new' }),
      LIVE_SUCCESSOR
    );

    const tokens = await AuthService.refreshTokens('any-token');

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    // The whole point: no mass revocation.
    expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('does not slide the grace window forward on repeated replays', async () => {
    // Re-stamping `revokedAt` on the race path would make a 30s exemption
    // permanent for whoever holds that token.
    present(
      row({ revokedAt: secondsAgo(2), revokedReason: 'rotated', replacedById: 'tok-new' }),
      LIVE_SUCCESSOR
    );

    await AuthService.refreshTokens('any-token');

    const rewroteOldRow = mockPrisma.refreshToken.update.mock.calls.some(
      c => c[0]?.where?.id === 'tok-old'
    );
    expect(rewroteOldRow).toBe(false);
  });

  it('is loud about it — a hole in a control must be observable', async () => {
    present(
      row({ revokedAt: secondsAgo(1), revokedReason: 'rotated', replacedById: 'tok-new' }),
      LIVE_SUCCESSOR
    );

    await AuthService.refreshTokens('any-token');

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER.id }),
      expect.stringContaining('rotation race')
    );
  });

  it('follows a multi-hop chain to the live tip', async () => {
    // A busy client can rotate more than once inside the grace window. The
    // family is alive as long as SOME descendant is still live, so the walk
    // must not stop at the first successor.
    present(row({ revokedAt: secondsAgo(3), revokedReason: 'rotated', replacedById: 'tok-a' }), {
      'tok-a': row({
        id: 'tok-a',
        revokedAt: secondsAgo(2),
        revokedReason: 'rotated',
        replacedById: 'tok-b',
      }),
      'tok-b': row({ id: 'tok-b', revokedAt: null, revokedReason: null }),
    });

    await AuthService.refreshTokens('any-token');

    expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});

describe('everything else is still a replay', () => {
  it('revokes the family once the window has passed', async () => {
    present(
      row({ revokedAt: secondsAgo(120), revokedReason: 'rotated', replacedById: 'tok-new' }),
      LIVE_SUCCESSOR
    );

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: 'reuse_detected' }),
      })
    );
  });

  it('revokes the family for a token killed by LOGOUT, however recent', async () => {
    // A signed-out token being replayed is the case reuse detection exists
    // for. Recency must not launder it.
    present(
      // NOTE: a successor id and a LIVE successor are supplied deliberately.
      // Without them the back-link / live-chain checks would refuse this row
      // and the test would pass without ever exercising the reason check it
      // exists to pin.
      row({ revokedAt: secondsAgo(1), revokedReason: 'logout', replacedById: 'tok-new' }),
      LIVE_SUCCESSOR
    );

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalled();
  });

  it('revokes the family for a previous reuse event, however recent', async () => {
    present(
      row({ revokedAt: secondsAgo(1), revokedReason: 'reuse_detected', replacedById: 'tok-new' }),
      LIVE_SUCCESSOR
    );

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
  });

  it('revokes the family when no successor exists — nothing was rotated', async () => {
    // `rotated` without a back-link means the successor was never written.
    // Forgiving that would forgive a token that replaced nothing.
    present(row({ revokedAt: secondsAgo(1), revokedReason: 'rotated', replacedById: null }));

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalled();
  });

  it('still rejects an unknown token', async () => {
    present(null);
    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow();
  });
});

/**
 * The grace window must not outrank a revocation.
 *
 * Every mass revocation here is `updateMany({ where: { revokedAt: null } })`,
 * which deliberately leaves already-rotated rows alone. So a row rotated at t0
 * still carries `revokedReason: 'rotated'` and its original `revokedAt` after
 * the account is locked down at t0+5s — recency alone cannot tell the two
 * apart. Only the successor chain records the lockdown, because that is where
 * the revocation landed.
 */
describe('a revoked family stays revoked', () => {
  const killedTip = (reason: string) => ({
    'tok-new': row({ id: 'tok-new', revokedAt: secondsAgo(1), revokedReason: reason }),
  });

  it.each(['revoke_all', 'password_changed', 'password_reset', 'reuse_detected', 'logout'])(
    'refuses a fresh pair after the family was killed by %s',
    async reason => {
      present(
        row({ revokedAt: secondsAgo(2), revokedReason: 'rotated', replacedById: 'tok-new' }),
        killedTip(reason)
      );

      await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
    }
  );

  it('does not mint a 365-day session out of a "sign out all devices"', async () => {
    // The concrete attack: hold a token that rotated seconds before the user
    // hit logout-all. Without the chain check this returned a valid access
    // token (signed with the freshly bumped tv) plus a year-long refresh row —
    // a permanent parallel session created BY the compromise response.
    present(
      row({ revokedAt: secondsAgo(2), revokedReason: 'rotated', replacedById: 'tok-new' }),
      killedTip('revoke_all')
    );

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('refuses when the successor row is gone entirely', async () => {
    // Pruned by cleanupRefreshTokens(), or never written. Nothing proves the
    // family is alive, so it is not assumed to be.
    present(row({ revokedAt: secondsAgo(2), revokedReason: 'rotated', replacedById: 'tok-new' }));

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
  });

  it('refuses a chain that dead-ends without a live tip', async () => {
    present(row({ revokedAt: secondsAgo(3), revokedReason: 'rotated', replacedById: 'tok-a' }), {
      'tok-a': row({
        id: 'tok-a',
        revokedAt: secondsAgo(2),
        revokedReason: 'rotated',
        replacedById: null,
      }),
    });

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
  });

  it('terminates on a cyclic back-link instead of hanging', async () => {
    present(row({ revokedAt: secondsAgo(2), revokedReason: 'rotated', replacedById: 'tok-a' }), {
      'tok-a': row({
        id: 'tok-a',
        revokedAt: secondsAgo(2),
        revokedReason: 'rotated',
        replacedById: 'tok-a',
      }),
    });

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
  });
});
