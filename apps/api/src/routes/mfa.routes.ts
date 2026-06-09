import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { authenticate } from '../middleware/auth';
import { authLimiter } from '../middleware/security';
import { prisma } from '@force/database';
import { encryption } from '../services/encryption.service';
import { MfaService } from '../services/mfa.service';
import { AuthService } from '../services/auth.service';
import { setSessionCookies } from './auth.routes';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { redis } from '../services/redis.service';

const router = Router();

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
router.post('/enroll/begin', authenticate, async (req, res, next) => {
  try {
    const { code } = req.body as { code?: string };
    const existing = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { mfaEnabled: true, mfaSecret: true },
    });

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
    await prisma.user.update({
      where: { id: req.user!.userId },
      data: { mfaSecret: encryption.encrypt(secret) },
    });
    res.json({
      success: true,
      data: { secret, qr: await MfaService.qrDataUrl(otpauthUrl) },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /auth/mfa/enroll/verify
 *
 * Complete enrollment: verifies a TOTP code against the pending secret, enables
 * MFA, and returns one-time backup codes that the user must save.
 */
router.post('/enroll/verify', authenticate, authLimiter, async (req, res, next) => {
  try {
    const { code } = req.body;
    const u = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { mfaSecret: true },
    });
    if (!u?.mfaSecret) {
      throw new AppError(400, 'MFA_NOT_STARTED', 'Begin enrollment first');
    }
    if (!MfaService.verifyCode(encryption.decrypt(u.mfaSecret), code)) {
      throw new AppError(400, 'MFA_BAD_CODE', 'Invalid code');
    }
    const { plain, hashed } = await MfaService.generateBackupCodes();
    await prisma.user.update({
      where: { id: req.user!.userId },
      data: {
        mfaEnabled: true,
        mfaEnrolledAt: new Date(),
        mfaBackupCodes: hashed,
      },
    });
    res.json({ success: true, data: { backupCodes: plain } });
  } catch (error) {
    next(error);
  }
});

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

router.post('/verify', authLimiter, async (req, res, next) => {
  try {
    const { challengeToken, code } = req.body;
    let payload: any;
    try {
      // Challenge tokens are signed with audience:'force-mfa-challenge' —
      // distinct from real access tokens ('force-app') so jwt.verify here
      // rejects any access token masquerading as a challenge, and the
      // authenticate middleware rejects any challenge token masquerading as
      // an access token.
      payload = jwt.verify(challengeToken, config.jwtSecret, {
        issuer: 'force-api',
        audience: 'force-mfa-challenge',
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

    const u = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!u?.mfaSecret) {
      throw new AppError(400, 'MFA_NOT_ENABLED', 'MFA not enabled for this account');
    }

    let ok = MfaService.verifyCode(encryption.decrypt(u.mfaSecret), code);
    if (!ok) {
      // Try backup code
      const r = await MfaService.consumeBackupCode(u.mfaBackupCodes, code);
      if (r.matched) {
        ok = true;
        await prisma.user.update({
          where: { id: u.id },
          data: { mfaBackupCodes: r.remaining },
        });
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
router.post('/disable', authenticate, authLimiter, async (req, res, next) => {
  try {
    const { code } = req.body;
    const u = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { mfaSecret: true },
    });
    if (!u?.mfaSecret || !MfaService.verifyCode(encryption.decrypt(u.mfaSecret), code)) {
      throw new AppError(400, 'MFA_BAD_CODE', 'Invalid code — MFA disable rejected');
    }
    await prisma.user.update({
      where: { id: req.user!.userId },
      data: {
        mfaEnabled: false,
        mfaSecret: null,
        mfaBackupCodes: [],
        mfaEnrolledAt: null,
      },
    });
    await AuthService.revokeAllSessions(req.user!.userId);
    res.json({ success: true, data: { message: 'MFA disabled' } });
  } catch (error) {
    next(error);
  }
});

export default router;
