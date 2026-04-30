import { Router, Request, Response, NextFunction, CookieOptions } from 'express';
import { z } from 'zod';
import { prisma } from '@force/database';
import { config } from '../config';
import { authenticate } from '../middleware/auth';
import { AuthService } from '../services/auth.service';
import { authLimiter, auditLog, generateCsrfToken } from '../middleware/security';

const router = Router();

/** Shared cookie options for the HTTP-only auth token cookie. The 30-day
 *  maxAge mirrors the access-token JWT lifetime in config.ts — a phone
 *  PWA user opening the admin once a month stays signed in seamlessly,
 *  and refresh-token rotation (1 year) covers longer gaps. */
const AUTH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: config.nodeEnv === 'production',
  sameSite: config.nodeEnv === 'production' ? 'none' : 'lax', // 'none' required for cross-origin cookies
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — matches jwtExpiresIn
  path: '/',
};

/** Set the access token as an HTTP-only cookie on the response */
function setTokenCookie(res: Response, accessToken: string): void {
  res.cookie('token', accessToken, AUTH_COOKIE_OPTIONS);
}

/** Clear the auth token cookie on the response */
function clearTokenCookie(res: Response): void {
  res.clearCookie('token', { path: '/' });
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
 *       201:
 *         description: User registered successfully
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
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       409:
 *         description: Email already exists
 */
router.post('/register', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = registerSchema.parse(req.body);
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
});

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
router.post('/login', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = loginSchema.parse(req.body);
    const result = await AuthService.login(data.email, data.password, req.ip, data.storeId ?? null);

    // Generate CSRF token for session
    const sessionId = req.headers['x-session-id'] as string;
    let csrfToken: string | undefined;
    if (sessionId) {
      csrfToken = await generateCsrfToken(sessionId);
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

    // Set access token as HTTP-only cookie for cookie-based auth.
    setTokenCookie(res, result.accessToken);

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

// POST /auth/refresh
router.post('/refresh', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Refresh token is required' },
      });
      return;
    }

    const tokens = await AuthService.refreshTokens(refreshToken);

    // Update the HTTP-only cookie with the new access token (browser path).
    setTokenCookie(res, tokens.accessToken);

    // ALSO return it in the body for Bearer-token clients (iOS admin PWA)
    // so they can replace their localStorage token. Same reasoning as
    // login/register — the API supports both auth modes.
    res.json({
      success: true,
      data: tokens,
    });
  } catch (error) {
    next(error);
  }
});

// POST /auth/logout
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await AuthService.logout(refreshToken);
    }

    // Clear the HTTP-only auth cookie
    clearTokenCookie(res);

    res.json({
      success: true,
      data: { message: 'Logged out successfully' },
    });
  } catch (error) {
    next(error);
  }
});

// GET /auth/me
router.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await AuthService.getProfile(req.user!.userId);

    res.json({
      success: true,
      data: { user },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /auth/me - Soft-delete (deactivate) the authenticated user's account
router.delete('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    // Soft-delete: set deletedAt timestamp so data is preserved but account is deactivated
    await prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });

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
});

// PUT /auth/me - Update profile
router.put('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updateSchema = z.object({
      firstName: z.string().min(1, 'First name is required').optional(),
      lastName: z.string().optional(),
      phone: z.string().optional(),
    });

    const data = updateSchema.parse(req.body);
    const user = await AuthService.updateProfile(req.user!.userId, data);

    res.json({
      success: true,
      data: { user },
    });
  } catch (error) {
    next(error);
  }
});

// POST /auth/change-password
router.post(
  '/change-password',
  authLimiter,
  authenticate,
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
      await AuthService.changePassword(req.user!.userId, data.currentPassword, data.newPassword);

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
  authLimiter,
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const { email, storeId } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Email is required' },
        });
        return;
      }

      // Always return success to prevent email enumeration
      await AuthService.requestPasswordReset(email, typeof storeId === 'string' ? storeId : null);

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
  authLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, password } = req.body;

      if (!token || !password) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Token and password are required' },
        });
        return;
      }

      if (
        password.length < 8 ||
        !/[A-Z]/.test(password) ||
        !/[a-z]/.test(password) ||
        !/[0-9]/.test(password) ||
        !/[^A-Za-z0-9]/.test(password)
      ) {
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

      await AuthService.resetPassword(token, password);

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
router.post('/verify-email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.body;

    if (!token) {
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
});

// POST /auth/resend-verification
router.post(
  '/resend-verification',
  authLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, storeId } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Email is required' },
        });
        return;
      }

      const result = await AuthService.resendVerificationEmail(
        email,
        typeof storeId === 'string' ? storeId : null
      );

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
