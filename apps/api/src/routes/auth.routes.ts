import { revokeForAccount } from '../lib/wa/consent';
import { Router, Request, Response, NextFunction, CookieOptions } from 'express';
import { z } from 'zod/v3';
import jwt from 'jsonwebtoken';
import { withUser } from '@ebda/database';
import { config } from '../config';
import {
  authenticate,
  authenticateAccounts,
  rejectIdentityManaged,
  rejectAdminOnMerchantOrigin,
  rejectImpersonated,
} from '../middleware/auth';
import { isAccountsToken, verifyAccountsToken } from '../lib/accounts-token';
import {
  isIdentityManagedUser,
  revokeIdentitySession,
  setAccountStatus,
} from '../lib/identity-client';
import { reconcileShadowUser } from '../services/identity-shadow';
import {
  AuthService,
  GENERIC_RESEND_VERIFICATION_RESULT,
  eraseNeedsCrmReview,
} from '../services/auth.service';
import {
  authLimiter,
  refreshLimiter,
  refreshIpLimiter,
  resetEmailLimiter,
  verifyEmailLimiter,
  authEmailAddressLimiter,
  authIpFailureLimiter,
  authIpAllLimiter,
  auditLog,
  generateCsrfToken,
  verifyRefreshJwt,
} from '../middleware/security';
import { isPlatformOrigin } from '../lib/cors-cache';
import { redis } from '../services/redis.service';
import { resolvePublicStoreId } from '../utils/store-helpers';
import { customerAuthRoute } from '../lib/customer-auth';
import { AppError } from '../middleware/error-handler';
import { maskEmail } from '../lib/pii-mask';
import { passwordSchema } from '../services/merchant-signup.service';
import { assertNotDemoStore } from '../services/plan-limit.service';

import { JWT_AUDIENCES_ACCEPTED, JWT_ISSUERS_ACCEPTED } from '@ebda/shared';
const router = Router();

// LAUNCH-RL: IP-wide bucket in front of the per-IP+email authLimiter (email rotation cannot bypass it).
const authLimiters = [authIpFailureLimiter, authLimiter];
const regAuthLimiters = [authIpAllLimiter, authLimiter];

/** Shared cookie options for the HTTP-only access-token cookie.
 *
 *  The access-token JWT itself is short-lived (30 min, config.jwtExpiresIn) but
 *  the cookie's maxAge is deliberately the full refresh window (1 year). A
 *  cookie outliving its JWT is harmless — the auth middleware rejects on the
 *  JWT `exp` and the client transparently refreshes — and keeping the cookie
 *  present avoids a "no cookie at all" state that would force an interactive
 *  login on a returning PWA user. The refresh cookie (below) is the real
 *  session-length governor. */
const AUTH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: config.nodeEnv === 'production',
  sameSite: config.nodeEnv === 'production' ? 'none' : 'lax', // 'none' required for cross-origin cookies
  maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year — matches the refresh window, NOT the 30-min JWT exp
  path: '/',
};

/** Shared cookie options for the HTTP-only refresh-token cookie. Same
 *  cross-origin posture as the access cookie (SameSite=None;Secure in prod)
 *  so a pure-browser client (no localStorage mirror) can present it to
 *  /auth/refresh automatically. Distinct cookie NAME ('refresh_token') from
 *  the access cookie ('token') so the two never collide. Path is '/' to match
 *  the access cookie — scoping tighter (e.g. /api/v1/auth/refresh) risks the
 *  browser not sending it through Next rewrites/proxies, the classic
 *  "cookie silently not sent" refresh bug. */
const REFRESH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: config.nodeEnv === 'production',
  sameSite: config.nodeEnv === 'production' ? 'none' : 'lax',
  maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year — matches config.refreshTokenExpiresIn + the DB row expiry
  path: '/',
};

/** Set the access token as an HTTP-only cookie on the response */
function setTokenCookie(res: Response, accessToken: string): void {
  res.cookie('token', accessToken, AUTH_COOKIE_OPTIONS);
}

/** Set the refresh token as its own HTTP-only cookie on the response.
 *  MUST be called on every response that issues/rotates a refresh token
 *  (login, register-via-login, mfa/verify, refresh) — on rotation the
 *  browser's stored refresh cookie has to be replaced or the next refresh
 *  presents the now-rotated token and self-revokes the whole family. */
function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);
}

/** Set both auth cookies in one call. Used by login + mfa/verify. */
export function setSessionCookies(res: Response, accessToken: string, refreshToken: string): void {
  setTokenCookie(res, accessToken);
  setRefreshCookie(res, refreshToken);
}

/** The delete-time attribute set for a session cookie: identical to the
 *  set-time options minus maxAge. A browser only removes a cookie when the
 *  deleting Set-Cookie carries the SAME same-site/secure/path attributes it
 *  was stored with — per RFC6265bis §5.5 a Set-Cookie that is not
 *  `SameSite=None; Secure` is ignored outright on a cross-site request, and
 *  the storefront hits /auth/refresh cross-site (demo-store.example →
 *  api.ebda.app). Clearing with a bare `{ path: '/' }` therefore dropped
 *  silently for exactly the shoppers that needed it. maxAge must be stripped:
 *  clearCookie supplies the epoch `expires` itself and a surviving maxAge
 *  would override it back into the future. */
function clearOptionsFor(options: CookieOptions): CookieOptions {
  return {
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite,
    path: options.path,
  };
}

/** Clear both auth cookies on the response (logout / logout-all / erase). */
function clearSessionCookies(res: Response): void {
  res.clearCookie('token', clearOptionsFor(AUTH_COOKIE_OPTIONS));
  res.clearCookie('refresh_token', clearOptionsFor(REFRESH_COOKIE_OPTIONS));
}

// Validation schemas
const registerSchema = z
  .object({
    email: z.string().email('Invalid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number')
      .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
    name: z.string().min(1).optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().optional(),
    // Storefront sends the current tenant's storeId so registrations
    // are isolated per store. Admin app omits it.
    storeId: z.string().uuid().optional(),
  })
  .refine(data => data.name || data.firstName, {
    message: 'Name or firstName is required',
    path: ['name'],
  });

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
  // Same as registerSchema — storefront passes storeId so login finds
  // the right tenant's account.
  storeId: z.string().uuid().optional(),
});

/**
 * P1-1 — the email-only body shape for the two UNAUTHENTICATED lookup routes
 * (`POST /forgot-password`, `POST /resend-verification`). Matches
 * `loginSchema`/`registerSchema`'s `z.string().email()` so a Prisma
 * StringFilter object (`{ startsWith: 'a' }`) can never reach
 * `authScope(email, ...)` and become an enumeration oracle.
 *
 * `storeId` is deliberately NOT in this schema: both routes already coerce it
 * with `typeof storeId === 'string' ? storeId : null`, and folding it in would
 * turn a non-string storeId from "ignored" into "whole request rejected",
 * which changes behaviour for a legitimate caller.
 */
const emailLookupSchema = z.object({
  email: z.string().trim().email(),
});

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     description: Create a new user account with email verification
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 example: securePassword123
 *               firstName:
 *                 type: string
 *                 example: John
 *               lastName:
 *                 type: string
 *                 example: Doe
 *     responses:
 *       200:
 *         description: >-
 *           Verification email sent. Identical for new and existing emails
 *           (T1-4 enumeration close) — no user, tokens, cookies or csrfToken
 *           are issued; the session starts at /auth/login after verification.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     emailVerificationSent:
 *                       type: boolean
 *                       example: true
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
router.post(
  '/register',
  regAuthLimiters,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = registerSchema.parse(req.body);
      // Ruling B1-13: no customer accounts on the demo showroom.
      if (data.storeId) await assertNotDemoStore(data.storeId);
      const result = await AuthService.register({
        ...data,
        storeId: data.storeId ?? null,
      });

      // T1-4 enumeration close: register no longer leaks "this email
      // already exists" via response status, body shape, or tokens.
      // AuthService.register handles both branches and returns the same
      // `{ emailVerificationSent: true }` for new and existing emails;
      // existing users get a notification email, new users get the
      // standard verification email. The audit log key is the
      // submitted email rather than a user.id (we deliberately don't
      // expose whether a row was created).
      await auditLog({
        action: 'user.register',
        resourceType: 'user',
        details: { email: data.email },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login user
 *     description: Authenticate user and return JWT tokens
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     accessToken:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', authLimiters, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = loginSchema.parse(req.body);
    // The storefront names its store by header / host as well as in the body; a login with neither is the admin namespace, which
    // signs in at the identity service (no Postgres lookup to find out).
    const loginStore = data.storeId ?? (await resolvePublicStoreId(req)) ?? null;
    const result = await AuthService.login(data.email, data.password, req.ip, loginStore);

    // MFA challenge: return the challenge token without issuing a real session.
    // The client must POST /auth/mfa/verify with the challengeToken + TOTP code.
    if ((result as any).mfaRequired) {
      res.json({ success: true, data: result });
      return;
    }

    // Generate CSRF token for session, BOUND to the user that just
    // authenticated. The binding is what stops an attacker minting a pair
    // inside its own throwaway session and replaying it from a merchant
    // origin against a lured admin's cookie — this route is exempt from
    // csrfProtection and mints for whatever X-Session-ID the caller sends,
    // so the principal is the only thing tying the token to a real session.
    const sessionId = req.headers['x-session-id'] as string;
    let csrfToken: string | undefined;
    if (sessionId) {
      csrfToken = await generateCsrfToken(sessionId, result.user.id);
    }

    // Audit log
    await auditLog({
      action: 'user.login',
      userId: result.user.id,
      resourceType: 'user',
      resourceId: result.user.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Set BOTH the access cookie and the rotating refresh cookie for
    // cookie-based auth. The refresh cookie lets a pure-browser client
    // (no localStorage mirror) hit /auth/refresh once the short-lived
    // access token expires, without ever surfacing a re-login.
    setSessionCookies(res, result.accessToken, result.refreshToken);

    // ALSO return the access token in the body so Bearer-token clients
    // (the iOS admin PWA — Safari/WebKit purges third-party cookies) can
    // store it in localStorage and send it via the Authorization header
    // on every request. The cookie path is preserved for browsers that
    // can rely on it; the API's auth middleware accepts either.
    res.json({
      success: true,
      data: {
        ...result,
        csrfToken,
      },
    });
  } catch (error) {
    // Log failed login attempt
    await auditLog({
      action: 'user.login.failed',
      resourceType: 'user',
      details: { email: req.body?.email },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    next(error);
  }
});

/**
 * Roles that may still mint a CSRF token at /auth/refresh when the ONLY thing
 * authenticating the call is the ambient refresh cookie and the Origin is not
 * a platform origin. Allowlist (not denylist) so a future role fails closed.
 *
 * Storefront customers genuinely need this: they run on merchant custom
 * origins, their non-`/public/` writes (wishlist, addresses, returns) require
 * a CSRF token now that merchant origins are no longer exempt, and the token
 * TTL (1h) is far shorter than the session — so the silent refresh is the only
 * place a long-lived storefront session can re-mint one.
 */
const AMBIENT_CSRF_MINT_ROLES = new Set(['customer']);

/**
 * May this /auth/refresh call be handed a freshly minted CSRF token?
 *
 * The CSRF token is keyed on the caller-supplied `X-Session-ID` and the
 * response body is readable by every CORS-allowlisted origin — which includes
 * every merchant custom domain, because CORS runs `credentials: true` and the
 * session cookies are `SameSite=None`. Minting unconditionally therefore
 * re-opened the hole that removing the merchant-origin CSRF exemption closed:
 * a merchant-controlled page lures a signed-in admin, POSTs here with the
 * victim's ambient cookie riding along and `X-Session-ID: <attacker-chosen>`,
 * reads back a valid token for a session id IT picked, and can then issue
 * state-changing requests as the victim (another tenant's `/stores/:id` writes
 * for a lured super_admin) that sail through `verifyCsrfToken`.
 *
 * Binding the token to the authenticated userId (which every mint now does —
 * middleware/security.ts) does not on its OWN fix this particular path: both
 * the mint and the subsequent write ride the SAME victim cookie, so the
 * binding matches. The two defenses are complementary and neither is
 * redundant — the binding kills the variant where the attacker mints inside
 * its own throwaway session at /auth/login and replays the pair against the
 * victim; this gate kills the variant where the attacker mints with the
 * victim's own ambient cookie. Removing either reopens one of them.
 *
 * What distinguishes attacker from client here is how the call was
 * authenticated and who the session belongs to:
 *
 *   1. platform origin — an origin we control end-to-end; not attacker-hostable.
 *   2. the caller PRESENTED the refresh token in the body — possession proof.
 *      Attacker JS only has the ambient httpOnly cookie, never the token value.
 *   3. ambient cookie from a merchant origin, but the session is a plain
 *      storefront customer — no privileged surface to escalate onto.
 *
 * Residual, accepted: case 3 still lets merchant origin B ride a lured
 * CUSTOMER's cookie against that customer's own account data. That is
 * structurally unavoidable while every merchant domain is CORS-allowlisted
 * with credentials — the durable fix is binding an origin to its own tenant —
 * and it is bounded to the customer's own records. What must never happen is
 * an ADMIN session handing a token to a merchant origin; that is what the role
 * allowlist stops.
 */
function mayIssueCsrfToken(
  req: Request,
  newAccessToken: string,
  presentedRefreshToken: string | undefined
): boolean {
  // (2) Possession proof — only a client that already holds the refresh token
  // could have sent it.
  if (presentedRefreshToken) return true;

  // (1) Platform origins (admin / web / orders apps).
  if (
    isPlatformOrigin(req.headers.origin as string | undefined, {
      webUrl: config.webUrl,
      adminUrl: config.adminUrl,
      nodeEnv: config.nodeEnv,
    })
  ) {
    return true;
  }

  // (3) Ambient-cookie caller on a merchant origin: storefront customers only.
  try {
    const payload = jwt.verify(newAccessToken, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUERS_ACCEPTED,
      audience: JWT_AUDIENCES_ACCEPTED,
    }) as { role?: string };
    return !!payload.role && AMBIENT_CSRF_MINT_ROLES.has(payload.role);
  } catch {
    return false; // fail closed — we just minted this token, so this shouldn't happen
  }
}

// `refreshIpLimiter` runs FIRST and is IP-wide. `refreshLimiter` is partitioned
// by the presented token's (verified) subject, so on its own it has no constant
// per-IP ceiling — and `skipGlobalRateLimit` exempts this route from the global
// mutation cap, so nothing else supplies one.
const refreshGuards = [refreshIpLimiter, refreshLimiter];

// POST /auth/session
// Exchanges an identity-service access token (Authorization: Bearer <ES256>, aud=store) for the Store's HttpOnly `token`
// cookie, after reconciling the Store's profile row from the identity service. The browser calls it after every
// sign-in and every silent refresh (the token lives 15 minutes). No token is accepted from the body or the URL.
router.post(
  '/session',
  refreshIpLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!token || !isAccountsToken(token))
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      const origin = req.headers.origin as string | undefined;
      if (
        origin &&
        !isPlatformOrigin(origin, {
          webUrl: config.webUrl,
          adminUrl: config.adminUrl,
          nodeEnv: config.nodeEnv,
        })
      )
        throw new AppError(403, 'CORS_ORIGIN_NOT_ALLOWED', 'Origin not allowed');
      const { claims } = await authenticateAccounts(token, { allowMissingProfile: true });
      await reconcileShadowUser(claims.sub);
      setTokenCookie(res, token);
      const user = await AuthService.getProfile(claims.sub);
      res.json({ success: true, data: { user, sessionExpiresAt: claims.exp * 1000 } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /auth/refresh
router.post('/refresh', refreshGuards, async (req: Request, res: Response, next: NextFunction) => {
  // Accept the refresh token from the JSON body (Bearer/localStorage
  // clients — the iOS admin PWA) OR the HTTP-only refresh cookie
  // (pure-browser path). Body wins when both are present so an explicit
  // localStorage token isn't shadowed by a stale cookie. Read outside the
  // `try` because the failure path needs to know which one was used.
  const bodyRefreshToken = req.body?.refreshToken as string | undefined;
  const cookieRefreshToken =
    typeof req.cookies?.refresh_token === 'string' ? req.cookies.refresh_token : undefined;

  // Rotate ONE presented token and answer. `presentedInBody` is the body token
  // when the caller supplied it (Bearer/localStorage clients get the pair back
  // in the body), undefined for the ambient-cookie path (Set-Cookie only).
  const rotateAndRespond = async (
    presented: string,
    presentedInBody: string | undefined,
    opts: { staleBodyToken?: boolean } = {}
  ): Promise<void> => {
    // Verify the signature BEFORE hashing + querying Neon (#1801). This route
    // is exempt from the global mutation cap and its per-subject bucket is
    // 120/15min, so without this every unforgeable-but-garbage blob cost an
    // unauthenticated DB round trip. Same code as an unknown token, so the
    // clients' `!res.ok -> rejected` mapping is unchanged. Expiry is left to
    // the DB row (see verifyRefreshJwt).
    if (!verifyRefreshJwt(presented, { ignoreExpiration: true })) {
      throw new AppError(401, 'TOKEN_INVALID', 'Invalid refresh token');
    }

    // Rotation: this returns a NEW access + NEW refresh token and revokes
    // the presented one. Reuse of an already-rotated token throws inside
    // refreshTokens() and revokes the whole family (see AuthService).
    const tokens = await AuthService.refreshTokens(presented);

    // Replace BOTH cookies with the rotated pair (browser path). The
    // refresh cookie MUST be updated — leaving the old one would make the
    // next refresh present the now-rotated token and self-revoke the family.
    //
    // But only when the rotated session is one this browser's cookie already
    // carries, or the caller is a platform origin (issue 2217). A BODY token
    // is caller-supplied: csrfProtection skips /auth/, express.urlencoded is
    // global and every merchant custom domain is CORS-allowlisted with
    // credentials, so a merchant-origin page could auto-submit the
    // ATTACKER's own refresh token and have its rotation Set-Cookie'd
    // (SameSite=None, 365 days) into the victim's browser — silently signing
    // the victim into the attacker's account. A body-lane caller that is not
    // replacing its own cookie gets the pair in the body, which is all a
    // Bearer/localStorage client needs.
    if (
      !presentedInBody ||
      presentedInBody === cookieRefreshToken ||
      isPlatformOrigin(req.headers.origin as string | undefined, {
        webUrl: config.webUrl,
        adminUrl: config.adminUrl,
        nodeEnv: config.nodeEnv,
      })
    ) {
      setSessionCookies(res, tokens.accessToken, tokens.refreshToken);
    }

    // Re-issue the CSRF token alongside the rotated pair.
    //
    // Merchant custom origins are no longer CSRF-exempt (see
    // middleware/security.ts — the exemption let any merchant-controlled
    // domain ride a victim's cookie). Sessions established BEFORE that change
    // hold no csrfToken in localStorage and would start failing every
    // state-changing request. Minting one here means each such session heals
    // on its next silent refresh — the access token is 30 minutes, so the
    // window closes on its own rather than requiring every user to re-login.
    //
    // GATED by `mayIssueCsrfToken`: handing a token to any caller that showed
    // up with nothing but the ambient cookie would let a merchant-controlled
    // page mint one for a session id of its choosing and ride a lured admin's
    // cookie — see the full argument on that function.
    const sessionId = req.headers['x-session-id'] as string | undefined;
    const csrfToken =
      sessionId && mayIssueCsrfToken(req, tokens.accessToken, presentedInBody)
        ? // Bound to the rotated session's owner (decode, not verify — we
          // minted this token microseconds ago) so the issued token is only
          // usable by a request authenticating as that same user.
          await generateCsrfToken(
            sessionId,
            (jwt.decode(tokens.accessToken) as { userId?: string } | null)?.userId
          )
        : undefined;

    // ALSO return the rotated pair in the body for Bearer-token clients (iOS
    // admin PWA) so they can replace their localStorage tokens — but ONLY when
    // the caller presented the refresh token itself. A caller authenticated by
    // nothing but the ambient HTTP-only cookie gets the rotation as Set-Cookie
    // and nothing else.
    //
    // WHY THE ASYMMETRY: CORS runs with credentials:true and allowlists every
    // merchant custom domain by DB lookup, and the session cookies are
    // SameSite=None. Returning the pair unconditionally meant a
    // merchant-controlled page could lure a signed-in super_admin, POST here
    // with the victim's cookie riding along, and READ a 30-minute access JWT
    // plus a 365-day refresh token out of the response — the same read-half
    // takeover `restrictPlatformOnlyOrigins` closes for /admin/impersonate.
    // This route CANNOT join PLATFORM_ONLY_ORIGIN_PATHS: storefront customers
    // legitimately refresh from merchant custom origins. So the boundary is
    // "an ambient-cookie caller never gets to read a token", which costs
    // nothing — a client that needs the pair in the body must already hold a
    // refresh token to have presented one.
    //
    // `refreshed` is the success signal for the cookie path (the frontends'
    // 401-retry helpers key off it instead of accessToken).
    //
    // `staleRefreshToken` (issue 2170): set on the cookie FALLBACK below, where
    // the caller's body token was dead and the cookie session was rotated
    // instead. The caller's stored copy is now a revoked token; presented again
    // past the rotation grace it trips reuse detection and revokes EVERY
    // session of the user. The flag tells the client to drop its stored
    // pair and continue on the cookie. (The pair itself is not returned: this
    // caller authenticated by the ambient cookie.)
    res.json({
      success: true,
      data: presentedInBody
        ? { ...tokens, csrfToken, refreshed: true }
        : {
            csrfToken,
            refreshed: true,
            ...(opts.staleBodyToken ? { staleRefreshToken: true } : {}),
          },
    });
  };

  const refreshToken = bodyRefreshToken || cookieRefreshToken;

  if (!refreshToken) {
    // Session cookies present but no refresh token to present is a dead
    // session, the same fact the 401 branch below heals (#1531): a `token`
    // cookie minted before rotating refresh tokens shipped, or one whose
    // `refresh_token` partner is gone. It would otherwise never reach that
    // branch (this 400 returns first) and, with a 365-day maxAge, keep the
    // cookieless guest branch in csrfProtection from firing for up to a
    // year — a permanent 403 on POST /payments/create. A caller with no
    // session cookie at all gets no Set-Cookie.
    if (req.cookies?.token || req.cookies?.refresh_token) {
      clearSessionCookies(res);
    }
    // 401, not 400 (Ruling FU46-2): "there is no session here" is an authentication answer,
    // and every storefront tab's one evidence-free probe lands here. All three clients already
    // read 401 and 400 identically (web: SESSION_ENDED; admin/orders: `!res.ok`).
    res.status(401).json({
      success: false,
      error: { code: 'NO_REFRESH_TOKEN', message: 'No session to refresh' },
    });
    return;
  }

  try {
    await rotateAndRespond(refreshToken, bodyRefreshToken);
  } catch (firstError) {
    // A refresh that fails on AUTHENTICATION means this browser is holding a
    // session that no longer exists — a revoked family (password change,
    // reuse detection), a deleted account, or natural expiry. The cookies
    // outlive that by design: AUTH_COOKIE_OPTIONS.maxAge is 365 days, and
    // clearSessionCookies otherwise runs only on explicit logout, which the
    // storefront never calls (AuthContext just setUser(null)). So the browser
    // would keep advertising a dead session for up to a year, and on the money
    // path that is fatal: cookies present means the cookieless guest branch in
    // csrfProtection does not fire, the stale localStorage token cannot
    // verify, and this refresh — the only re-mint path — cannot succeed.
    // Permanent 403 on POST /payments/create until the user re-logs in.
    //
    // Clearing here returns them to a genuinely cookieless state, where guest
    // checkout works. Gated on AppError 401 SPECIFICALLY: a transient failure
    // (database unreachable, Redis down) must never sign every user out.
    //
    // And never on the strength of a BODY token alone (#1527). A body token is
    // caller-supplied: `express.urlencoded` is mounted globally and
    // csrfProtection skips /auth/, so a cross-site auto-submitting form posting
    // `refreshToken=garbage` rides the victim's SameSite=None cookies and 401s
    // on the garbage — clearing then would wipe a cookie session that was never
    // tried.
    //
    // But not "only when no body token was sent" either (#1527's first
    // version, reverted after the scoped audit): the iOS
    // WebKit clients (web, admin, orders) persist the refresh token in
    // localStorage and ALWAYS post it in the body, with the cookies alongside.
    // When that session dies, gating the clear on "no body token" kept the dead
    // cookies forever and brought the permanent checkout 403 back for exactly
    // that client class. So a failed BODY token with a DIFFERENT cookie token
    // present retries rotation with the cookie (as an ambient-cookie caller:
    // Set-Cookie only, no tokens in the body): a live cookie session rotates
    // and the request succeeds (garbage in the body cannot wipe it), and the
    // cookies are cleared only when the cookie token ALSO fails on
    // authentication — or when there was no separate cookie token to try.
    //
    // Bound to the SAME principal (issue 1962). The fallback only ever fires
    // when the two tokens differ, i.e. are different sessions by construction:
    //  - a body token that does not even verify (the cross-site
    //    `refreshToken=garbage` form) proved nothing about either session, so
    //    it neither rotates the cookie nor clears it — rotating it used to
    //    desync the iOS client's stored copy into a later family revoke;
    //  - a cookie that belongs to a DIFFERENT user (admin/web/orders share one
    //    API-domain cookie) is not this caller's session to rotate or clear;
    //  - only a cookie whose `sub` matches the body token's is the caller's own
    //    live session, and is rotated;
    //  - a cookie that does not verify at all is dead whoever sent it, and is
    //    cleared as before.
    let error: unknown = firstError;
    let sessionDead = isAuthFailure(firstError);
    if (
      sessionDead &&
      bodyRefreshToken &&
      cookieRefreshToken &&
      cookieRefreshToken !== bodyRefreshToken
    ) {
      const bodyClaims = verifyRefreshJwt(bodyRefreshToken, { ignoreExpiration: true });
      const cookieClaims = verifyRefreshJwt(cookieRefreshToken, { ignoreExpiration: true });
      if (bodyClaims?.sub && cookieClaims?.sub === bodyClaims.sub) {
        try {
          await rotateAndRespond(cookieRefreshToken, undefined, { staleBodyToken: true });
          return;
        } catch (cookieError) {
          error = cookieError;
          sessionDead = isAuthFailure(cookieError);
        }
      } else if (cookieClaims) {
        // Garbage body token, or a cookie of another principal: this request
        // is evidence about neither cookie session — leave it untouched.
        sessionDead = false;
      }
      // (A cookie that does not verify cannot be anyone's session: it is
      // cleared below, keeping #1531's heal for a dead cookie.)
    }
    if (sessionDead) {
      clearSessionCookies(res);
    }
    next(error);
  }
});

/** A refresh that failed on AUTHENTICATION (not a transient fault). */
function isAuthFailure(error: unknown): boolean {
  return error instanceof AppError && error.statusCode === 401;
}

// POST /auth/logout
// Optional-auth: we denylist the access-token jti when a valid Bearer token
// is present, but NEVER 401 the logout itself — clients with an already-expired
// or missing token must still be able to clear their session cookie.
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Read the refresh token from the body OR the cookie so a pure-browser
    // client (which never had the token in JS) still gets it revoked
    // server-side, not just cleared locally.
    const refreshToken =
      (req.body?.refreshToken as string | undefined) ||
      (req.cookies?.refresh_token as string | undefined);

    if (refreshToken) {
      await AuthService.logout(refreshToken);
    }

    // Attempt to extract + denylist the access-token jti.
    // Fail-open: any verification error (expired, missing, malformed) is
    // silently swallowed so the logout always succeeds.
    try {
      const authHeader = req.headers.authorization;
      const cookieToken = req.cookies?.token as string | undefined;
      const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : cookieToken;

      if (rawToken && isAccountsToken(rawToken)) {
        // Identity-service session: end it at the source so every product loses it. Best effort here (the browser's own
        // call to accounts.ebda.app/logout is the primary path); the cookie is cleared below regardless.
        const claims = await verifyAccountsToken(rawToken, { ignoreExpiration: true });
        await revokeIdentitySession(claims.sid, 'logout');
      } else if (rawToken) {
        const payload = jwt.verify(rawToken, config.jwtSecret, {
          algorithms: ['HS256'],
          issuer: JWT_ISSUERS_ACCEPTED,
          audience: JWT_AUDIENCES_ACCEPTED,
        }) as { jti?: string; exp?: number };

        if (payload.jti) {
          const remainingTtl = payload.exp ? payload.exp - Math.floor(Date.now() / 1000) : 60;
          await redis.denyJti(payload.jti, Math.max(1, remainingTtl));
        }
      }
    } catch {
      // token invalid / expired — skip denylist, still clear cookie below
    }

    // Clear BOTH the access cookie and the refresh cookie.
    clearSessionCookies(res);

    res.json({
      success: true,
      data: { message: 'Logged out successfully' },
    });
  } catch (error) {
    next(error);
  }
});

// POST /auth/logout-all
// Bumps tokenVersion so every outstanding access token issued before this
// call is rejected by the auth middleware on next use. Also revokes all
// refresh tokens so session rotation can't re-issue new access tokens.
router.post(
  '/logout-all',
  authenticate,
  rejectAdminOnMerchantOrigin,
  rejectImpersonated,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await AuthService.revokeAllSessions(req.user!.userId, 'revoke_all', {
        storeId: req.user!.storeId,
      });
      clearSessionCookies(res);
      res.json({
        success: true,
        data: { message: 'All sessions revoked' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /auth/me
router.get(
  '/me',
  authenticate,
  rejectAdminOnMerchantOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await AuthService.getProfile(req.user!.userId, { storeId: req.user!.storeId });

      res.json({
        success: true,
        data: { user },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /auth/me - Soft-delete (deactivate) the authenticated user's account
// `rejectImpersonated`: deactivating the account is irreversible from the
// user's side, so it belongs with /me/erase, /change-password and /logout-all.
// It was the one destructive route the original guard rollout missed.
router.delete(
  '/me',
  authenticate,
  rejectAdminOnMerchantOrigin,
  rejectImpersonated,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;

      // An identity-service account is deactivated THERE first (every session and refresh dies, sign-in is refused); if that
      // fails nothing has changed and the request fails.
      if (req.user!.role !== 'customer' && (await isIdentityManagedUser(userId)))
        await setAccountStatus(userId, 'inactive', 'self-delete');

      // N-9: a customer served by the StoreDO is deactivated there (soft-delete + immediate revocation in one section).
      const delRoute = await customerAuthRoute(req.user!.storeId, { write: true });
      if (delRoute.kind === 'do') {
        // one DO section + a cache push that must land (a swallowed Redis failure left the access token alive: review 8a)
        const { phone } = await AuthService.softDeleteCustomer(userId, delRoute.client.storeId);
        await revokeForAccount(delRoute.client.storeId, userId, phone);
        await auditLog({
          action: 'user.account.deleted',
          userId,
          resourceType: 'user',
          resourceId: userId,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        clearSessionCookies(res);
        res.json({ success: true, data: { message: 'Account deleted successfully' } });
        return;
      }

      // Soft-delete: set deletedAt timestamp so data is preserved but account is deactivated
      const before = await withUser(userId, tx =>
        tx.user.findUnique({ where: { id: userId }, select: { storeId: true, phone: true } })
      );
      await withUser(userId, tx =>
        tx.user.update({
          where: { id: userId },
          data: { deletedAt: new Date() },
        })
      );
      // WA-CONSENT-1: a deactivated account must stop receiving WhatsApp marketing NOW, not when the
      // retention cron finally erases it.
      if (before?.storeId) await revokeForAccount(before.storeId, userId, before.phone);

      // Audit log
      await auditLog({
        action: 'user.account.deleted',
        userId,
        resourceType: 'user',
        resourceId: userId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { message: 'Account deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /auth/me/erase — irreversible PII anonymization (GDPR Art. 17 and
// applicable GCC data-protection law — see docs/privacy/data-map.md).
// Unlike DELETE /auth/me (soft-delete that
// leaves PII intact), this nulls/scrubs every identifying field across
// the schema in a single transaction and preserves anonymized order
// records for Egypt MOF ≥5y tax retention. No request body — possession
// of a valid auth token is the confirmation.
router.post(
  '/me/erase',
  authLimiter,
  authenticate,
  rejectAdminOnMerchantOrigin,
  rejectImpersonated,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;

      // The shopper's OWN erasure spans every store (Ruling W-7).
      const outcome = await AuthService.eraseAccount(userId, {
        actorId: userId,
        storeHint: req.user!.storeId,
      });

      // #1880: record what the merchant-CRM scrub did, so a self-service
      // erasure that left the CRM copy behind is queryable in the audit log.
      // Not surfaced to the shopper — the merchant CRM is the store's record,
      // and the shopper cannot act on it.
      await auditLog({
        action: 'user.account.erased',
        userId,
        resourceType: 'user',
        resourceId: userId,
        details: { ...outcome, crmReviewNeeded: eraseNeedsCrmReview(outcome) },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Best-effort clear both auth cookies. The access token itself is
      // already dead: eraseAccount bumps tokenVersion and pushes it into the
      // tv cache the authenticate middleware reads first (#1871).
      clearSessionCookies(res);

      res.json({
        success: true,
        data: { message: 'Account data erased' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /auth/me/export — right to data portability (GDPR Art. 20 and
// applicable GCC data-protection law — see docs/privacy/data-map.md).
// Returns a JSON bundle of every row tied to this
// user. Marked as an attachment so browsers download it as a file.
//
// NOT guarded by rejectImpersonated (Ruling IMP-1, docs/RULINGS.md): an
// impersonating admin downloading the victim's full PII bundle is read-only
// and was deliberately left unguarded pending a separate decision on whether
// to block it outright. What ships here is the minimum that doesn't require
// that decision: `impersonatedBy` is written into the audit row whenever the
// session is impersonated, so the download is at least ATTRIBUTABLE rather
// than indistinguishable from the account owner's own export.
router.get(
  '/me/export',
  authenticate,
  rejectAdminOnMerchantOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const bundle = await AuthService.exportAccount(userId, req.user!.storeId);

      await auditLog({
        action: 'user.data.exported',
        userId,
        resourceType: 'user',
        resourceId: userId,
        details: req.user!.impersonatedBy
          ? { impersonatedBy: req.user!.impersonatedBy }
          : undefined,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const today = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="my-data-${userId}-${today}.json"`
      );
      res.send(JSON.stringify(bundle, null, 2));
    } catch (error) {
      next(error);
    }
  }
);

// PUT /auth/me - Update profile
router.put(
  '/me',
  authenticate,
  rejectAdminOnMerchantOrigin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updateSchema = z.object({
        // ProfileClient.tsx always sends firstName from the form — even when
        // the user clears the field it sends ''. Coerce '' → undefined so that
        // a deliberate clear is treated as "don't update" rather than a 400.
        firstName: z.preprocess(
          v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
          z.string().min(1, 'First name is required').optional()
        ),
        lastName: z.string().optional(),
        phone: z.string().optional(),
      });

      const data = updateSchema.parse(req.body);
      const user = await AuthService.updateProfile(req.user!.userId, data, {
        storeId: req.user!.storeId,
      });

      res.json({
        success: true,
        data: { user },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /auth/change-password
router.post(
  '/change-password',
  authIpFailureLimiter,
  authLimiter,
  authenticate,
  rejectIdentityManaged,
  rejectAdminOnMerchantOrigin,
  rejectImpersonated,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const changePasswordSchema = z.object({
        currentPassword: z.string().min(1, 'Current password is required'),
        newPassword: z
          .string()
          .min(8, 'Password must be at least 8 characters')
          .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
          .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
          .regex(/[0-9]/, 'Password must contain at least one number')
          .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
      });

      const data = changePasswordSchema.parse(req.body);
      await AuthService.changePassword(req.user!.userId, data.currentPassword, data.newPassword, {
        storeId: req.user!.storeId,
      });

      res.json({
        success: true,
        data: { message: 'Password changed successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /auth/forgot-password
router.post(
  '/forgot-password',
  authIpAllLimiter,
  authLimiter,
  // S5-3: a dedicated, tighter, email-scoped budget stacked in front of
  // authLimiter — see resetEmailLimiter's docstring in middleware/security.ts.
  // issue 2228: plus an address-wide ceiling, so spraying store ids cannot
  // multiply the mails one inbox receives.
  authEmailAddressLimiter,
  resetEmailLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    // Ruling B1-13: no account mail from the demo showroom (its storeId is refused outright;
    // the answer does not depend on the email, so it reveals nothing about any account).
    try {
      const demoScope = (req.body ?? {}).storeId;
      if (typeof demoScope === 'string') await assertNotDemoStore(demoScope);
    } catch (error) {
      // Only the demo refusal itself is a 403. Any other failure of the guard (a store lookup
      // that errors) answers like every other failure on this route: the generic 200 below
      // (enumeration defence), never a 500 that differs by storeId (T9 review minor).
      if (error instanceof AppError && error.code === 'DEMO_STORE') {
        next(error);
        return;
      }
      res.json({
        success: true,
        data: { message: 'If an account exists with this email, a reset link has been sent.' },
      });
      return;
    }
    try {
      const { email, storeId } = req.body ?? {};

      if (!email) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Email is required' },
        });
        return;
      }

      // P1-1 — this route (and /resend-verification below) were the only two
      // on this router that reached `AuthService` with an UNVALIDATED body;
      // register/login two hundred lines above are Zod-parsed. `email` lands at
      // the top level of a Prisma `where`, which accepts a StringFilter object,
      // so `{"email":{"not":"zzz"}}` matched a REAL user and mailed them a real
      // reset link — an enumeration/abuse oracle straight through the
      // enumeration defences this endpoint is built on.
      //
      // FM-5: the parse must NOT change the response shape. The always-200 IS
      // the enumeration defence, so a failed parse falls through to the SAME
      // generic 200 an unknown-but-valid email gets — never a 400 that would
      // re-open the oracle from the other side. `{}`/empty still 400s above,
      // byte-identical to today.
      const parsed = emailLookupSchema.safeParse({ email });
      if (parsed.success) {
        // Always return success to prevent email enumeration
        const scope =
          typeof storeId === 'string' ? storeId : ((await resolvePublicStoreId(req)) ?? null);
        const found = await AuthService.requestPasswordReset(parsed.data.email, scope);
        // Audit only when a link was actually issued: the row is internal (the
        // response below is identical either way), and logging every probe for
        // an unknown address would turn the audit trail into a spray log. The
        // address is masked; the user id is what an investigation joins on.
        if (found) {
          await auditLog({
            action: 'auth.password_reset.requested',
            userId: found.userId,
            resourceType: 'user',
            resourceId: found.userId,
            ...(scope ? { storeId: scope } : {}),
            details: { email: maskEmail(parsed.data.email) },
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          });
        }
      }

      res.json({
        success: true,
        data: { message: 'If an account exists with this email, a reset link has been sent.' },
      });
    } catch {
      // Still return success to prevent enumeration
      res.json({
        success: true,
        data: { message: 'If an account exists with this email, a reset link has been sent.' },
      });
    }
  }
);

// POST /auth/reset-password
router.post(
  '/reset-password',
  authIpFailureLimiter,
  authLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, password } = req.body ?? {};

      if (!token || !password) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Token and password are required' },
        });
        return;
      }

      // Same password policy as signup (merchant-signup.service passwordSchema:
      // 8-128 chars, upper, lower, digit, symbol), so a reset can never set a
      // password the signup form would have refused.
      if (typeof password !== 'string' || !passwordSchema.safeParse(password).success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'Password must be at least 8 characters with uppercase, lowercase, number, and special character',
          },
        });
        return;
      }

      // A reset token is 32 random bytes as 64 lowercase hex chars, with `<storeId>~` in front for a StoreDO store (N-9). Anything else
      // (an object, an array, a truncated paste) is answered exactly like an
      // unknown token, never as a distinct error and never as a 500.
      if (
        typeof token !== 'string' ||
        !/^([A-Za-z0-9][A-Za-z0-9._:-]{0,127}~)?[0-9a-f]{64}$/.test(token)
      ) {
        throw new AppError(400, 'TOKEN_INVALID', 'Invalid or expired reset token');
      }

      const { userId } = await AuthService.resetPassword(token, password);

      await auditLog({
        action: 'auth.password_reset.completed',
        userId,
        resourceType: 'user',
        resourceId: userId,
        details: { sessionsRevoked: true },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { message: 'Password reset successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /auth/verify-email
// S5-4 (2026-09-22 security audit): every other unauthenticated auth lookup
// route on this router (login, register, forgot-password, reset-password,
// resend-verification) sits behind authLimiter; this one didn't. The token
// is 256-bit and hashed, so brute force is infeasible — this closes a
// consistency gap, not a practical attack.
//
// #1863: authLimiter's key is `<ip>-<email || 'unknown'>`, and this route's
// body carries no email, so it fell into the SAME bucket as /reset-password
// — a real availability problem on a multi-tenant signup funnel that
// authLimiter's guessing-surface budget was never sized for. verifyEmailLimiter
// gives it its own, larger, un-pooled budget (see its docstring).
router.post(
  '/verify-email',
  verifyEmailLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // BE:S-16: a non-string token (object / number / array) reached `verifyEmail` and answered 500. It is a 400 now.
      const token: unknown = req.body?.token;

      if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Verification token is required' },
        });
        return;
      }

      const result = await AuthService.verifyEmail(token);

      // Audit log
      await auditLog({
        action: 'user.email.verified',
        resourceType: 'user',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /auth/resend-verification
router.post(
  '/resend-verification',
  authIpAllLimiter,
  authLimiter,
  // issue 2228: the same per-inbox ceiling as /forgot-password — this route
  // also takes a caller-supplied storeId and sends one mail per account.
  authEmailAddressLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    // Ruling B1-13: no account mail from the demo showroom (its storeId is refused outright;
    // the answer does not depend on the email, so it reveals nothing about any account).
    try {
      const demoScope = (req.body ?? {}).storeId;
      if (typeof demoScope === 'string') await assertNotDemoStore(demoScope);
    } catch (error) {
      // Only the demo refusal itself is a 403. Any other guard failure answers the generic 200
      // (enumeration defence), as on /forgot-password, never a 500 that differs by storeId.
      if (error instanceof AppError && error.code === 'DEMO_STORE') {
        next(error);
        return;
      }
      res.json({ success: true, data: { ...GENERIC_RESEND_VERIFICATION_RESULT } });
      return;
    }
    try {
      const { email, storeId } = req.body ?? {};

      if (!email) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Email is required' },
        });
        return;
      }

      // P1-1 (see POST /forgot-password above for the whole story). FM-5: a
      // failed parse returns the BYTE-IDENTICAL body an unknown-but-valid email
      // gets — `GENERIC_RESEND_VERIFICATION_RESULT`, the service's own no-such-user
      // answer — so a filter object is indistinguishable from a miss.
      const parsed = emailLookupSchema.safeParse({ email });
      const result = parsed.success
        ? await AuthService.resendVerificationEmail(
            parsed.data.email,
            typeof storeId === 'string' ? storeId : ((await resolvePublicStoreId(req)) ?? null)
          )
        : { ...GENERIC_RESEND_VERIFICATION_RESULT };

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
