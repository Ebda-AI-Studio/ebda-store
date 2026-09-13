/**
 * Refresh-token rotation + reuse-detection (auth-critical).
 *
 * Exercises AuthService directly against the integration Postgres from
 * tests/setup.ts (same pattern as auth-gdpr.test.ts — create users via
 * Prisma, drive the service, assert on rows). No HTTP layer: rotation and
 * reuse-detection live entirely in AuthService + the refresh_tokens table,
 * so testing the service is the deterministic way to prove them.
 *
 * Redis (the tokenVersion cache + jti denylist) is NOT connected here; the
 * service fail-opens on a missing client and the DB is the source of truth
 * for refresh-token state, so these assertions are stable without it.
 *
 * Covers:
 *   1. rotation issues a NEW refresh token and revokes the old (rotated).
 *   2. reuse of an already-rotated token revokes the WHOLE family.
 *   3. a normal refresh keeps the session (new access token verifies, live tv).
 *   4. MFA still gates — an mfaEnabled user logging in gets a challenge, no tokens.
 *   5. revokeAllSessions kills an unused refresh token (reuse path on next use).
 */

import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '@force/database';
import { AuthService } from '@api/services/auth.service';
import { config } from '@api/config';

const PASSWORD = 'RotateTest!234';

async function createVerifiedUser(opts: { mfa?: boolean } = {}) {
  const email = `rot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: 'Rotate',
      lastName: 'Tester',
      role: 'customer',
      emailVerified: true,
      // A non-null mfaSecret + mfaEnabled is what makes login() return a
      // challenge instead of a session. The value just needs to be present;
      // we never verify a TOTP code in this suite.
      ...(opts.mfa ? { mfaEnabled: true, mfaSecret: 'enc:dummy-secret' } : {}),
    },
    select: { id: true, email: true, tokenVersion: true },
  });
  return { ...user, password: PASSWORD };
}

/** SHA-256 hex of a refresh token — matches how AuthService stores rows. */
function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

describe('refresh-token rotation', () => {
  it('rotation issues a new refresh token and revokes the old one', async () => {
    const u = await createVerifiedUser();
    const session = await AuthService.login(u.email, u.password);
    // login on a non-MFA user returns a full session
    expect('refreshToken' in session).toBe(true);
    const original = (session as { refreshToken: string }).refreshToken;

    const rotated = await AuthService.refreshTokens(original);

    // A genuinely new refresh token is issued.
    expect(rotated.refreshToken).toBeDefined();
    expect(rotated.refreshToken).not.toBe(original);

    // The old row is now revoked with reason 'rotated' and back-links to the new row.
    const oldRow = await prisma.refreshToken.findUnique({ where: { token: hash(original) } });
    const newRow = await prisma.refreshToken.findUnique({
      where: { token: hash(rotated.refreshToken) },
    });
    expect(oldRow?.revokedAt).not.toBeNull();
    expect(oldRow?.revokedReason).toBe('rotated');
    expect(newRow).not.toBeNull();
    expect(oldRow?.replacedById).toBe(newRow?.id);

    // The new refresh token is still live (not revoked).
    expect(newRow?.revokedAt).toBeNull();
  });

  it('an IMMEDIATE replay is a rotation race and is forgiven', async () => {
    // Two tabs whose access tokens expire together both refresh with the same
    // cookie. The loser arrives milliseconds after the winner rotated the row.
    // Punishing that logged the user out of every session they had open —
    // measured in production 2026-09-10 as 46 revocations in one second.
    const u = await createVerifiedUser();
    const session = (await AuthService.login(u.email, u.password)) as { refreshToken: string };

    const rotated = await AuthService.refreshTokens(session.refreshToken);
    expect(rotated.refreshToken).toBeDefined();

    // Sub-second replay of the ORIGINAL, well inside ROTATION_RACE_GRACE_MS.
    const raced = await AuthService.refreshTokens(session.refreshToken);
    expect(raced.refreshToken).toBeDefined();
    expect(raced.accessToken).toBeDefined();

    // The family survives, and the legitimate successor still works.
    const live = await prisma.refreshToken.count({
      where: { userId: u.id, revokedAt: null },
    });
    expect(live).toBeGreaterThan(0);
    await expect(AuthService.refreshTokens(rotated.refreshToken)).resolves.toBeDefined();
  });

  it('a replay OUTSIDE the grace window still revokes the whole family', async () => {
    const u = await createVerifiedUser();
    const session = (await AuthService.login(u.email, u.password)) as { refreshToken: string };

    const rotated = await AuthService.refreshTokens(session.refreshToken);
    expect(rotated.refreshToken).toBeDefined();

    // Back-date the rotation so the replay lands outside the grace window.
    // Age is the discriminator between "my other tab" and "someone holding a
    // token they should not have", so this is the case the control exists for.
    const originalHash = crypto.createHash('sha256').update(session.refreshToken).digest('hex');
    await prisma.refreshToken.update({
      where: { token: originalHash },
      data: { revokedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    await expect(AuthService.refreshTokens(session.refreshToken)).rejects.toMatchObject({
      code: 'TOKEN_REUSED',
    });

    // Every token for the user is revoked — including the rotated-out token's
    // legitimate successor. That collateral damage is the POINT: a stolen
    // token must not keep working just because the thief refreshed it once.
    const live = await prisma.refreshToken.count({
      where: { userId: u.id, revokedAt: null },
    });
    expect(live).toBe(0);

    await expect(AuthService.refreshTokens(rotated.refreshToken)).rejects.toMatchObject({
      code: 'TOKEN_REUSED',
    });
  });

  it('a normal refresh keeps the session — new access token verifies with live tv', async () => {
    const u = await createVerifiedUser();
    const session = (await AuthService.login(u.email, u.password)) as {
      accessToken: string;
      refreshToken: string;
    };

    const rotated = await AuthService.refreshTokens(session.refreshToken);

    // The rotated access token is a valid JWT for this app and carries the
    // user's current tokenVersion (tv) — so the authenticate middleware's
    // tv check would NOT reject it.
    const payload = jwt.verify(rotated.accessToken, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'force-api',
      audience: 'force-app',
    }) as { userId: string; tv?: number; type?: string };

    expect(payload.userId).toBe(u.id);
    expect(payload.type).toBeUndefined(); // access token, not a refresh token
    const current = await prisma.user.findUnique({
      where: { id: u.id },
      select: { tokenVersion: true },
    });
    expect(payload.tv ?? 0).toBe(current?.tokenVersion ?? 0);
  });

  it('MFA still gates — an mfaEnabled user logging in gets a challenge, not a session', async () => {
    const u = await createVerifiedUser({ mfa: true });
    const result = (await AuthService.login(u.email, u.password)) as {
      mfaRequired?: boolean;
      challengeToken?: string;
      refreshToken?: string;
    };

    // No real session is issued — only a challenge token.
    expect(result.mfaRequired).toBe(true);
    expect(result.challengeToken).toBeDefined();
    expect(result.refreshToken).toBeUndefined();

    // The challenge token is scoped to a DISTINCT audience so it can never be
    // used as an access token (token-confusion guard).
    const decoded = jwt.verify(result.challengeToken!, config.jwtSecret, {
      issuer: 'force-api',
      audience: 'force-mfa-challenge',
    }) as { purpose?: string };
    expect(decoded.purpose).toBe('mfa');

    // No refresh-token row was created for an unverified MFA login.
    const rows = await prisma.refreshToken.count({ where: { userId: u.id } });
    expect(rows).toBe(0);
  });

  it('revokeAllSessions kills an unused refresh token', async () => {
    const u = await createVerifiedUser();
    const session = (await AuthService.login(u.email, u.password)) as { refreshToken: string };

    // Bulk revocation (logout-all / password change). Bumps tokenVersion AND
    // revokes every live refresh token.
    await AuthService.revokeAllSessions(u.id);

    // The not-yet-rotated refresh token is now revoked, so presenting it
    // trips the reuse-detection path rather than rotating cleanly.
    await expect(AuthService.refreshTokens(session.refreshToken)).rejects.toMatchObject({
      code: 'TOKEN_REUSED',
    });
  });
});

/**
 * A password reset must end every session it finds, the way a password change
 * already did.
 *
 * `resetPassword` used to revoke refresh rows with a bare `updateMany` and
 * never touch `tokenVersion`. Two consequences, and the second is the one that
 * matters:
 *
 *   1. The mid-flight guard in `refreshTokens` — which re-reads `tokenVersion`
 *      after writing its new row, to learn whether a revocation landed
 *      underneath it — was a NO-OP on this path. It arbitrates on a number a
 *      reset never moved.
 *   2. Independently of any race, every ACCESS token already issued survived
 *      the reset for the rest of its life (30 minutes by default). A password
 *      CHANGE killed them immediately. A password RESET did not — and a reset
 *      is the one a compromised user performs precisely because they believe
 *      someone else is holding their credentials.
 *
 * Both paths now go through `revokeAllSessions`, which bumps first and revokes
 * second, and carries the reason so `revokedReason` stays the forensic record
 * of WHY a session died.
 */
describe('password reset and change end every session', () => {
  /** Mint a reset token the way requestPasswordReset does, and return the raw value. */
  async function seedResetToken(userId: string): Promise<string> {
    const raw = crypto.randomBytes(32).toString('hex');
    await prisma.refreshToken.create({
      data: {
        token: `reset:${hash(raw)}`,
        userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return raw;
  }

  it('a reset BUMPS tokenVersion, so outstanding access tokens die with it', async () => {
    const u = await createVerifiedUser();
    const before = await prisma.user.findUnique({
      where: { id: u.id },
      select: { tokenVersion: true },
    });

    await AuthService.resetPassword(await seedResetToken(u.id), 'BrandNew!2345');

    const after = await prisma.user.findUnique({
      where: { id: u.id },
      select: { tokenVersion: true },
    });
    expect(after!.tokenVersion).toBeGreaterThan(before!.tokenVersion);
  });

  it('a reset revokes live sessions and keeps `password_reset` as the reason', async () => {
    // The reason is the only forensic signal that distinguishes a redeemed
    // reset from a sign-out-everywhere, so routing through revokeAllSessions
    // must not flatten it to a generic `revoke_all`.
    const u = await createVerifiedUser();
    const session = await AuthService.login(u.email, u.password);
    expect('refreshToken' in session).toBe(true);

    await AuthService.resetPassword(await seedResetToken(u.id), 'BrandNew!2345');

    const rows = await prisma.refreshToken.findMany({
      where: { userId: u.id, token: { not: { startsWith: 'reset:' } } },
      select: { revokedAt: true, revokedReason: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.revokedAt !== null)).toBe(true);
    expect(rows.map(r => r.revokedReason)).toContain('password_reset');
  });

  it('the reset token itself is consumed, not left live', async () => {
    const u = await createVerifiedUser();
    const raw = await seedResetToken(u.id);

    await AuthService.resetPassword(raw, 'BrandNew!2345');

    const reused = prisma.refreshToken.findFirst({ where: { token: `reset:${hash(raw)}` } });
    await expect(reused).resolves.toBeNull();
  });

  it('a password change still bumps tv and still records `password_changed`', async () => {
    // The control: this path already worked, and the reordering must not have
    // broken it or lost its reason.
    const u = await createVerifiedUser();
    await AuthService.login(u.email, u.password);
    const before = await prisma.user.findUnique({
      where: { id: u.id },
      select: { tokenVersion: true },
    });

    await AuthService.changePassword(u.id, u.password, 'BrandNew!2345');

    const after = await prisma.user.findUnique({
      where: { id: u.id },
      select: { tokenVersion: true },
    });
    expect(after!.tokenVersion).toBeGreaterThan(before!.tokenVersion);

    const rows = await prisma.refreshToken.findMany({
      where: { userId: u.id },
      select: { revokedAt: true, revokedReason: true },
    });
    expect(rows.every(r => r.revokedAt !== null)).toBe(true);
    expect(rows.map(r => r.revokedReason)).toContain('password_changed');
  });
});
