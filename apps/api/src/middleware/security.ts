import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@force/database';
import { redis } from '../services/redis.service';

// ==========================================
// CSRF Protection with Redis + In-Memory Fallback
// ==========================================

// In-memory fallback when Redis is unavailable
const csrfTokensMemory = new Map<string, { token: string; expiresAt: Date }>();

export async function generateCsrfToken(sessionId: string): Promise<string> {
  const token = uuidv4();
  const ttlSeconds = 3600; // 1 hour

  // Try Redis first
  if (redis.isAvailable()) {
    await redis.setCsrfToken(sessionId, token, ttlSeconds);
  } else {
    // Fallback to in-memory
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

  // If no session, skip CSRF (will fail auth later anyway for protected routes)
  if (!sessionId) {
    return next();
  }

  // For authenticated routes, verify CSRF token asynchronously
  if (req.headers.authorization) {
    verifyCsrfToken(sessionId, csrfToken)
      .then((valid) => {
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
        // On error, allow request (fail open for availability)
        next();
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
    error: { code: 'RATE_LIMITED', message: 'Too many login attempts, please try again later.' }
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
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
    error: { code: 'RATE_LIMITED', message: 'Too many password reset requests, please try again later.' }
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
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' }
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
    error: { code: 'RATE_LIMITED', message: 'Too many payment attempts, please wait.' }
  },
  standardHeaders: true,
  legacyHeaders: false,
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
      // Remove potential XSS vectors
      sanitized[key] = value
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+=/gi, '')
        .trim();
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(item =>
        typeof item === 'object' && item !== null
          ? sanitizeObject(item as Record<string, unknown>)
          : typeof item === 'string'
            ? item.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '').trim()
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
  // Additional security headers beyond helmet
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // Remove server identification
  res.removeHeader('X-Powered-By');

  next();
}

// ==========================================
// Request ID for tracing
// ==========================================

export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = req.headers['x-request-id'] as string || uuidv4();
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-Id', id);
  next();
}
