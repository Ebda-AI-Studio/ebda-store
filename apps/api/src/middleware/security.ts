import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@force/database';
import { redis } from '../services/redis.service';

// ==========================================
// CSRF Protection with Redis + In-Memory Fallback
// ==========================================

// In-memory fallback when Redis is unavailable
const MAX_CSRF_TOKENS = 10000;
const csrfTokensMemory = new Map<string, { token: string; expiresAt: Date }>();

// Periodic cleanup of expired CSRF tokens
setInterval(
  () => {
    const now = new Date();
    for (const [key, value] of csrfTokensMemory) {
      if (value.expiresAt < now) csrfTokensMemory.delete(key);
    }
  },
  5 * 60 * 1000
); // Every 5 minutes

export async function generateCsrfToken(sessionId: string): Promise<string> {
  const token = uuidv4();
  const ttlSeconds = 3600; // 1 hour

  // Try Redis first
  if (redis.isAvailable()) {
    await redis.setCsrfToken(sessionId, token, ttlSeconds);
  } else {
    // Fallback to in-memory with size limit
    if (csrfTokensMemory.size >= MAX_CSRF_TOKENS) {
      // Evict oldest entries
      const iterator = csrfTokensMemory.keys();
      for (let i = 0; i < 1000; i++) {
        const key = iterator.next().value;
        if (key) csrfTokensMemory.delete(key);
      }
    }
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    csrfTokensMemory.set(sessionId, { token, expiresAt });
  }

  return token;
}

async function verifyCsrfToken(sessionId: string, token: string): Promise<boolean> {
  // Try Redis first
  if (redis.isAvailable()) {
    const storedToken = await redis.getCsrfToken(sessionId);
    return storedToken === token;
  }

  // Fallback to in-memory
  const stored = csrfTokensMemory.get(sessionId);
  if (!stored) return false;

  // Clean up expired tokens
  if (stored.expiresAt < new Date()) {
    csrfTokensMemory.delete(sessionId);
    return false;
  }

  return stored.token === token;
}

export async function deleteCsrfToken(sessionId: string): Promise<void> {
  if (redis.isAvailable()) {
    await redis.deleteCsrfToken(sessionId);
  } else {
    csrfTokensMemory.delete(sessionId);
  }
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  // Skip for safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Skip for webhook routes (they use signature verification)
  if (req.path.includes('/webhooks/')) {
    return next();
  }

  const sessionId = req.headers['x-session-id'] as string;
  const csrfToken = req.headers['x-csrf-token'] as string;

  // Require session ID for state-changing requests
  if (!sessionId) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'CSRF_MISSING_SESSION',
        message: 'Session ID required for state-changing requests',
      },
    });
  }

  // For authenticated routes, verify CSRF token asynchronously
  if (req.headers.authorization) {
    verifyCsrfToken(sessionId, csrfToken)
      .then(valid => {
        if (!valid) {
          res.status(403).json({
            success: false,
            error: { code: 'CSRF_INVALID', message: 'Invalid CSRF token' },
          });
          return;
        }
        next();
      })
      .catch(() => {
        // Fail closed - reject request on CSRF verification error
        res.status(403).json({
          success: false,
          error: { code: 'CSRF_ERROR', message: 'CSRF validation failed' },
        });
      });
    return;
  }

  next();
}

// ==========================================
// Rate Limiting (per-route)
// ==========================================

// Strict limiter for auth endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many login attempts, please try again later.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    // Use IP + email for more granular limiting
    const email = req.body?.email || 'unknown';
    return `${req.ip}-${email}`;
  },
});

// Limiter for password reset
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 attempts per hour
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many password reset requests, please try again later.',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiter for API writes (orders, payments)
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 writes per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for payment operations
export const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 payment attempts per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many payment attempts, please wait.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// File upload limiter - more restrictive
export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 uploads per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many upload requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    // Limit per user, not per IP
    return req.user?.userId || req.ip || 'anonymous';
  },
});

// Daily upload limit per user
export const dailyUploadLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 500, // 500 uploads per day per user
  message: {
    success: false,
    error: { code: 'DAILY_LIMIT', message: 'Daily upload limit reached. Try again tomorrow.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    return req.user?.userId || req.ip || 'anonymous';
  },
});

// Public API rate limiter - protect public endpoints from abuse
export const publicLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute per IP
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Store resolver rate limiter - stricter for domain resolution
export const storeResolveLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many store resolution requests.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Cart rate limiter - prevent cart bombing
export const cartLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 cart operations per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many cart operations, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    // Use session ID if available, otherwise IP
    const sessionId = req.headers['x-session-id'] as string;
    return sessionId || req.ip || 'anonymous';
  },
});

// ==========================================
// Audit Logging
// ==========================================

export interface AuditLogEntry {
  action: string;
  userId?: string;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, string | number | boolean | null>;
  ip?: string;
  userAgent?: string;
}

export async function auditLog(entry: AuditLogEntry) {
  try {
    // Log to console in development
    if (process.env.NODE_ENV !== 'production') {
      console.log('[AUDIT]', JSON.stringify(entry, null, 2));
    }

    // Store in database
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        userId: entry.userId,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        details: entry.details ? JSON.parse(JSON.stringify(entry.details)) : {},
        ipAddress: entry.ip,
        userAgent: entry.userAgent,
      },
    });
  } catch (error) {
    // Don't fail the request if audit logging fails
    console.error('[AUDIT ERROR]', error);
  }
}

export function auditMiddleware(action: string, resourceType: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const resourceId = req.params.id || req.params.orderId || req.body?.id;

    await auditLog({
      action,
      userId: req.user?.userId,
      resourceType,
      resourceId,
      details: {
        method: req.method,
        path: req.path,
        queryString: Object.keys(req.query).length > 0 ? JSON.stringify(req.query) : null,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    next();
  };
}

// ==========================================
// Input Sanitization
// ==========================================

export function sanitizeInput(req: Request, _res: Response, next: NextFunction) {
  // Recursively sanitize strings in body
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }

  // Sanitize query params
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeObject(req.query) as typeof req.query;
  }

  next();
}

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      // Remove potential XSS vectors - strip all HTML tags and dangerous patterns
      sanitized[key] = value
        .replace(/<[^>]*>/g, '')
        .replace(/javascript\s*:/gi, '')
        .replace(/on\w+\s*=/gi, '')
        .replace(/data\s*:/gi, '')
        .replace(/&#/g, '&amp;#')
        .replace(/\\u/g, '\\\\u')
        .trim();
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(item =>
        typeof item === 'object' && item !== null
          ? sanitizeObject(item as Record<string, unknown>)
          : typeof item === 'string'
            ? item
                .replace(/<[^>]*>/g, '')
                .replace(/javascript\s*:/gi, '')
                .replace(/on\w+\s*=/gi, '')
                .trim()
            : item
      );
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeObject(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// ==========================================
// Security Headers Enhancement
// ==========================================

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  // HSTS - Strict Transport Security (1 year, include subdomains, preload ready)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Additional security headers beyond helmet
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

  // Content Security Policy
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://www.googletagmanager.com https://connect.facebook.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https: blob:",
      "connect-src 'self' https://api.anthropic.com https://*.supabase.co wss://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

  // Remove server identification
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');

  // Prevent MIME type sniffing
  res.setHeader('X-Download-Options', 'noopen');

  // Cross-Origin policies
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  next();
}

// ==========================================
// Request ID for tracing
// ==========================================

export function requestId(req: Request, res: Response, next: NextFunction) {
  const clientId = req.headers['x-request-id'] as string;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const id = clientId && uuidRegex.test(clientId) ? clientId : uuidv4();
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-Id', id);
  next();
}
