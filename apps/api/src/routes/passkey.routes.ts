import { JWT_ISSUERS_ACCEPTED, JWT_AUDIENCES_ACCEPTED } from '@ebda/shared';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod/v3';
import jwt from 'jsonwebtoken';
import {
  authenticate,
  rejectAdminOnMerchantOrigin,
  rejectIdentityManaged,
  rejectImpersonated,
} from '../middleware/auth';
import {
  auditLog,
  generateCsrfToken,
  passkeyBeginLimiter,
  passkeyFinishLimiter,
  passkeyStepUpLimiter,
  writeLimiter,
} from '../middleware/security';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { AuthService } from '../services/auth.service';
import { PasskeyService, assertPasskeyOrigin } from '../services/passkey.service';
import { setSessionCookies } from './auth.routes';

/**
 * Passkeys (WebAuthn). Mounted at `/auth/passkeys`. Design + rulings: docs/plans/2026-10-21-passkeys.md.
 *
 *   POST /authenticate/begin    public   discoverable-credential options (takes NO account input)
 *   POST /authenticate/finish   public   verify the assertion, mint the session (satisfies MFA, PASSKEY-4)
 *   GET    /                    session  list my passkeys
 *   POST   /step-up             session  password (+ TOTP) -> 5-minute window for the writes below (PASSKEY-7)
 *   POST   /register/begin      session  creation options (needs the step-up window)
 *   POST   /register/finish     session  verify + store the public key
 *   PATCH  /:id, DELETE /:id    session  rename / remove
 *
 * The host a ceremony is for is the browser `Origin`, never a body field (PASSKEY-3).
 */
const router = Router();

const b64url = z.string().min(1).max(16384);
const clientExtensionResults = z.record(z.string(), z.unknown()).default({});
const attachment = z.enum(['platform', 'cross-platform']).nullish();

const authenticationResponseSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  authenticatorAttachment: attachment,
  clientExtensionResults,
  response: z.object({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: z
      .string()
      .max(1024)
      .nullish()
      .transform(v => v ?? undefined),
  }),
});

const registrationResponseSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  authenticatorAttachment: attachment,
  clientExtensionResults,
  response: z.object({
    clientDataJSON: b64url,
    attestationObject: b64url,
    transports: z.array(z.string().max(32)).max(8).optional(),
    authenticatorData: b64url.optional(),
    publicKey: b64url.optional(),
    publicKeyAlgorithm: z.number().int().optional(),
  }),
});

const nameSchema = z.string().trim().min(1).max(60);
const idParam = z.string().uuid();

const originOf = (req: Request) => req.headers.origin as string | undefined;
/** The acting user + the specific session (access-token jti set by `authenticate`). */
const actorOf = (req: Request) => ({
  userId: req.user!.userId,
  sessionId: (req as unknown as { tokenJti?: string }).tokenJti,
  storeId: req.user!.storeId,
});

/** After `authenticate`: the request must come from the surface this account lives on (review M4). */
async function passkeyOriginGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    await assertPasskeyOrigin(req.user!, originOf(req));
    next();
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Sign in (public)
// ---------------------------------------------------------------------------------------------

router.post(
  '/authenticate/begin',
  passkeyBeginLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const options = await PasskeyService.beginAuthentication(originOf(req));
      res.json({ success: true, data: options });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/authenticate/finish',
  passkeyFinishLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    let reason = 'malformed';
    let failedUserId: string | undefined;
    try {
      const parsed = z.object({ response: authenticationResponseSchema }).safeParse(req.body);
      // Same answer as every other failure: a malformed body must not be distinguishable.
      if (!parsed.success) throw new AppError(401, 'PASSKEY_AUTH_FAILED', 'Passkey sign-in failed');

      const verified = await PasskeyService.finishAuthentication(
        originOf(req),
        parsed.data.response as never,
        (r, uid) => {
          reason = r;
          failedUserId = uid;
        },
        { ip: req.ip }
      );
      const result = await AuthService.issueSessionFor(verified.user);

      // A passkey sign-in is a fresh, phishing-resistant authentication: it opens the step-up window for
      // THIS new session only (bound to its token id, PASSKEY-12). Best-effort; the password path remains.
      try {
        // We minted this token a line ago: verify (not decode) keeps it a checked read.
        const claims = jwt.verify(result.accessToken, config.jwtSecret, {
          algorithms: ['HS256'],
          issuer: JWT_ISSUERS_ACCEPTED,
          audience: JWT_AUDIENCES_ACCEPTED,
        }) as { jti?: string };
        const jti = claims.jti;
        if (jti) await PasskeyService.markStepUp(result.user.id, jti);
      } catch {
        /* no step-up window; the person confirms with the password when managing passkeys */
      }

      // Bound to the user that just authenticated, exactly as POST /auth/login does.
      const sessionId = req.headers['x-session-id'] as string;
      const csrfToken = sessionId ? await generateCsrfToken(sessionId, result.user.id) : undefined;

      await auditLog({
        action: 'passkey.login',
        userId: result.user.id,
        resourceType: 'passkey',
        resourceId: verified.credentialRowId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      setSessionCookies(res, result.accessToken, result.refreshToken);
      res.json({ success: true, data: { ...result, csrfToken } });
    } catch (error) {
      await auditLog({
        action: 'passkey.login.failed',
        userId: failedUserId,
        resourceType: 'passkey',
        details: { reason },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------------------------
// Manage (session)
// ---------------------------------------------------------------------------------------------

router.get(
  '/',
  authenticate,
  rejectIdentityManaged,
  rejectAdminOnMerchantOrigin,
  passkeyOriginGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await PasskeyService.list(req.user!.userId, originOf(req), req.user!.storeId);
      res.json({ success: true, data: { passkeys: items } });
    } catch (error) {
      next(error);
    }
  }
);

// Step-up (Ruling PASSKEY-7): password (+ TOTP code when TOTP is on) opens a 5-minute window in which
// this account may add, rename or remove passkeys. Per-user limiter and the SAME lockout counter as login.
router.post(
  '/step-up',
  authenticate,
  rejectIdentityManaged,
  rejectAdminOnMerchantOrigin,
  passkeyOriginGuard,
  rejectImpersonated,
  passkeyStepUpLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = z
        .object({
          password: z.string().min(1).max(256),
          code: z.string().trim().min(6).max(20).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success)
        throw new AppError(401, 'STEP_UP_FAILED', 'Could not confirm your identity');
      const out = await PasskeyService.stepUp(
        req.user!.userId,
        actorOf(req).sessionId,
        parsed.data,
        req.ip,
        req.user!.storeId
      );
      await auditLog({
        action: 'passkey.stepup',
        userId: req.user!.userId,
        resourceType: 'passkey',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: out });
    } catch (error) {
      await auditLog({
        action: 'passkey.stepup.failed',
        userId: req.user?.userId,
        resourceType: 'passkey',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      next(error);
    }
  }
);

router.post(
  '/register/begin',
  authenticate,
  rejectIdentityManaged,
  rejectAdminOnMerchantOrigin,
  passkeyOriginGuard,
  rejectImpersonated,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const options = await PasskeyService.beginRegistration(actorOf(req), originOf(req));
      res.json({ success: true, data: options });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/register/finish',
  authenticate,
  rejectIdentityManaged,
  rejectAdminOnMerchantOrigin,
  passkeyOriginGuard,
  rejectImpersonated,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = z
        .object({ response: registrationResponseSchema, name: nameSchema.optional() })
        .safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'PASSKEY_REGISTRATION_FAILED', 'Passkey could not be registered');
      }
      const item = await PasskeyService.finishRegistration(
        actorOf(req),
        originOf(req),
        parsed.data as never
      );
      await auditLog({
        action: 'passkey.added',
        userId: req.user!.userId,
        resourceType: 'passkey',
        resourceId: item.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(201).json({ success: true, data: { passkey: item } });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  authenticate,
  rejectIdentityManaged,
  rejectAdminOnMerchantOrigin,
  passkeyOriginGuard,
  rejectImpersonated,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = idParam.safeParse(req.params.id);
      const body = z.object({ name: nameSchema }).safeParse(req.body);
      if (!id.success || !body.success)
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request');
      await PasskeyService.rename(actorOf(req), id.data, body.data.name);
      await auditLog({
        action: 'passkey.renamed',
        userId: req.user!.userId,
        resourceType: 'passkey',
        resourceId: id.data,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { message: 'Passkey renamed' } });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  authenticate,
  rejectIdentityManaged,
  rejectAdminOnMerchantOrigin,
  passkeyOriginGuard,
  rejectImpersonated,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request');
      await PasskeyService.remove(actorOf(req), id.data);
      await auditLog({
        action: 'passkey.removed',
        userId: req.user!.userId,
        resourceType: 'passkey',
        resourceId: id.data,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { message: 'Passkey removed' } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
