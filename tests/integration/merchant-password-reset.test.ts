/**
 * Ebda Store merchant password reset, end to end against a real Postgres
 * (local container in dev, the CI service container in CI; never Neon).
 *
 * Before 2026-10-07 `POST /auth/forgot-password` for an account in the admin
 * namespace (`users.store_id` NULL: every merchant) created a token and then
 * logged "Skipping branded password-reset email — admin account". No mail, no
 * page: a merchant who forgot their password was locked out for good.
 *
 * Flow covered: signup -> verify -> forgot-password (mail CAPTURED by the
 * platform mailer, never sent outside production) -> reset-password -> login.
 *
 * Mutation proofs (run by hand 2026-10-07, recorded in the PR body):
 *   1. auth.service.ts resetPassword: replace the atomic `deleteMany` claim with
 *      `{ count: 1 }` -> "two concurrent redemptions" fails (both requests 200).
 *      (Sequential reuse stays blocked even then: revokeAllSessions deletes every
 *      `reset:` row, so the race is the case only the claim covers.)
 *   2. auth.routes.ts /forgot-password: answer the found branch with a
 *      different message -> "unknown and known addresses get the byte-identical
 *      answer" and the happy path both fail.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { prisma } from '@ebda/database';
import merchantSignupRoutes from '@api/routes/merchant-signup.routes';
import authRoutes from '@api/routes/auth.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { createAuthLimiter, createResetEmailLimiter } from '@api/middleware/security';
import { accountLockout } from '@api/services/account-lockout.service';
import { RESET_TOKEN_TTL_MINUTES } from '@api/services/auth.service';
import { config } from '@api/config';
import {
  clearCapturedMail,
  latestCapturedMailTo,
  tokenFromCapturedMail,
} from '@api/services/platform-mailer';
import { hasDb } from '../helpers/bundle-fixtures';

const run = crypto.randomUUID().slice(0, 8);
const OLD_PASSWORD = 'Str0ng!Passw0rd';
const NEW_PASSWORD = 'N3w!Passw0rd-x';
const emails: string[] = [];

function mkEmail(tag: string) {
  const e = `pwr-${tag}-${run}@test.local`;
  emails.push(e);
  return e;
}

function buildApp(): Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  // Mounted exactly as apps/api/src/routes/index.ts mounts them.
  app.use('/api/v1/auth/merchant', merchantSignupRoutes);
  app.use('/api/v1/auth', authRoutes);
  app.use(errorHandler);
  return app;
}

describe.skipIf(!hasDb)('merchant password reset (Ebda Store)', () => {
  let app: Express;
  process.env.SIGNUP_MIN_FILL_MS = '0';
  process.env.SIGNUP_EMAIL_DOMAIN_DAILY_CAP = '100000';
  const api = () => request(app);

  async function merchant(tag: string, language: 'ar' | 'en' = 'ar') {
    const email = mkEmail(tag);
    const tok = await api().get('/api/v1/auth/merchant/signup-token');
    const res = await api()
      .post('/api/v1/auth/merchant/signup')
      .send({
        email,
        password: OLD_PASSWORD,
        name: 'Mona Hassan',
        phone: `010${crypto.randomInt(10_000_000, 99_999_999)}`,
        language,
        formToken: tok.body.data.token,
        acceptedLegal: true,
      });
    expect(res.status).toBe(200);
    const vtoken = tokenFromCapturedMail(latestCapturedMailTo(email));
    expect((await api().post('/api/v1/auth/verify-email').send({ token: vtoken })).status).toBe(
      200
    );
    const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
    return { email, userId: user.id };
  }

  const login = (email: string, password: string) =>
    api().post('/api/v1/auth/login').send({ email, password });

  /** The reset mail is handed to waitUntil (timing parity), so poll the outbox. */
  async function requestReset(email: string) {
    clearCapturedMail();
    const res = await api().post('/api/v1/auth/forgot-password').send({ email });
    expect(res.status).toBe(200);
    const mail = await vi.waitFor(
      () => {
        const m = latestCapturedMailTo(email);
        if (!m) throw new Error('reset mail not captured yet');
        return m;
      },
      { timeout: 5000, interval: 25 }
    );
    const token = tokenFromCapturedMail(mail);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    return { res, mail, token: token! };
  }

  const reset = (token: unknown, password: string = NEW_PASSWORD) =>
    api().post('/api/v1/auth/reset-password').send({ token, password });

  beforeAll(() => {
    app = buildApp();
    clearCapturedMail();
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    const ids = users.map(u => u.id);
    await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.verificationToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it('happy path: mails a store.ebda.app-style link, stores only a hash, sets the password, old one dies', async () => {
    const { email, userId } = await merchant('happy', 'ar');
    const { res, mail, token } = await requestReset(email);
    expect(res.body).toEqual({
      success: true,
      data: { message: 'If an account exists with this email, a reset link has been sent.' },
    });

    // Bilingual by the user's language (signed up in Arabic), platform reply-to.
    expect(mail.subject).toBe('إعادة تعيين كلمة المرور');
    expect(mail.replyTo).toBe('ahlan@ebda.app');
    // The merchant app's own page (config.adminUrl outside production; BRAND
    // store.ebda.app in production, see storeAppOrigin).
    expect(mail.link).toBe(`${config.adminUrl}/reset-password?token=${token}`);
    expect(mail.html).toContain(`${RESET_TOKEN_TTL_MINUTES} دقيقة`);

    // Only the SHA-256 is stored, with a short expiry.
    const rows = await prisma.refreshToken.findMany({
      where: { userId, token: { startsWith: 'reset:' } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(`reset:${crypto.createHash('sha256').update(token).digest('hex')}`);
    expect(rows[0].token).not.toContain(token);
    const minutes = (rows[0].expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(RESET_TOKEN_TTL_MINUTES - 1);
    expect(minutes).toBeLessThanOrEqual(RESET_TOKEN_TTL_MINUTES);

    const done = await reset(token);
    expect(done.status).toBe(200);
    expect(done.body.success).toBe(true);

    expect((await login(email, OLD_PASSWORD)).status).toBe(401);
    const fresh = await login(email, NEW_PASSWORD);
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.accessToken).toBeTruthy();

    // Audit trail: one row for the request, one for the completion.
    const audit = await prisma.auditLog.findMany({
      where: { userId, action: { startsWith: 'auth.password_reset.' } },
      select: { action: true, details: true },
    });
    expect(audit.map(a => a.action).sort()).toEqual([
      'auth.password_reset.completed',
      'auth.password_reset.requested',
    ]);
    // The address in the audit row is masked, never the token.
    expect(JSON.stringify(audit)).not.toContain(email);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('an English-language merchant gets the English mail', async () => {
    const { email } = await merchant('en', 'en');
    const { mail } = await requestReset(email);
    expect(mail.subject).toBe('Reset Your Password');
    expect(mail.html).toContain(`${RESET_TOKEN_TTL_MINUTES} minutes`);
  });

  it('revokes every session: old access token 401s, old refresh token is dead, tokenVersion moved', async () => {
    const { email, userId } = await merchant('sessions');
    const before = await login(email, OLD_PASSWORD);
    expect(before.status).toBe(200);
    const access = before.body.data.accessToken as string;
    expect(
      (await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${access}`)).status
    ).toBe(200);
    const tvBefore = (
      await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenVersion: true } })
    ).tokenVersion;

    const { token } = await requestReset(email);
    expect((await reset(token)).status).toBe(200);

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
    const { email } = await merchant('used');
    const { token } = await requestReset(email);
    expect((await reset(token)).status).toBe(200);
    const again = await reset(token, 'An0ther!Passw0rd');
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('TOKEN_INVALID');
    // The second attempt did not change the password.
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);
  });

  it('two concurrent redemptions of one link: exactly one wins, the loser writes nothing', async () => {
    const { email } = await merchant('race');
    const { token } = await requestReset(email);
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
    const { email, userId } = await merchant('expired');
    const { token } = await requestReset(email);
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
    const { email } = await merchant('weak');
    const { token } = await requestReset(email);
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

  it('unknown and known addresses get the byte-identical answer; only the known one gets mail', async () => {
    const { email } = await merchant('enum');
    clearCapturedMail();
    const unknown = `nobody-${run}@test.local`;
    const a = await api().post('/api/v1/auth/forgot-password').send({ email: unknown });
    const b = await api().post('/api/v1/auth/forgot-password').send({ email });
    const c = await api()
      .post('/api/v1/auth/forgot-password')
      .send({ email: { not: 'zzz' } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(a.status);
    expect(c.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    expect(c.body).toEqual(a.body);
    await vi.waitFor(() => expect(latestCapturedMailTo(email)).toBeTruthy(), { timeout: 5000 });
    expect(latestCapturedMailTo(unknown)).toBeUndefined();
  });

  it('a storefront customer with the same address in some store does not receive a merchant link', async () => {
    // The admin namespace (store_id NULL) is the only scope a no-storeId request
    // searches; an address that only exists as a shopper gets no mail here.
    const shopper = `shopper-${run}@test.local`;
    clearCapturedMail();
    const res = await api().post('/api/v1/auth/forgot-password').send({ email: shopper });
    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 200));
    expect(latestCapturedMailTo(shopper)).toBeUndefined();
  });

  it('MFA survives a reset: the next login still stops at the MFA challenge', async () => {
    const { email, userId } = await merchant('mfa');
    await prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaSecret: 'placeholder-encrypted-secret' },
    });
    const { token } = await requestReset(email);
    expect((await reset(token)).status).toBe(200);

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
    const { email } = await merchant('lockout');
    for (let i = 0; i < 6; i++) await login(email, 'Wr0ng!Password');
    expect((await accountLockout.isLocked(email.toLowerCase())).locked).toBe(true);
    const { token } = await requestReset(email);
    expect((await reset(token)).status).toBe(200);
    expect((await accountLockout.isLocked(email.toLowerCase())).locked).toBe(false);
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
