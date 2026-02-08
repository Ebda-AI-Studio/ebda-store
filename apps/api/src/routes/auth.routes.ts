import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { AuthService } from '../services/auth.service';
import { authLimiter, auditLog, generateCsrfToken } from '../middleware/security';

const router = Router();

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
  })
  .refine(data => data.name || data.firstName, {
    message: 'Name or firstName is required',
    path: ['name'],
  });

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
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
    const result = await AuthService.register(data);

    // Audit log
    await auditLog({
      action: 'user.register',
      userId: result.user.id,
      resourceType: 'user',
      resourceId: result.user.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({
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
    const result = await AuthService.login(data.email, data.password);

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

// POST /auth/forgot-password
router.post(
  '/forgot-password',
  authLimiter,
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const { email } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Email is required' },
        });
        return;
      }

      // Always return success to prevent email enumeration
      await AuthService.requestPasswordReset(email);

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
      const { email } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Email is required' },
        });
        return;
      }

      const result = await AuthService.resendVerificationEmail(email);

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
