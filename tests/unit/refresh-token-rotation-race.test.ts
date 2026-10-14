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

/**
 * The store is real, not stubbed.
 *
 * The grace cap and the conditional rotation write are compare-and-set
 * operations: their whole value is what happens when a row has already moved
 * under them. A `updateMany` mocked to a fixed `{ count: n }` cannot tell a
 * claim that landed from one that was beaten to it, so it would report these
 * tests green against code that never checked. The rows live in a map and the
 * writes filter it, so a CAS that matches nothing returns 0 here for the same
 * reason it would in Postgres.
 */
const { mockPrisma, TOKEN_OWNER, mockLogger, store, byToken, reset } = vi.hoisted(() => {
  const store = new Map<string, any>();
  const byToken = new Map<string, any>();
  let seq = 0;

  const matches = (r: any, where: any = {}) =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
        if ('not' in v) return v.not === null ? r[k] !== null : r[k] !== v.not;
        if ('lt' in v) return r[k] !== null && r[k] < v.lt;
        if ('gte' in v) return r[k] !== null && r[k] >= v.gte;
        return false;
      }
      return r[k] === v;
    });

  // The token's owner is read AS themselves (`withUser`), not joined from the token row.
  const TOKEN_OWNER = (over: Record<string, unknown> = {}) => ({
    id: 'user-1',
    email: 'merchant@example.com',
    role: 'store_owner',
    storeId: 'store-1',
    status: 'active',
    deletedAt: null,
    tokenVersion: 0,
    ...over,
  });

  const mockPrisma = {
    refreshToken: {
      // Reads return COPIES. Prisma hands every caller its own object, and
      // two concurrent rotations sharing one reference is the difference
      // between a test that exercises a compare-and-set and a test where the
      // second caller silently observes the first caller's write in memory
      // and skips the write entirely.
      findUnique: vi.fn(async (args: any) => {
        const r =
          args?.where?.id !== undefined
            ? store.get(args.where.id)
            : (byToken.get(args?.where?.token) ?? byToken.get('__presented__'));
        return r ? { ...r } : null;
      }),
      findMany: vi.fn(async (args: any) =>
        [...store.values()].filter(r => matches(r, args?.where)).map(r => ({ ...r }))
      ),
      updateMany: vi.fn(async (args: any) => {
        const hits = [...store.values()].filter(r => matches(r, args?.where));
        hits.forEach(r => Object.assign(r, args.data));
        return { count: hits.length };
      }),
      update: vi.fn(async (args: any) => {
        const r = store.get(args.where.id);
        if (r) Object.assign(r, args.data);
        return r ?? {};
      }),
      create: vi.fn(async (args: any) => {
        const r = {
          id: `minted-${++seq}`,
          revokedAt: null,
          revokedReason: null,
          replacedById: null,
          createdAt: new Date(),
          ...args.data,
        };
        store.set(r.id, r);
        byToken.set(r.token, r);
        return r;
      }),
    },
    user: {
      findUnique: vi.fn(async () => TOKEN_OWNER()),
    },
  };

  const reset = () => {
    store.clear();
    byToken.clear();
    seq = 0;
    mockPrisma.user.findUnique.mockImplementation(async () => TOKEN_OWNER());
  };

  return {
    mockPrisma,
    TOKEN_OWNER,
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    store,
    byToken,
    reset,
  };
});

// `withUser` (the token owner is read as themselves under strict RLS) runs on the same fake client.
vi.mock('@ebda/database', async () => ({
  ...(await import('./helpers/database-mock')).databaseMock({ prisma: mockPrisma }),
  Prisma: {},
}));
// `getUserState` is the `ebda_user_state` definer; `user.findUnique` stays the source of truth.
// `refreshTokenUser` is the `ebda_refresh_token_user` definer: the presented token names its owner.
vi.mock('@api/lib/definer', () => ({
  refreshTokenUser: async () => byToken.get('__presented__')?.userId ?? null,
  getUserState: async () => (await mockPrisma.user.findUnique()) ?? null,
}));
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
  // S3-1, 2026-09-22 security audit: refreshTokens() now rejects a
  // non-active account — this fixture's user must be active, or every rotation
  // test below (none of which is about account status) fails on a check
  // unrelated to what it's testing.
  status: 'active',
};

/** A refresh-token row as the service reads it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'tok-old',
    userId: USER.id,
    user: USER,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(Date.now() - 86_400_000),
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
function present(stored: any, successors: Record<string, any> = {}) {
  if (stored) {
    store.set(stored.id, stored);
    byToken.set('__presented__', stored);
  }
  Object.values(successors).forEach((r: any) => store.set(r.id, r));
}

/** Did this presentation burn the family down? */
const familyRevoked = () =>
  mockPrisma.refreshToken.updateMany.mock.calls.some(
    (c: any[]) => c[0]?.data?.revokedReason === 'reuse_detected'
  );

/** The row as it stands in the database after the call under test. */
const stored = (id = 'tok-old') => store.get(id);

/**
 * The live tip of a family: rotated into, not yet rotated out of.
 *
 * A factory, not a constant. The store is real and the service's writes mutate
 * the rows in it, so a shared literal would carry one test's revocation into
 * the next and quietly decide its outcome.
 */
const liveSuccessor = () => ({
  'tok-new': row({ id: 'tok-new', revokedAt: null, revokedReason: null }),
});

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

describe('the race is forgiven', () => {
  it('issues fresh tokens instead of revoking the family', async () => {
    present(
      row({ revokedAt: secondsAgo(2), revokedReason: 'rotated', replacedById: 'tok-new' }),
      liveSuccessor()
    );

    const tokens = await AuthService.refreshTokens('any-token');

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    // The whole point: no mass revocation.
    expect(familyRevoked()).toBe(false);
  });

  it('does not slide the grace window forward on repeated replays', async () => {
    // Re-stamping `revokedAt` on the race path would make a 30s exemption
    // permanent for whoever holds that token.
    present(
      row({ revokedAt: secondsAgo(2), revokedReason: 'rotated', replacedById: 'tok-new' }),
      liveSuccessor()
    );

    const revokedAtBefore = stored().revokedAt;

    await AuthService.refreshTokens('any-token');

    expect(stored().revokedAt).toEqual(revokedAtBefore);
  });

  it('is loud about it — a hole in a control must be observable', async () => {
    present(
      row({ revokedAt: secondsAgo(1), revokedReason: 'rotated', replacedById: 'tok-new' }),
      liveSuccessor()
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

    expect(familyRevoked()).toBe(false);
  });
});

describe('everything else is still a replay', () => {
  it('revokes the family once the window has passed', async () => {
    present(
      row({ revokedAt: secondsAgo(120), revokedReason: 'rotated', replacedById: 'tok-new' }),
      liveSuccessor()
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
      liveSuccessor()
    );

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalled();
  });

  it('revokes the family for a previous reuse event, however recent', async () => {
    present(
      row({ revokedAt: secondsAgo(1), revokedReason: 'reuse_detected', replacedById: 'tok-new' }),
      liveSuccessor()
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

/**
 * The window bounds the OPPORTUNITY to replay. On its own it bounds nothing
 * about the CONSEQUENCE: the same rotated row could be presented in a loop for
 * the whole thirty seconds, and every pass minted a separate full-length
 * session with no record on the row that it had ever been forgiven.
 */
describe('the grace is a bounded budget, not an open window', () => {
  const raced = () =>
    row({ revokedAt: secondsAgo(1), revokedReason: 'rotated', replacedById: 'tok-new' });

  it('forgives one row a fixed number of times, then treats it as a replay', async () => {
    present(raced(), liveSuccessor());

    // Five is the budget. Each pass re-presents the SAME row, exactly as a
    // replay loop would.
    for (let i = 1; i <= 5; i++) {
      await expect(AuthService.refreshTokens('any-token')).resolves.toBeTruthy();
      expect(familyRevoked()).toBe(false);
    }

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
    expect(familyRevoked()).toBe(true);
  });

  it('records each forgiveness on the row it forgave', async () => {
    present(raced(), liveSuccessor());

    await AuthService.refreshTokens('any-token');
    expect(stored().revokedReason).toBe('rotated_grace_1');

    await AuthService.refreshTokens('any-token');
    expect(stored().revokedReason).toBe('rotated_grace_2');
  });

  it('still recognises a partly-spent row as a rotation, mid-chain', async () => {
    // A row forgiven once is still a row that ended by rotating. If the chain
    // walk read `rotated_grace_1` as "revoked by something else" it would call
    // a live family dead and log the user out — the exact regression the
    // exemption exists to prevent.
    present(row({ revokedAt: secondsAgo(3), revokedReason: 'rotated', replacedById: 'tok-a' }), {
      'tok-a': row({
        id: 'tok-a',
        revokedAt: secondsAgo(2),
        revokedReason: 'rotated_grace_1',
        replacedById: 'tok-b',
      }),
      'tok-b': row({ id: 'tok-b', revokedAt: null, revokedReason: null }),
    });

    await expect(AuthService.refreshTokens('any-token')).resolves.toBeTruthy();
    expect(familyRevoked()).toBe(false);
  });

  it('fails closed on a grace count it did not write', async () => {
    // An unparseable counter is corruption. Reading it as zero would reopen
    // the hole; reading it as spent closes it.
    present(
      row({
        revokedAt: secondsAgo(1),
        revokedReason: 'rotated_grace_zzz',
        replacedById: 'tok-new',
      }),
      liveSuccessor()
    );

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);
  });
});

/**
 * A rotation renews the clock. Being forgiven for a replay is not a rotation.
 */
describe('being forgiven does not renew the clock', () => {
  const TEN_DAYS = new Date(Date.now() + 10 * 86_400_000);

  it('hands back what was left of the presented token, not a fresh year', async () => {
    present(
      row({
        expiresAt: TEN_DAYS,
        revokedAt: secondsAgo(1),
        revokedReason: 'rotated',
        replacedById: 'tok-new',
      }),
      liveSuccessor()
    );

    await AuthService.refreshTokens('any-token');

    const minted = mockPrisma.refreshToken.create.mock.calls[0][0].data;
    expect(minted.expiresAt).toEqual(TEN_DAYS);
  });

  it('still renews the clock on an ordinary rotation', async () => {
    // The bound applies to the forgiven hop only. A live token rotating
    // normally is a session in good standing and keeps its full lifetime.
    present(row({ expiresAt: TEN_DAYS }));

    await AuthService.refreshTokens('any-token');

    const minted = mockPrisma.refreshToken.create.mock.calls[0][0].data;
    expect(minted.expiresAt.getTime()).toBeGreaterThan(Date.now() + 300 * 86_400_000);
  });
});

/**
 * Two requests rotating the SAME live row both read it as live. The second
 * must not overwrite the first's back-link: `replacedById` is how the chain
 * walk finds a live tip, and a link repointed at the loser's branch sends the
 * walk down a chain whose tip nobody is using.
 */
describe('the back-link is written once', () => {
  it('keeps the first rotation’s successor when two rotations race', async () => {
    present(row());

    await Promise.all([
      AuthService.refreshTokens('any-token'),
      AuthService.refreshTokens('any-token'),
    ]);

    expect(mockPrisma.refreshToken.create).toHaveBeenCalledTimes(2);
    const firstMinted = await mockPrisma.refreshToken.create.mock.results[0].value;
    expect(stored().replacedById).toBe(firstMinted.id);
    expect(stored().revokedReason).toBe('rotated');
  });
});

/**
 * The liveness check and the row that answers it are not one atomic step.
 */
describe('a revocation landing mid-refresh wins', () => {
  it('discards the token it just minted and refuses the refresh', async () => {
    present(row());
    // Sign-out-everywhere, a password change and a password reset all bump
    // tokenVersion before revoking rows. Landing between our read and our
    // write, it would otherwise miss the row we are about to create.
    // 1st read: the token's owner (still at the version we read); 2nd: the post-write re-read.
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(TOKEN_OWNER())
      .mockResolvedValue(TOKEN_OWNER({ tokenVersion: USER.tokenVersion + 1 }));

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/revoked/i);

    const minted = await mockPrisma.refreshToken.create.mock.results[0].value;
    expect(store.get(minted.id).revokedAt).not.toBeNull();
    expect(store.get(minted.id).revokedReason).toBe('revoke_all');
  });
});

/**
 * What the chain walk COSTS, on the shape it actually meets.
 *
 * The first version of this suite asserted `findMany` was called exactly once
 * and no by-id lookups happened at all. That banned the cheap read and locked
 * in the expensive one: `RefreshToken` has `@@index([userId])` but no
 * `(userId, createdAt)` composite, so an ordered `take: 500` makes Postgres
 * fetch every row for that user and sort. Meanwhile the chain is almost always
 * ONE hop — the presented row's successor IS the live tip — which is a single
 * primary-key lookup. The test was pinning a pessimisation.
 *
 * These assert a BOUND on total queries instead, which is the property that
 * was ever wanted, and they name the common case separately from the rare one.
 */
describe('the chain walk pays for the shape it meets', () => {
  it('costs ONE point lookup when the successor is the live tip', () => {
    // The common case, and the one the old assertion made worse.
    return (async () => {
      present(
        row({ revokedAt: secondsAgo(2), revokedReason: 'rotated', replacedById: 'tok-new' }),
        liveSuccessor()
      );

      await AuthService.refreshTokens('any-token');

      const walkLookups = mockPrisma.refreshToken.findUnique.mock.calls.filter(
        (c: any) => c[0]?.where?.id === 'tok-new'
      );
      expect(walkLookups).toHaveLength(1);
      // No per-user scan at all on this path.
      expect(mockPrisma.refreshToken.findMany).not.toHaveBeenCalled();
    })();
  });

  it('does not issue a round-trip per hop on a deep chain', async () => {
    // The rare case the bulk read exists for: three hops. The walk must not
    // cost three round-trips, and it must not cost more than the one cheap
    // lookup plus the one slice read.
    present(row({ revokedAt: secondsAgo(3), revokedReason: 'rotated', replacedById: 'tok-a' }), {
      'tok-a': row({
        id: 'tok-a',
        revokedAt: secondsAgo(2),
        revokedReason: 'rotated',
        replacedById: 'tok-b',
      }),
      'tok-b': row({
        id: 'tok-b',
        revokedAt: secondsAgo(1),
        revokedReason: 'rotated',
        replacedById: 'tok-c',
      }),
      'tok-c': row({ id: 'tok-c', revokedAt: null, revokedReason: null }),
    });

    await AuthService.refreshTokens('any-token');

    expect(mockPrisma.refreshToken.findMany).toHaveBeenCalledTimes(1);
    const walkLookups = mockPrisma.refreshToken.findUnique.mock.calls.filter(
      (c: any) => c[0]?.where?.id !== undefined
    );
    // Hop 1 only. Hops 2 and 3 come out of the slice already read.
    expect(walkLookups).toHaveLength(1);
  });
});

/**
 * Exhausting the budget is a different event from replaying a stolen token.
 *
 * Both end in the same place — every session for the user revoked — but only
 * one of them means the cap is set too low for how this merchant works. Every
 * tab of admin, orders and the storefront shares ONE refresh cookie, so six
 * simultaneous tabs is ordinary and the sixth replay burns the account out of
 * all of them. The log line that was supposed to make an undersized cap
 * visible only ran on the SUCCESS path, so the case that matters never reached
 * it.
 */
describe('an exhausted grace budget is legible in the log', () => {
  const raced = () =>
    row({ revokedAt: secondsAgo(1), revokedReason: 'rotated', replacedById: 'tok-new' });

  it('says so, and says what the cap was', async () => {
    present(raced(), liveSuccessor());
    for (let i = 0; i < 5; i++) await AuthService.refreshTokens('any-token');

    mockLogger.warn.mockClear();
    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        graceExhausted: true,
        graceUsesSpent: 5,
        graceUsesAllowed: 5,
      }),
      expect.stringContaining('grace budget exhausted')
    );
  });

  it('does NOT claim exhaustion for a genuine replay', async () => {
    // The negative control. A log that said `graceExhausted: true` on every
    // revocation would satisfy the test above and tell an operator nothing.
    present(
      row({ revokedAt: secondsAgo(120), revokedReason: 'rotated', replacedById: 'tok-new' }),
      liveSuccessor()
    );

    await expect(AuthService.refreshTokens('any-token')).rejects.toThrow(/reuse/i);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ graceExhausted: false }),
      expect.stringContaining('reuse detected')
    );
  });
});
