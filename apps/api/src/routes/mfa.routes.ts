import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod/v3';
import jwt from 'jsonwebtoken';
import {
  authenticate,
  rejectAdminOnMerchantOrigin,
  rejectIdentityManaged,
  rejectImpersonated,
} from '../middleware/auth';
import { authLimiter, authIpFailureLimiter } from '../middleware/security';
import { withUser } from '@ebda/database';
import { encryption } from '../services/encryption.service';
import { MfaService } from '../services/mfa.service';
import { AuthService } from '../services/auth.service';
import { setSessionCookies } from './auth.routes';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { redis } from '../services/redis.service';

import { JWT_ISSUERS_ACCEPTED, JWT_MFA_AUDIENCES_ACCEPTED } from '@ebda/shared';
const router = Router();
const authLimiters = [authIpFailureLimiter, authLimiter];

// TOTP codes are always 6 digits (see MfaService.verifyCode).
const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
// /verify accepts a 6-digit TOTP OR a backup code (10 lowercase-hex chars,
// see MfaService.generateBackupCodes) — loosen to a length range so the
// backup-code flow is never rejected at the edge.
const verifyBodySchema = z.object({
  challengeToken: z.string().min(1).max(4096),
  code: z.string().trim().min(6).max(20),
});

/**
 * POST /auth/mfa/enroll/begin
 *
 * Start TOTP enrollment: generates a new secret, stores it (encrypted, not yet
 * enabled) on the user, and returns the plaintext secret + a QR data-URL.
 * The user must confirm a valid code via /enroll/verify to activate MFA.
 *
 * Security: if MFA is already enabled, the caller MUST supply a valid current
 * TOTP code in req.body.code before a new secret is generated. This prevents a
 * hijacked session from silently re-enrolling a new authenticator device.
 */
// `rejectImpersonated`: binding a second factor to someone else's account is
// the WORST of the destructive actions, not a lesser one. For a victim with no
// MFA, the re-auth branch below never runs, so an impersonation session could
// write a fresh `mfaSecret` onto their user row, verify it with a code read off
// the impersonator's own authenticator, and lock the legitimate owner out
// permanently — they never possessed the secret. Unlike the soft-delete on
// DELETE /auth/me, no admin can undo it.
//
// This router is mounted separately at `/auth/mfa` (routes/index.ts), which is
// exactly why it was missed: the first rollout of this guard walked only
// auth.routes.ts. The mount registry in tests/unit/reject-impersonated.test.ts
// is now router-qualified so it can see routes outside that file.
router.post(
  '/enroll/begin',
  authenticate,
  rejectIdentityManaged,
  rejectAdminOnMerchantOrigin,
  rejectImpersonated,
  async (req, res, next) => {
    try {
      // `code` is optional here (only required to re-enroll when MFA is already
      // enabled). Validate its shape only when supplied so first-time enrollment
      // (no code) still works.
      const parsed = z.object({ code: codeSchema.shape.code.optional() }).safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid 2FA code');
      }
      const { code } = parsed.data;
      const existing = await withUser(req.user!.userId, tx =>
        tx.user.findUnique({
          where: { id: req.user!.userId },
          select: { mfaEnabled: true, mfaSecret: true },
        })
      );

      if (existing?.mfaEnabled) {
        // Re-enrollment requires proof of the current second factor.
        if (!code || !existing.mfaSecret) {
          throw new AppError(400, 'MFA_REAUTH_REQUIRED', 'Provide current 2FA code to re-enroll');
        }
        const currentSecretPlain = encryption.decrypt(existing.mfaSecret);
        if (!MfaService.verifyCode(currentSecretPlain, code)) {
          throw new AppError(400, 'MFA_REAUTH_REQUIRED', 'Provide current 2FA code to re-enroll');
        }
      }

      const { secret, otpauthUrl } = MfaService.generateEnrollment(req.user!.email);
      await withUser(req.user!.userId, tx =>
        tx.user.update({
          where: { id: req.user!.userId },
          data: { mfaSecret: encryption.encrypt(secret) },
        })
      );
      res.json({
        success: true,
        data: { secret, qr: await MfaService.qrDataUrl(otpauthUrl) },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /auth/mfa/enroll/verify
 *
 * Complete enrollment: verifies a TOTP code against the pending secret, enables
 * MFA, and returns one-time backup codes that the user must save.
 */
router.post(
  '/enroll/verify',
  authenticate,
  rejectIdentityManaged,
  rejectAdminOnMerchantOrigin,
  rejectImpersonated,
  authLimiter,
  async (req, res, next) => {
    try {
      const parsed = codeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid 2FA code');
      }
      const { code } = parsed.data;
      const u = await withUser(req.user!.userId, tx =>
        tx.user.findUnique({
          where: { id: req.user!.userId },
          select: { mfaSecret: true },
        })
      );
      if (!u?.mfaSecret) {
        throw new AppError(400, 'MFA_NOT_STARTED', 'Begin enrollment first');
      }
      if (!MfaService.verifyCode(encryption.decrypt(u.mfaSecret), code)) {
        throw new AppError(400, 'MFA_BAD_CODE', 'Invalid code');
      }
      const { plain, hashed } = await MfaService.generateBackupCodes();
      await withUser(req.user!.userId, tx =>
        tx.user.update({
          where: { id: req.user!.userId },
          data: {
            mfaEnabled: true,
            mfaEnrolledAt: new Date(),
            mfaBackupCodes: hashed,
          },
        })
      );
      res.json({ success: true, data: { backupCodes: plain } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /auth/mfa/verify
 *
 * Exchange a short-lived MFA challenge token (from the login response when
 * mfaEnabled=true) plus a valid TOTP code or backup code for a full session.
 * Returns the same shape as a normal login (accessToken, refreshToken, user).
 */
// Maximum failed code attempts per MFA challenge before lockout.
const MFA_VERIFY_MAX_ATTEMPTS = 5;
// Challenge lifetime (seconds) — matches the '5m' expiresIn above.
// The attempt counter TTL is set to the same value so the key expires
// when the challenge itself does (prevents stale counter accumulation).
const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

router.post('/verify', authLimiters, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = verifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid 2FA request');
    }
    const { challengeToken, code } = parsed.data;
    let payload: any;
    try {
      // Challenge tokens are signed with audience:'ebda-mfa-challenge' —
      // distinct from real access tokens ('ebda-app') so jwt.verify here
      // rejects any access token masquerading as a challenge, and the
      // authenticate middleware rejects any challenge token masquerading as
      // an access token.
      payload = jwt.verify(challengeToken, config.jwtSecret, {
        // Pinned like every other verify in this codebase. A symmetric secret
        // already stops `alg: none` in jsonwebtoken, so this closes a
        // consistency gap rather than a live hole — but "the one call that
        // didn't pin it" is how algorithm-confusion bugs are always written.
        algorithms: ['HS256'],
        issuer: JWT_ISSUERS_ACCEPTED,
        audience: JWT_MFA_AUDIENCES_ACCEPTED,
      });
    } catch {
      throw new AppError(401, 'MFA_CHALLENGE_INVALID', 'Challenge expired or invalid');
    }
    // Belt-and-suspenders: even after audience check, assert the purpose claim.
    if (payload.purpose !== 'mfa') {
      throw new AppError(401, 'MFA_CHALLENGE_INVALID', 'Bad challenge token');
    }

    // H2: per-challenge brute-force guard keyed by jti.
    // Each login attempt issues a unique challenge token (jti = randomUUID),
    // so this counter is isolated per login attempt, not per IP or account.
    const challengeJti: string | undefined = payload.jti;
    if (challengeJti) {
      // Check existing count BEFORE incrementing so we can reject already-locked challenges.
      const existingAttempts = await redis.getMfaAttempts(challengeJti);
      if (existingAttempts >= MFA_VERIFY_MAX_ATTEMPTS) {
        throw new AppError(
          429,
          'MFA_TOO_MANY_ATTEMPTS',
          'Too many failed attempts — request a new login challenge'
        );
      }
    }

    // MFA verify needs both the TOTP secret and the backup-code list, which are
    // globally omitted — ask for them by name. Without this, `u.mfaSecret` is
    // undefined and every verify fails with MFA_NOT_ENABLED.
    const u = await withUser(payload.userId, tx =>
      tx.user.findUnique({
        where: { id: payload.userId },
        omit: { mfaSecret: false, mfaBackupCodes: false },
      })
    );
    if (!u?.mfaSecret) {
      throw new AppError(400, 'MFA_NOT_ENABLED', 'MFA not enabled for this account');
    }

    let ok = MfaService.verifyCode(encryption.decrypt(u.mfaSecret), code);
    if (!ok) {
      // Try backup code
      const r = await MfaService.consumeBackupCode(u.mfaBackupCodes, code);
      if (r.matched) {
        ok = true;
        await withUser(u.id, tx =>
          tx.user.update({
            where: { id: u.id },
            data: { mfaBackupCodes: r.remaining },
          })
        );
      }
    }
    if (!ok) {
      // Increment per-challenge attempt counter. On reaching the limit,
      // also lock the challenge so subsequent reads (before JWT expiry)
      // are rejected immediately without another DB lookup.
      if (challengeJti) {
        const newCount = await redis.incrementMfaAttempt(challengeJti, MFA_CHALLENGE_TTL_SECONDS);
        if (newCount >= MFA_VERIFY_MAX_ATTEMPTS) {
          // Overwrite with sentinel to survive any race-condition window.
          await redis.lockMfaChallenge(challengeJti, MFA_CHALLENGE_TTL_SECONDS);
          throw new AppError(
            429,
            'MFA_TOO_MANY_ATTEMPTS',
            'Too many failed attempts — request a new login challenge'
          );
        }
      }
      throw new AppError(401, 'MFA_BAD_CODE', 'Invalid TOTP code');
    }

    const result = await AuthService.issueSessionFor(u);
    // Set BOTH the access and rotating-refresh cookies, identical to a
    // normal /auth/login response — so the post-MFA cookie path behaves
    // the same as direct login (a pure-browser client gets a refresh
    // cookie it can rotate against). Bearer clients use the body tokens.
    setSessionCookies(res, result.accessToken, result.refreshToken);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /auth/mfa/disable
 *
 * Disable MFA for the authenticated user after verifying a current TOTP code.
 * Also revokes all active sessions (bumps tokenVersion) so old tokens are
 * immediately invalidated.
 */
// Not exploitable by an impersonator today — it verifies a current TOTP code,
// which they do not have. Guarded anyway: the whole point of a registry is that
// every account-level MFA change is in it, so a future refactor that relaxes the
// code check does not silently reopen the class.
router.post(
  '/disable',
  authenticate,
  rejectIdentityManaged,
  rejectAdminOnMerchantOrigin,
  rejectImpersonated,
  authLimiter,
  async (req, res, next) => {
    try {
      const parsed = codeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid 2FA code');
      }
      const { code } = parsed.data;
      const u = await withUser(req.user!.userId, tx =>
        tx.user.findUnique({
          where: { id: req.user!.userId },
          select: { mfaSecret: true },
        })
      );
      if (!u?.mfaSecret || !MfaService.verifyCode(encryption.decrypt(u.mfaSecret), code)) {
        throw new AppError(400, 'MFA_BAD_CODE', 'Invalid code — MFA disable rejected');
      }
      await withUser(req.user!.userId, tx =>
        tx.user.update({
          where: { id: req.user!.userId },
          data: {
            mfaEnabled: false,
            mfaSecret: null,
            mfaBackupCodes: [],
            mfaEnrolledAt: null,
          },
        })
      );
      await AuthService.revokeAllSessions(req.user!.userId);
      res.json({ success: true, data: { message: 'MFA disabled' } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
