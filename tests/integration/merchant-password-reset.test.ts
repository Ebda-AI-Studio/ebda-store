/**
 * Password reset on the Store, end to end against a real Postgres (local container in dev, the CI service container in CI;
 * never Neon).
 *
 * Since Stage 3 (Rulings ID-1/ID-2) a MERCHANT's credential and reset live in the shared identity service (accounts): the Store
 * issues no reset token or mail for a store_id NULL account, it only hands the request over. The one-time code, its expiry and
 * single use, the mail and the new credential are covered there: apps/accounts/test/rpc.test.ts (forgotPassword mails a
 * password_reset code, silent for an unknown address) and apps/accounts/test/identity.test.ts ('password reset: generic answer,
 * code resets, every session dies, the old password stops working'), with the Store half in
 * tests/unit/identity-lifecycle-paths.test.ts.
 *
 * What this file keeps proving against the real database is the Store's own reset engine, which still serves STOREFRONT
 * CUSTOMERS (users.store_id set): hashed single-use token, atomic claim, password policy, session revocation, MFA and passkey
 * handling, lockout clearing, the byte-identical answer; plus the Store contract for a merchant (delegated, nothing issued).
 *
 * Mutation proofs (run by hand 2026-10-07, recorded in the PR body):
 *   1. auth.service.ts resetPassword: replace the atomic `deleteMany` claim with
 *      `{ count: 1 }` -> "two concurrent redemptions" fails (both requests 200).
 *      (Sequential reuse stays blocked even then: revokeAllSessions deletes every
 *      `reset:` row, so the race is the case only the claim covers.)
 *   2. auth.routes.ts /forgot-password: answer the found branch with a
 *      different message -> "unknown and known addresses get the byte-identical
 *      answer" fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@ebda/database';
import authRoutes from '@api/routes/auth.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { createAuthLimiter, createResetEmailLimiter } from '@api/middleware/security';
import { accountLockout } from '@api/services/account-lockout.service';
import { AuthService, RESET_TOKEN_TTL_MINUTES } from '@api/services/auth.service';
import { configureIdentityClient } from '@api/lib/identity-client';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { hasDb } from '../helpers/bundle-fixtures';

const run = crypto.randomUUID().slice(0, 8);
const OLD_PASSWORD = 'Str0ng!Passw0rd';
const NEW_PASSWORD = 'N3w!Passw0rd-x';
const emails: string[] = [];
const storeIds: string[] = [];
const ownerIds: string[] = [];

function mkEmail(tag: string) {
  const e = `pwr-${tag}-${run}@test.local`;
  emails.push(e);
  return e;
}

function buildApp(): Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  // Mounted exactly as apps/api/src/routes/index.ts mounts it.
  app.use('/api/v1/auth', authRoutes);
  app.use(errorHandler);
  return app;
}

describe.skipIf(!hasDb)('password reset (Ebda Store)', () => {
  let app: Express;
  const api = () => request(app);
  /** Addresses handed to the (fake) identity service's forgotPassword. */
  const forgot: string[] = [];
  let storeId = '';

  /** A storefront customer: the Store still owns this credential, so the Store's reset engine is the subject. */
  async function customer(tag: string) {
    const email = mkEmail(tag);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(OLD_PASSWORD, 4),
        firstName: 'Mona',
        lastName: 'Hassan',
        role: 'customer',
        storeId,
        emailVerified: true,
        language: 'ar',
      },
    });
    return { email, userId: user.id };
  }
  /** A merchant account (store_id NULL): its credential is the identity service's. */
  async function merchant(tag: string) {
    const email = mkEmail(tag);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: '!identity',
        firstName: 'Mona',
        lastName: 'Hassan',
        role: 'store_admin',
        emailVerified: true,
      },
    });
    return { email, userId: user.id };
  }

  const login = (email: string, password: string) =>
    api().post('/api/v1/auth/login').send({ email, password, storeId });
  const forgotPassword = (body: Record<string, unknown>) =>
    api().post('/api/v1/auth/forgot-password').send(body);
  const resetRows = (userId: string) =>
    prisma.refreshToken.findMany({ where: { userId, token: { startsWith: 'reset:' } } });
  /** A raw reset token as the Store issues it for a customer (the mail that carries it is the store's branded sender). */
  const issueToken = (userId: string) => AuthService.issueStaffInviteToken(userId);

  const reset = (token: unknown, password: string = NEW_PASSWORD) =>
    api().post('/api/v1/auth/reset-password').send({ token, password });

  beforeAll(async () => {
    app = buildApp();
    configureIdentityClient({
      forgotPassword: async email => void forgot.push(email),
      revokeUser: async () => undefined,
    });
    const owner = await prisma.user.create({
      data: {
        email: mkEmail('owner'),
        passwordHash: '!identity',
        firstName: 'O',
        lastName: 'W',
        role: 'store_admin',
        emailVerified: true,
      },
    });
    ownerIds.push(owner.id);
    const store = await prisma.store.create({
      data: { name: `pwr-${run}`, slug: `pwr-${run}`, ownerId: owner.id, status: 'active' },
    });
    storeId = store.id;
    storeIds.push(store.id);
  });

  afterAll(async () => {
    configureIdentityClient(undefined);
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    const ids = users.map(u => u.id);
    await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.verificationToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids }, storeId: { not: null } } });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it('happy path: stores only a hash with a short expiry, sets the password, old one dies, audit rows are masked', async () => {
    const { email, userId } = await customer('happy');
    const res = await forgotPassword({ email, storeId });
    expect(res.body).toEqual({
      success: true,
      data: { message: 'If an account exists with this email, a reset link has been sent.' },
    });
    await awaitDeferredWork(5000);
    // The request issued exactly one hashed token; the identity service was not involved for a customer.
    expect(await resetRows(userId)).toHaveLength(1);
    expect(forgot).not.toContain(email);

    const token = await issueToken(userId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const rows = await resetRows(userId);
    const mine = rows.find(
      r => r.token === `reset:${crypto.createHash('sha256').update(token).digest('hex')}`
    );
    expect(mine, 'only the SHA-256 is stored').toBeTruthy();
    expect(rows.some(r => r.token.includes(token))).toBe(false);
    const minutes = (mine!.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(RESET_TOKEN_TTL_MINUTES - 1);
    expect(minutes).toBeLessThanOrEqual(RESET_TOKEN_TTL_MINUTES);

    const done = await reset(token);
    expect(done.status).toBe(200);
    expect(done.body.success).toBe(true);

    expect((await login(email, OLD_PASSWORD)).status).toBe(401);
    const fresh = await login(email, NEW_PASSWORD);
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.accessToken).toBeTruthy();

    const audit = await prisma.auditLog.findMany({
      where: { userId, action: { startsWith: 'auth.password_reset.' } },
      select: { action: true, details: true },
    });
    expect(audit.map(a => a.action).sort()).toEqual([
      'auth.password_reset.completed',
      'auth.password_reset.requested',
    ]);
    expect(JSON.stringify(audit)).not.toContain(email);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('a merchant (store_id NULL) is handed to the identity service: the Store issues no token and no mail of its own', async () => {
    const { email, userId } = await merchant('delegated');
    forgot.length = 0;
    const res = await forgotPassword({ email });
    expect(res.status).toBe(200);
    await awaitDeferredWork(5000);
    await new Promise(r => setTimeout(r, 100)); // cfWaitUntil is detached outside a Worker request
    expect(forgot).toEqual([email]);
    expect(await resetRows(userId)).toHaveLength(0);
  });

  it('revokes every session: old access token 401s, old refresh token is dead, tokenVersion moved', async () => {
    const { email, userId } = await customer('sessions');
    const before = await login(email, OLD_PASSWORD);
    expect(before.status).toBe(200);
    const access = before.body.data.accessToken as string;
    expect(
      (await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${access}`)).status
    ).toBe(200);
    const tvBefore = (
      await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenVersion: true } })
    ).tokenVersion;

    expect((await reset(await issueToken(userId))).status).toBe(200);

    expect(
      (await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${access}`)).status
    ).toBe(401);
    const live = await prisma.refreshToken.count({ where: { userId, revokedAt: null } });
    expect(live).toBe(0);
    const revoked = await prisma.refreshToken.findMany({
      where: { userId, revokedReason: 'password_reset' },
    });
    expect(revoked.length).toBeGreaterThan(0);
    const tvAfter = (
      await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenVersion: true } })
    ).tokenVersion;
    expect(tvAfter).toBeGreaterThan(tvBefore);
  });

  it('a used token is refused the second time', async () => {
    const { email, userId } = await customer('used');
    const token = await issueToken(userId);
    expect((await reset(token)).status).toBe(200);
    const again = await reset(token, 'An0ther!Passw0rd');
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('TOKEN_INVALID');
    // The second attempt did not change the password.
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);
  });

  it('two concurrent redemptions of one link: exactly one wins, the loser writes nothing', async () => {
    const { email, userId } = await customer('race');
    const token = await issueToken(userId);
    const [a, b] = await Promise.all([
      reset(token, 'Rac3!WinnerA-x'),
      reset(token, 'Rac3!WinnerB-x'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const winner = a.status === 200 ? 'Rac3!WinnerA-x' : 'Rac3!WinnerB-x';
    const loser = a.status === 200 ? 'Rac3!WinnerB-x' : 'Rac3!WinnerA-x';
    expect((await login(email, winner)).status).toBe(200);
    expect((await login(email, loser)).status).toBe(401);
  });

  it('an expired token is refused', async () => {
    const { email, userId } = await customer('expired');
    const token = await issueToken(userId);
    await prisma.refreshToken.updateMany({
      where: { userId, token: { startsWith: 'reset:' } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await reset(token);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
    expect((await login(email, OLD_PASSWORD)).status).toBe(200);
  });

  it('an invalid or malformed token is refused as TOKEN_INVALID, never a 500', async () => {
    for (const bad of [
      crypto.randomBytes(32).toString('hex'),
      'abc',
      { not: 'x' },
      ['a'],
      'Z'.repeat(64),
    ]) {
      const res = await reset(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error.code, JSON.stringify(bad)).toBe('TOKEN_INVALID');
    }
  });

  it('a weak new password is refused with the signup policy, and does not burn the token', async () => {
    const { email, userId } = await customer('weak');
    const token = await issueToken(userId);
    for (const weak of [
      'Sh0rt!x', // 7 chars
      'alllowercase1!',
      'ALLUPPERCASE1!',
      'NoDigits!!xx',
      'NoSymbol123x',
      `Aa1!${'x'.repeat(125)}`, // 129 chars: over the signup max
    ]) {
      const res = await reset(token, weak);
      expect(res.status, weak).toBe(400);
      expect(res.body.error.code, weak).toBe('VALIDATION_ERROR');
    }
    // 8 chars with all four classes is the inclusive floor, and the token is intact.
    expect((await reset(token, 'Sh0rt!xy')).status).toBe(200);
    expect((await login(email, 'Sh0rt!xy')).status).toBe(200);
  });

  it('unknown and known addresses get the byte-identical answer; only a known one is acted on', async () => {
    const known = await customer('enum');
    const m = await merchant('enum-m');
    forgot.length = 0;
    const unknown = `nobody-${run}@test.local`;
    const a = await forgotPassword({ email: unknown, storeId });
    const b = await forgotPassword({ email: known.email, storeId });
    const c = await forgotPassword({ email: { not: 'zzz' }, storeId });
    const d = await forgotPassword({ email: m.email });
    const e = await forgotPassword({ email: unknown });
    expect(a.status).toBe(200);
    for (const r of [b, c, d, e]) {
      expect(r.status).toBe(a.status);
      expect(r.body).toEqual(a.body);
    }
    await awaitDeferredWork(5000);
    await new Promise(r => setTimeout(r, 100));
    expect(await resetRows(known.userId)).toHaveLength(1);
    expect(forgot).toEqual([m.email]); // never the unknown address, never the object payload, never the customer
  });

  it('a storefront customer with the same address in some store is not handed to the identity service by a merchant-scope request', async () => {
    // The admin namespace (store_id NULL) is the only scope a no-storeId request searches; an address that only exists
    // as a shopper reaches neither the identity service nor a Store token.
    const shopper = await customer('shopper');
    forgot.length = 0;
    const res = await forgotPassword({ email: shopper.email });
    expect(res.status).toBe(200);
    await awaitDeferredWork(5000);
    await new Promise(r => setTimeout(r, 200));
    expect(forgot).toEqual([]);
    expect(await resetRows(shopper.userId)).toHaveLength(0);
  });

  it('MFA survives a reset: the next login still stops at the MFA challenge', async () => {
    const { email, userId } = await customer('mfa');
    await prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaSecret: 'placeholder-encrypted-secret' },
    });
    expect((await reset(await issueToken(userId))).status).toBe(200);

    const res = await login(email, NEW_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.data.mfaRequired).toBe(true);
    expect(res.body.data.challengeToken).toBeTruthy();
    expect(res.body.data.accessToken).toBeUndefined();
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaEnabled: true, mfaSecret: true },
    });
    expect(after.mfaEnabled).toBe(true);
    expect(after.mfaSecret).toBe('placeholder-encrypted-secret');
  });

  it('a reset clears a password-guessing lockout so the new password works at once', async () => {
    const { email, userId } = await customer('lockout');
    for (let i = 0; i < 6; i++) await login(email, 'Wr0ng!Password');
    const key = `${storeId}:${email.toLowerCase()}`;
    expect((await accountLockout.isLocked(key)).locked).toBe(true);
    expect((await reset(await issueToken(userId))).status).toBe(200);
    expect((await accountLockout.isLocked(key)).locked).toBe(false);
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);
  });

  describe('rate limits (limiters built with the vitest skip turned off)', () => {
    function limitedApp() {
      const a = express();
      a.set('trust proxy', true);
      a.use(express.json());
      const p = crypto.randomUUID();
      // Same chain order as the route: authLimiter (IP+email), then the
      // email-only reset budget.
      a.post(
        '/forgot',
        createAuthLimiter({ skip: () => false, prefix: `test-auth-${p}` }),
        createResetEmailLimiter({ skip: () => false, prefix: `test-reset-${p}` }),
        (_req, res) => {
          res.json({ ok: true });
        }
      );
      return (email: string, ip: string) =>
        request(a).post('/forgot').set('X-Forwarded-For', ip).send({ email });
    }

    it('per email: the 4th reset request in an hour is 429, even from a new IP', async () => {
      const hit = limitedApp();
      const email = `rl-${run}@test.local`;
      expect((await hit(email, '203.0.113.10')).status).toBe(200);
      expect((await hit(email, '203.0.113.10')).status).toBe(200);
      expect((await hit(email, '203.0.113.11')).status).toBe(200);
      const blocked = await hit(email, '198.51.100.20');
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      // Another address has its own budget.
      expect((await hit(`rl2-${run}@test.local`, '203.0.113.10')).status).toBe(200);
    });

    it('per IP+email (authLimiter): the 16th request in 15 minutes is 429; other IPs and addresses are not', async () => {
      const a = express();
      a.set('trust proxy', true);
      a.use(express.json());
      a.post(
        '/forgot',
        createAuthLimiter({ skip: () => false, prefix: `test-auth-${crypto.randomUUID()}` }),
        (_req, res) => {
          res.json({ ok: true });
        }
      );
      const hit = (email: string, ip: string) =>
        request(a).post('/forgot').set('X-Forwarded-For', ip).send({ email });
      const email = `ipe-${run}@test.local`;
      for (let i = 0; i < 15; i++) expect((await hit(email, '203.0.113.50')).status).toBe(200);
      const blocked = await hit(email, '203.0.113.50');
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect((await hit(email, '203.0.113.51')).status).toBe(200);
      expect((await hit(`other-${run}@test.local`, '203.0.113.50')).status).toBe(200);
    });
  });
});
